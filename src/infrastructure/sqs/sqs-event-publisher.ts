import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';

/**
 * Publica os eventos da outbox na fila FIFO de eventos (wager-events.fifo).
 * - MessageGroupId = walletId: eventos da mesma wallet saem em ordem dentro do SQS.
 * - MessageDeduplicationId = eventId: o SQS descarta a mesma mensagem publicada de novo dentro de
 *   5 minutos. É uma OTIMIZAÇÃO; a garantia é o consumidor deduplicar pelo eventId.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly eventsQueueUrl: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: groupIdOf(message),
        MessageDeduplicationId: message.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
      }),
    );
  }
}

/** Todo evento de transação e de saldo carrega o walletId no data; senão usa o aggregateId. */
function groupIdOf(message: OutboxMessage): string {
  const data = message.payload.data as { walletId?: unknown } | undefined;
  return typeof data?.walletId === 'string' ? data.walletId : message.aggregateId;
}
