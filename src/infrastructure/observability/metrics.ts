import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

// DECISÃO: métricas com prom-client, expostas em GET /metrics (formato Prometheus).
// POR QUÊ: é o padrão de mercado; contador, gauge e histograma vêm prontos, e o histograma dá a
//          latência em percentis (p50/p95/p99). Qualquer Prometheus/Grafana lê sem adaptação.
// ALTERNATIVA: contadores próprios em JSON — não usei porque o histograma de latência teria que
//              ser feito à mão e o formato não seria lido por nenhuma ferramenta de mercado.
//
// Cada instância da aplicação tem o seu Registry (e não o global do prom-client), para os testes
// conseguirem subir mais de um app no mesmo processo sem "métrica registrada duas vezes".

export interface OutboxBacklog {
  pending: number;
  /** Idade, em segundos, do evento pendente mais antigo (0 se não há pendentes). */
  oldestPendingAgeSeconds: number;
}

export type TransactionSource = 'http' | 'sqs' | 'pending_reference_worker';

export class Metrics {
  readonly registry = new Registry();

  /** Seção 12: transações por status (só transações NOVAS; replays contam em duplicates). */
  readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions by resulting status',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });

  /** Seção 12: duplicatas detectadas (replay por idempotency key ou redelivery da fila). */
  readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicate requests/messages detected and answered with the original result',
    labelNames: ['source', 'reason'] as const,
    registers: [this.registry],
  });

  /** Seção 12: retries (consumidor SQS, publisher da outbox, worker de pendentes). */
  readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries scheduled after a failure',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });

  /** Seção 12: mensagens enviadas para a DLQ, por motivo. */
  readonly deadLetters = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages sent to the dead-letter queue',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  /** Seção 12: conflitos de lock (timeout, deadlock, version diferente, corrida na UNIQUE). */
  readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Concurrency conflicts detected by the database layer',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  /** Seção 12: latência de processamento. */
  readonly processingDuration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Time to process a wager transaction (including the SQL transaction)',
    labelNames: ['source', 'outcome'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  /** Seção 9: divergências encontradas pela reconciliação. */
  readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations where the stored balance did not match the ledger',
    registers: [this.registry],
  });

  readonly pendingReferenceOutcomes = new Counter({
    name: 'wagering_pending_reference_outcomes_total',
    help: 'Results of the pending-reference worker',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly eventsPublished = new Counter({
    name: 'wagering_outbox_events_published_total',
    help: 'Integration events published from the outbox',
    registers: [this.registry],
  });

  /**
   * @param readOutboxBacklog lido do banco a cada coleta (GET /metrics): seção 12, "outbox lag".
   */
  constructor(readOutboxBacklog?: () => Promise<OutboxBacklog>) {
    collectDefaultMetrics({ register: this.registry }); // CPU, memória, event loop do processo

    if (readOutboxBacklog) {
      // O "collect" roda na hora em que o /metrics é lido: o valor é sempre o atual.
      let lastRead: Promise<OutboxBacklog> | undefined;
      const read = () => (lastRead ??= readOutboxBacklog().finally(() => (lastRead = undefined)));
      new Gauge({
        name: 'wagering_outbox_lag_seconds',
        help: 'Age of the oldest unpublished outbox event',
        registers: [this.registry],
        async collect() {
          this.set((await read()).oldestPendingAgeSeconds);
        },
      });
      new Gauge({
        name: 'wagering_outbox_pending_events',
        help: 'Outbox events waiting to be published',
        registers: [this.registry],
        async collect() {
          this.set((await read()).pending);
        },
      });
    }
  }
}
