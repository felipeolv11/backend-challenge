/**
 * Teste de carga: bun run test:load   (precisa de `bun run infra:up` antes)
 *
 * DECISÃO: script próprio em Bun, sem ferramenta externa.
 * POR QUÊ: zero dependência; mede a latência de cada requisição (p50/p95/p99 calculados direto);
 *          testa também a FILA (SQS), que ferramentas de carga HTTP não testam; lê o /metrics
 *          durante a carga (conflitos, outbox lag); e no fim confere saldo = ledger.
 * ALTERNATIVA: k6 ou autocannon — não usei porque o k6 é um binário externo (o avaliador teria que
 *              instalar), o autocannon é mais uma dependência, e nenhum dos dois testa a fila.
 *
 * Metodologia (detalhada no LOAD-TEST.md):
 * - 3 instâncias reais da aplicação (processos separados), banco próprio (wagering_load) e filas
 *   próprias, todos recriados do zero.
 * - Carga em "loop fechado": N usuários virtuais, cada um manda uma requisição, espera a resposta e
 *   manda a próxima, durante X segundos, alternando entre as 3 instâncias.
 * - Cenários: (1) distribuído (muitas wallets), (2) hot wallet (todos na mesma wallet),
 *   (3) fila (milhares de mensagens no SQS, consumidas pelas 3 instâncias).
 * - Um "consumidor de eventos" lê e apaga a fila de eventos durante todo o teste, como faria um
 *   sistema real. Sem ele, a fila de eventos cresce sem parar, e no MiniStack o custo de enviar
 *   cresce com o tamanho da fila (medido: 3,6 ms → 38 ms por lote de 0 a 40 mil mensagens), o que
 *   mediria o emulador, e não a aplicação.
 */
import { cpus, totalmem, release, platform } from 'node:os';
import { DeleteMessageBatchCommand, ReceiveMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { setupQueues } from '../../src/infrastructure/sqs/setup-queues';
import { type Instance, killInstance, startInstance } from '../support/instances';
import { testSqsClient } from '../support/sqs';
import { createTestOrm, testDatabaseUrl } from '../support/test-database';

const config = {
  instances: 3,
  virtualUsers: 50,
  distributed: { wallets: 500, durationSeconds: 20 },
  hotWallet: { durationSeconds: 15 },
  queue: { wallets: 200, messages: 3_000 },
  warmupSeconds: 3,
};

// Opções de diagnóstico (opcionais):
//   LOAD_SCENARIOS=distributed,hot,queue   roda só os cenários escolhidos (padrão: todos)
//   LOAD_OUTBOX_PUBLISHER=false            desliga o publisher da outbox nas instâncias, para medir
//                                          o consumidor da fila isoladamente
const scenarios = new Set((process.env.LOAD_SCENARIOS ?? 'distributed,hot,queue').split(','));
const outboxPublisherEnabled = process.env.LOAD_OUTBOX_PUBLISHER !== 'false';

const DATABASE = 'wagering_load';
const orm = await createTestOrm(DATABASE);
const sqs = testSqsClient();
const suffix = `load-${Date.now()}`;
const queueNames = { wagerQueue: `wager-${suffix}.fifo`, wagerDeadLetterQueue: `wager-dlq-${suffix}.fifo`, eventsQueue: `events-${suffix}.fifo` };
const queues = await setupQueues(sqs, queueNames);

console.log(`Subindo ${config.instances} instâncias...`);
const instances: Instance[] = await Promise.all(
  Array.from({ length: config.instances }, (_, i) =>
    startInstance(`load-${i}`, 3_201 + i, {
      DATABASE_URL: testDatabaseUrl(DATABASE),
      WAGER_QUEUE_NAME: queueNames.wagerQueue,
      WAGER_DLQ_NAME: queueNames.wagerDeadLetterQueue,
      EVENTS_QUEUE_NAME: queueNames.eventsQueue,
      CONSUMER_WAIT_TIME_SECONDS: '1',
      ENABLE_OUTBOX_PUBLISHER: String(outboxPublisherEnabled),
    }),
  ),
);

// ------------------------------------------------------------------ consumidor da fila de eventos

/** Lê e apaga a fila de eventos continuamente (como um sistema que consome os eventos). */
function startEventSink() {
  const eventIds = new Set<string>();
  let received = 0;
  let running = true;
  const worker = async () => {
    while (running) {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: queues.eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
      );
      if (Messages.length === 0) continue;
      received += Messages.length;
      for (const message of Messages) eventIds.add((JSON.parse(message.Body!) as { eventId: string }).eventId);
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queues.eventsQueueUrl,
          Entries: Messages.map((message, i) => ({ Id: String(i), ReceiptHandle: message.ReceiptHandle! })),
        }),
      );
    }
  };
  // Vários leitores em paralelo: a fila FIFO entrega grupos (wallets) diferentes para cada um.
  const workers = Array.from({ length: 4 }, worker);
  return {
    stats: () => ({ received, distinctEventIds: eventIds.size }),
    stop: async () => {
      running = false;
      await Promise.all(workers);
    },
  };
}

