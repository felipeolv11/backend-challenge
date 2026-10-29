import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisher, PublishOutcome } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';

const SQS_MAX_BATCH = 10; // limite do SendMessageBatch

/**
 * Publica os eventos da outbox na fila FIFO de eventos (wager-events.fifo).
 * - MessageGroupId = walletId: eventos da mesma wallet saem em ordem dentro do SQS.
 * - MessageDeduplicationId = eventId: o SQS descarta a mesma mensagem publicada de novo dentro de
 *   5 minutos. É uma OTIMIZAÇÃO; a garantia é o consumidor deduplicar pelo eventId.
 *
 * DECISÃO: publicar em lotes de 10 (SendMessageBatch), um lote depois do outro.
 * POR QUÊ: uma chamada leva até 10 eventos. O teste de carga mostrou que, com uma chamada por evento,
 *          a outbox não acompanhava a API. Os lotes vão em sequência (e não em paralelo) para manter
 *          a ordem dos eventos de uma mesma wallet.
 * ALTERNATIVA: lotes em paralelo — não usei porque dois lotes com eventos da mesma wallet poderiam
 *              chegar invertidos.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly eventsQueueUrl: string,
  ) {}

  async publishAll(messages: OutboxMessage[]): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    for (let i = 0; i < messages.length; i += SQS_MAX_BATCH) {
      outcomes.push(...(await this.sendBatch(messages.slice(i, i + SQS_MAX_BATCH))));
    }
    return outcomes;
  }

  private async sendBatch(batch: OutboxMessage[]): Promise<PublishOutcome[]> {
    // O Id de cada entrada só precisa ser único dentro do lote; usamos a posição.
    const entries = batch.map((message, index) => ({
      Id: String(index),
      MessageBody: JSON.stringify(message.payload),
      MessageGroupId: groupIdOf(message),
      MessageDeduplicationId: message.id,
      MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
    }));

    try {
      const response = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: this.eventsQueueUrl, Entries: entries }));
      const failedByIndex = new Map((response.Failed ?? []).map((failure) => [failure.Id, failure]));
      return batch.map((message, index) => {
        const failure = failedByIndex.get(String(index));
        return failure ? { messageId: message.id, error: new Error(`${failure.Code}: ${failure.Message}`) } : { messageId: message.id };
      });
    } catch (error) {
      // A chamada inteira falhou (SQS fora, rede...): nenhuma do lote é considerada publicada.
      return batch.map((message) => ({ messageId: message.id, error }));
    }
  }
}

/** Todo evento de transação e de saldo carrega o walletId no data; senão usa o aggregateId. */
function groupIdOf(message: OutboxMessage): string {
  const data = message.payload.data as { walletId?: unknown } | undefined;
  return typeof data?.walletId === 'string' ? data.walletId : message.aggregateId;
}
