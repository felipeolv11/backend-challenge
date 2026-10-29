import type { OutboxMessage } from '../domain/outbox-message';
import type { EventPublisher, TransactionRunner } from './ports';

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  failed: number;
}

export type PublishFailureListener = (message: OutboxMessage, error: unknown) => void;

/**
 * Publica um lote de eventos pendentes da outbox (seção 11).
 *
 * DECISÃO: cada publisher pega o lote com SELECT ... FOR UPDATE SKIP LOCKED, publica, marca e
 *          faz commit, tudo numa transação.
 * POR QUÊ: duas instâncias rodando ao mesmo tempo nunca pegam a mesma mensagem (a outra PULA as
 *          linhas travadas). Se o processo morrer antes do commit, o lock é solto e outra instância
 *          publica depois. Nada se perde.
 * ALTERNATIVA: reservar com uma coluna "locked_until" (lease) e publicar fora da transação — não
 *              usei porque são mais uma coluna e mais estados para explicar, sem ganho aqui.
 *
 * Publicação duplicada é possível e segura: se o processo morrer DEPOIS de publicar e ANTES do
 * commit, a mensagem volta a ficar pendente e é publicada de novo, com o MESMO eventId. O SQS FIFO
 * descarta repetições pelo MessageDeduplicationId (otimização) e o consumidor deduplica pelo eventId
 * (garantia).
 *
 * Desempenho: o teste de carga mostrou que publicar UM evento por chamada ao SQS limitava a cerca
 * de 160 eventos/s, e a outbox acumulava sob carga contínua. Por isso o lote do banco é maior (100)
 * e a publicação é em lotes de 10 por chamada (SendMessageBatch), ver LOAD-TEST.md.
 */
export class PublishOutbox {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly publisher: EventPublisher,
    private readonly batchSize = 100,
    private readonly onFailure: PublishFailureListener = () => {},
  ) {}

  async publishBatch(): Promise<PublishOutboxResult> {
    return this.runner.run(async (repositories) => {
      const messages = await repositories.outbox.claimDue(new Date(), this.batchSize);
      const result: PublishOutboxResult = { claimed: messages.length, published: 0, failed: 0 };
      if (messages.length === 0) return result;

      const outcomes = await this.publisher.publishAll(messages);
      const errorById = new Map(outcomes.map((outcome) => [outcome.messageId, outcome.error]));
      const now = new Date();
      const publishedIds: string[] = [];

      for (const message of messages) {
        // Sem resultado para a mensagem = não sabemos se saiu: trata como falha (republicar é seguro).
        const error = errorById.has(message.id) ? errorById.get(message.id) : new Error('No publish outcome');
        if (error === undefined) {
          message.markPublished(now);
          publishedIds.push(message.id);
        } else {
          // Não desiste nunca: agenda a próxima tentativa com backoff (OutboxMessage.scheduleRetry).
          message.scheduleRetry(now);
          await repositories.outbox.update(message);
          result.failed += 1;
          this.onFailure(message, error);
        }
      }

      await repositories.outbox.markPublished(publishedIds, now);
      result.published = publishedIds.length;
      return result;
    });
  }
}
