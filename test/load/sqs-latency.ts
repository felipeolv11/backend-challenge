// Diagnóstico do teste de carga: mede a latência de cada tipo de chamada ao SQS (MiniStack),
// isoladamente. Uso: bun run test/load/sqs-latency.ts  (precisa de bun run infra:up)
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageBatchCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadSqsConfig } from '../../src/config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import { setupQueues } from '../../src/infrastructure/sqs/setup-queues';

const sqs = createSqsClient(loadSqsConfig());
const s = `bench-${Date.now()}`;
const { wagerQueueUrl: url } = await setupQueues(sqs, { wagerQueue: `q-${s}.fifo`, wagerDeadLetterQueue: `d-${s}.fifo`, eventsQueue: `e-${s}.fifo` });

async function time(label: string, n: number, fn: (i: number) => Promise<unknown>) {
  const t = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  const ms = (performance.now() - t) / n;
  console.log(`${label.padEnd(42)} ${ms.toFixed(1)} ms por chamada`);
  return ms;
}

const body = JSON.stringify({ x: 'y'.repeat(400) });
await time('SendMessage (1 mensagem)', 100, (i) =>
  sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: `g${i % 20}`, MessageDeduplicationId: `a${i}` })),
);
const batchMs = await time('SendMessageBatch (10 mensagens)', 50, (i) =>
  sqs.send(
    new SendMessageBatchCommand({
      QueueUrl: url,
      Entries: Array.from({ length: 10 }, (_, j) => ({ Id: String(j), MessageBody: body, MessageGroupId: `g${j}`, MessageDeduplicationId: `b${i}-${j}` })),
    }),
  ),
);
console.log(`  -> por mensagem no lote: ${(batchMs / 10).toFixed(1)} ms`);

let received: { ReceiptHandle?: string }[] = [];
await time('ReceiveMessage (até 10, sem espera)', 50, async () => {
  const r = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }));
  received.push(...(r.Messages ?? []));
});
received = received.slice(0, 100);
await time('DeleteMessage', received.length, (i) => sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: received[i]!.ReceiptHandle })));

// Paralelismo: 20 envios simultâneos. Se o emulador processar uma chamada por vez, o tempo total cresce.
const t = performance.now();
await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    sqs.send(new SendMessageCommand({ QueueUrl: url, MessageBody: body, MessageGroupId: `p${i}`, MessageDeduplicationId: `p${i}` })),
  ),
);
console.log(`20 SendMessage em PARALELO: ${(performance.now() - t).toFixed(0)} ms no total`);
sqs.destroy();
