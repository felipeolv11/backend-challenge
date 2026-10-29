import { z } from 'zod';
import { idempotencyKeySchema, submitWagerTransactionSchema } from '../../http/schemas';

/**
 * Formato da mensagem na fila wager-transactions.fifo (seção 10 do enunciado).
 * O "data" é o MESMO contrato do POST /wagering/transactions (reaproveita o schema da API),
 * mais a idempotencyKey, que na fila vem dentro da mensagem e não num header.
 */
export const wagerTransactionMessageSchema = z.object({
  messageId: z.string().trim().min(1).max(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: submitWagerTransactionSchema.extend({ idempotencyKey: idempotencyKeySchema }),
});

export type WagerTransactionMessage = z.infer<typeof wagerTransactionMessageSchema>;

/** Lança erro se o corpo não for JSON ou não seguir o contrato (o consumidor manda para a DLQ). */
export function parseWagerTransactionMessage(body: string | undefined): WagerTransactionMessage {
  return wagerTransactionMessageSchema.parse(JSON.parse(body ?? ''));
}