const eventSink = startEventSink();

// ------------------------------------------------------------------ helpers

interface HttpResult {
  status: number; // 0 = erro de rede
  latencyMs: number;
}

interface ScenarioReport {
  name: string;
  durationSeconds: number;
  requests: number;
  throughputPerSecond: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  statusCounts: Record<string, number>;
  errorRate: number;
  businessRejections: number;
  lockConflicts: Record<string, number>;
  maxOutboxLagSeconds: number;
  maxOutboxPending: number;
  outboxDrainSeconds: number;
  consistent: boolean;
  notes: string[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]! * 10) / 10;
}

function latencySummary(latencies: number[]) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: percentile(sorted, 100) };
}

async function createWallets(count: number, amount: string) {
  const wallets: Array<{ id: string; playerId: string }> = [];
  for (let i = 0; i < count; i += 50) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(50, count - i) }, async (_, j) => {
        const playerId = Bun.randomUUIDv7();
        const response = await fetch(`${instances[(i + j) % instances.length]!.url}/wallets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
        });
        return { id: ((await response.json()) as { id: string }).id, playerId };
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

let sequence = 0;
function betBody(wallet: { id: string; playerId: string }, prefix = 'load') {
  const externalTransactionId = `${prefix}-${++sequence}`;
  return {
    providerId: 'provider-load',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${sequence % 100}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  };
}

async function submit(instance: Instance, body: ReturnType<typeof betBody>): Promise<HttpResult> {
  const started = performance.now();
  try {
    const response = await fetch(`${instance.url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}` },
      body: JSON.stringify(body),
    });
    await response.arrayBuffer();
    return { status: response.status, latencyMs: performance.now() - started };
  } catch {
    return { status: 0, latencyMs: performance.now() - started };
  }
}

/** Lê o /metrics de todas as instâncias e soma as linhas que casam com o padrão. */
async function sumMetric(pattern: RegExp): Promise<number> {
  const texts = await Promise.all(instances.map(async (i) => (await fetch(`${i.url}/metrics`)).text()));
  return texts
    .flatMap((text) => text.split('\n'))
    .filter((line) => pattern.test(line))
    .reduce((sum, line) => sum + Number(line.split(' ').pop()), 0);
}

async function lockConflicts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const type of ['lock_timeout', 'deadlock', 'version_conflict', 'duplicate_key']) {
    result[type] = await sumMetric(new RegExp(`^wagering_lock_conflicts_total\\{type="${type}"\\}`));
  }
  return result;
}

/** Amostra outbox lag e pendentes a cada 500ms enquanto a carga roda. O lag é global (mesmo banco). */
function startOutboxSampler() {
  let maxLag = 0;
  let maxPending = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      const text = await (await fetch(`${instances[0]!.url}/metrics`)).text();
      const lag = Number(/^wagering_outbox_lag_seconds (\S+)/m.exec(text)?.[1] ?? 0);
      const pending = Number(/^wagering_outbox_pending_events (\S+)/m.exec(text)?.[1] ?? 0);
      maxLag = Math.max(maxLag, lag);
      maxPending = Math.max(maxPending, pending);
      await Bun.sleep(500);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { maxLag: Math.round(maxLag * 100) / 100, maxPending };
    },
  };
}

/** Espera a outbox esvaziar (todos os eventos publicados) e devolve quanto tempo levou. */
async function waitOutboxDrained(): Promise<number> {
  if (!outboxPublisherEnabled) return -1; // publisher desligado (diagnóstico)
  const started = performance.now();
  for (;;) {
    const [row] = await orm.em.fork().execute(`SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`);
    if (row!.pending === 0) return Math.round((performance.now() - started) / 100) / 10;
    await Bun.sleep(200);
  }
}

/** Invariante final: em TODAS as wallets, saldo == ledger reconstruído. */
async function allWalletsConsistent(): Promise<boolean> {
  const [row] = await orm.em.fork().execute(
    `SELECT count(*)::int AS inconsistent FROM (
       SELECT w.id
         FROM wallets w
         LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        GROUP BY w.id, w.balance
       HAVING w.balance <> COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)
     ) AS q`,
  );
  return row!.inconsistent === 0;
}

/** N usuários virtuais em loop fechado, durante `seconds`, alternando entre as instâncias. */
async function closedLoop(seconds: number, nextBody: () => ReturnType<typeof betBody>): Promise<{ results: HttpResult[]; elapsedSeconds: number }> {
  const results: HttpResult[] = [];
  const started = performance.now();
  const deadline = started + seconds * 1_000;
  await Promise.all(
    Array.from({ length: config.virtualUsers }, async (_, vu) => {
      let n = vu;
      while (performance.now() < deadline) {
        results.push(await submit(instances[n++ % instances.length]!, nextBody()));
      }
    }),
  );
  return { results, elapsedSeconds: (performance.now() - started) / 1_000 };
}

async function httpScenario(name: string, seconds: number, nextBody: () => ReturnType<typeof betBody>, notes: string[]): Promise<ScenarioReport> {
  console.log(`\nCenário: ${name} (${config.virtualUsers} usuários virtuais, ${seconds}s)`);
  const conflictsBefore = await lockConflicts();
  const sampler = startOutboxSampler();
  const { results, elapsedSeconds } = await closedLoop(seconds, nextBody);
  const outbox = await sampler.stop();
  const conflictsAfter = await lockConflicts();
  const drainSeconds = await waitOutboxDrained();

  const statusCounts: Record<string, number> = {};
  for (const r of results) {
    const key = r.status === 0 ? 'network_error' : String(r.status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  // 200/202/422 são respostas corretas (422 = rejeição de negócio, ex.: sem saldo). Erro = 5xx ou rede.
  const errors = results.filter((r) => r.status === 0 || r.status >= 500).length;

  return {
    name,
    durationSeconds: Math.round(elapsedSeconds * 10) / 10,
    requests: results.length,
    throughputPerSecond: Math.round(results.length / elapsedSeconds),
    latencyMs: latencySummary(results.map((r) => r.latencyMs)),
    statusCounts,
    errorRate: Math.round((errors / results.length) * 10_000) / 100,
    businessRejections: statusCounts['422'] ?? 0,
    lockConflicts: Object.fromEntries(Object.entries(conflictsAfter).map(([k, v]) => [k, v - (conflictsBefore[k] ?? 0)])),
    maxOutboxLagSeconds: outbox.maxLag,
    maxOutboxPending: outbox.maxPending,
    outboxDrainSeconds: drainSeconds,
    consistent: await allWalletsConsistent(),
    notes,
  };
}

async function queueScenario(): Promise<ScenarioReport> {
  const { wallets: walletCount, messages: total } = config.queue;
  console.log(`\nCenário: fila SQS (${total} mensagens, ${walletCount} wallets, ${config.instances} consumidores)`);
  const wallets = await createWallets(walletCount, '1000000.00');
  const conflictsBefore = await lockConflicts();
  const sentAt = new Map<string, number>();

  const sampler = startOutboxSampler();
  const started = performance.now();
  const entries = Array.from({ length: total }, (_, i) => {
    const body = betBody(wallets[i % wallets.length]!, 'loadq');
    return {
      Id: `m${i}`,
      MessageBody: JSON.stringify({
        messageId: `load-msg-${body.externalTransactionId}`,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: { ...body, idempotencyKey: `${body.providerId}:${body.externalTransactionId}` },
      }),
      MessageGroupId: body.walletId,
      MessageDeduplicationId: body.externalTransactionId,
      externalId: body.externalTransactionId,
    };
  });
  for (let i = 0; i < entries.length; i += 100) {
    await Promise.all(
      Array.from({ length: 10 }, (_, b) => entries.slice(i + b * 10, i + b * 10 + 10)).filter((batch) => batch.length > 0).map(async (batch) => {
        await sqs.send(new SendMessageBatchCommand({ QueueUrl: queues.wagerQueueUrl, Entries: batch.map(({ externalId: _, ...entry }) => entry) }));
        const now = Date.now();
        for (const entry of batch) sentAt.set(entry.externalId, now);
      }),
    );
  }

  // Espera todas as mensagens virarem transações.
  for (;;) {
    const [row] = await orm.em.fork().execute(`SELECT count(*)::int AS done FROM wager_transactions WHERE external_transaction_id LIKE 'loadq-%'`);
    if (row!.done === total) break;
    await Bun.sleep(200);
  }
  const elapsedSeconds = (performance.now() - started) / 1_000;
  const outbox = await sampler.stop();
  const conflictsAfter = await lockConflicts();
  const drainSeconds = await waitOutboxDrained();

  // Latência ponta a ponta de cada mensagem: do envio ao SQS até a transação ser gravada.
  const rows = await orm.em.fork().execute(
    `SELECT external_transaction_id AS id, (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS created_ms, status
       FROM wager_transactions WHERE external_transaction_id LIKE 'loadq-%'`,
  );
  const latencies = rows.map((r) => Math.max(0, (r.created_ms as number) - sentAt.get(r.id as string)!));
  const dlq = await sumMetric(/^wagering_dlq_messages_total\{/);

  return {
    name: 'Fila SQS (3 consumidores)',
    durationSeconds: Math.round(elapsedSeconds * 10) / 10,
    requests: total,
    throughputPerSecond: Math.round(total / elapsedSeconds),
    latencyMs: latencySummary(latencies),
    statusCounts: rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status as string]: (acc[r.status as string] ?? 0) + 1 }), {}),
    errorRate: Math.round((dlq / total) * 10_000) / 100,
    businessRejections: rows.filter((r) => r.status === 'REJECTED').length,
    lockConflicts: Object.fromEntries(Object.entries(conflictsAfter).map(([k, v]) => [k, v - (conflictsBefore[k] ?? 0)])),
    maxOutboxLagSeconds: outbox.maxLag,
    maxOutboxPending: outbox.maxPending,
    outboxDrainSeconds: drainSeconds,
    consistent: await allWalletsConsistent(),
    notes: [
      'Latência = do envio ao SQS até a transação gravada no banco (inclui o tempo na fila).',
      'Taxa de erro = mensagens que foram para a DLQ.',
    ],
  };
}

// ------------------------------------------------------------------ execução

const reports: ScenarioReport[] = [];
try {
  console.log('Criando wallets...');
  const distributedWallets = await createWallets(config.distributed.wallets, '1000000.00');
  const [hotWallet] = await createWallets(1, '1000000.00');

  // Aquecimento: conexões abertas, JIT. Não entra nas medições.
  await closedLoop(config.warmupSeconds, () => betBody(distributedWallets[Math.floor(Math.random() * distributedWallets.length)]!));

  if (scenarios.has('distributed')) reports.push(
    await httpScenario(
      'Distribuído (HTTP, 500 wallets)',
      config.distributed.durationSeconds,
      () => betBody(distributedWallets[Math.floor(Math.random() * distributedWallets.length)]!),
      ['Apostas de 1.00 em wallets aleatórias: pouca disputa pelo mesmo lock.'],
    ),
  );
  if (scenarios.has('hot')) reports.push(
    await httpScenario('Hot wallet (HTTP, 1 wallet)', config.hotWallet.durationSeconds, () => betBody(hotWallet!), [
      'Todas as requisições na MESMA wallet: o lock pessimista as coloca em fila (custo esperado da escolha).',
    ]),
  );
  if (scenarios.has('queue')) reports.push(await queueScenario());
} finally {
  await Promise.all(instances.map(killInstance));
}

// Todo evento gravado na outbox precisa ter chegado ao consumidor de eventos (nenhum perdido).
const [outboxRow] = await orm.em.fork().execute(`SELECT count(*)::int AS total FROM outbox_messages`);
const deadline = Date.now() + 60_000;
while (outboxPublisherEnabled && eventSink.stats().distinctEventIds < outboxRow!.total && Date.now() < deadline) await Bun.sleep(250);
await eventSink.stop();
sqs.destroy();
const sink = eventSink.stats();
console.log(`Eventos na outbox: ${outboxRow!.total} | eventIds distintos recebidos: ${sink.distinctEventIds} | mensagens recebidas (com repetições): ${sink.received}`);

// ------------------------------------------------------------------ relatório

const [pg] = await orm.em.fork().execute(`SELECT current_setting('server_version') AS version`);
const environment = {
  date: new Date().toISOString(),
  os: `${platform()} ${release()}`,
  cpu: `${cpus()[0]?.model.trim()} (${cpus().length} threads)`,
  memoryGb: Math.round(totalmem() / 1024 ** 3),
  bun: Bun.version,
  postgres: pg!.version as string,
  setup: `${config.instances} instâncias (processos) + PostgreSQL e MiniStack em containers Docker na mesma máquina; ${config.virtualUsers} usuários virtuais; consumidor da fila de eventos ligado; publisher da outbox ${outboxPublisherEnabled ? 'ligado' : 'DESLIGADO (diagnóstico)'}; cenários: ${[...scenarios].join(', ')}`,
  events: `${outboxRow!.total} eventos gravados na outbox; ${sink.distinctEventIds} eventIds distintos recebidos na fila de eventos (${sink.received} mensagens, incluindo repetições)`,
};
await orm.close(true);

const lines: string[] = [];
lines.push(`# Resultado do teste de carga — ${environment.date}`, '');
lines.push('## Ambiente', '');
for (const [key, value] of Object.entries(environment)) lines.push(`- **${key}:** ${value}`);
lines.push('', '## Resultados', '');
lines.push('| Cenário | Requisições | Throughput (/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Rejeições de negócio | Conflitos de lock | Outbox lag máx (s) | Outbox pendentes máx | Outbox esvaziou em (s) | Saldo = ledger |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of reports) {
  const conflicts = Object.entries(r.lockConflicts).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ') || '0';
  lines.push(
    `| ${r.name} | ${r.requests} | ${r.throughputPerSecond} | ${r.latencyMs.p50} | ${r.latencyMs.p95} | ${r.latencyMs.p99} | ${r.latencyMs.max} | ${r.errorRate}% | ${r.businessRejections} | ${conflicts} | ${r.maxOutboxLagSeconds} | ${r.maxOutboxPending} | ${r.outboxDrainSeconds} | ${r.consistent ? '✅' : '❌'} |`,
  );
}
lines.push('');
for (const r of reports) {
  lines.push(`**${r.name}:** status ${JSON.stringify(r.statusCounts)}. ${r.notes.join(' ')}`, '');
}

const markdown = lines.join('\n');
await Bun.write('load-test-results/last-run.md', markdown);
await Bun.write('load-test-results/last-run.json', JSON.stringify({ environment, config, reports }, null, 2));
console.log(`\n${markdown}\n\nResultados gravados em load-test-results/last-run.md e .json`);
const eventsOk = !outboxPublisherEnabled || sink.distinctEventIds === outboxRow!.total;
process.exit(reports.every((r) => r.consistent) && eventsOk ? 0 : 1);
