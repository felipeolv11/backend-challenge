import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { loadSqsConfig } from '../../src/config';
import { createSqsClient } from '../../src/infrastructure/sqs/sqs-client';
import { type QueueUrls, setupQueues } from '../../src/infrastructure/sqs/setup-queues';

export function testSqsClient(): SQSClient {
  return createSqsClient(loadSqsConfig());
}

/** Filas com nomes únicos por execução: cada arquivo de teste tem as suas, sem interferência. */
export async function createTestQueues(sqs: SQSClient, prefix: string, visibilityTimeoutSeconds = 2): Promise<QueueUrls> {
  const suffix = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return setupQueues(
    sqs,
    { wagerQueue: `wager-${suffix}.fifo`, wagerDeadLetterQueue: `wager-dlq-${suffix}.fifo`, eventsQueue: `events-${suffix}.fifo` },
    { visibilityTimeoutSeconds, maxReceiveCount: 10 },
  );
}

/** Envia uma mensagem no formato da seção 10. */
export async function sendWagerMessage(
  sqs: SQSClient,
  queueUrl: string,
  envelope: { messageId: string; data: Record<string, unknown> },
  options: { groupId?: string; deduplicationId?: string } = {},
) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({ type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), ...envelope }),
      MessageGroupId: options.groupId ?? String(envelope.data.walletId ?? 'group'),
      // Cada envio é uma entrega nova para o SQS (simula reenvio pelo produtor).
      MessageDeduplicationId: options.deduplicationId ?? `${envelope.messageId}-${Date.now()}-${Math.random()}`,
    }),
  );
}

export async function sendRawMessage(sqs: SQSClient, queueUrl: string, body: string) {
  await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body, MessageGroupId: 'raw', MessageDeduplicationId: `raw-${Date.now()}-${Math.random()}` }),
  );
}

/**
 * Lê e APAGA tudo o que estiver disponível na fila agora, como um consumidor de verdade.
 * Apagar é necessário em fila FIFO: enquanto uma mensagem de um grupo está "em andamento", o SQS
 * segura as próximas do mesmo grupo (é assim que ele garante a ordem).
 */
export async function drainQueue(sqs: SQSClient, queueUrl: string, rounds = 3): Promise<Message[]> {
  const all: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 60,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['All'],
      }),
    );
    all.push(...Messages);
    for (const message of Messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    if (Messages.length === 0) break;
  }
  return all;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
