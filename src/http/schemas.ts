import { z } from 'zod';

// DECISÃO: validação de entrada com zod.
// POR QUÊ: uma dependência só; o schema é TypeScript comum e o tipo é inferido dele, sem
//          decorators nem metadados de tipo (sem surpresas no Bun).
// ALTERNATIVA: class-validator + class-transformer (padrão dos tutoriais de NestJS) — não usei
//              porque são duas dependências e dependem de metadados de tipo; validação à mão daria
//              muito código repetido e mensagens inconsistentes.
//
// O zod valida a FORMA (tipos, campos obrigatórios, tamanhos). As regras de valor (formato do
// amount, moeda ISO-4217, kinds permitidos) ficam no domínio (Money.from, WagerTransaction.create),
// que é a única fonte da verdade dessas regras.

const MAX_TEXT = 255;
const text = () => z.string().trim().min(1).max(MAX_TEXT);

const moneySchema = z.object({
  amount: z.string(), // formato validado por Money.from (exatamente 2 casas, sem notação científica...)
  currency: z.string(),
});

export const createWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

export const submitWagerTransactionSchema = z.object({
  providerId: text(),
  externalTransactionId: text(),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: text(),
  gameId: text(),
  kind: text(),
  money: moneySchema,
  referenceExternalTransactionId: text().optional(),
});

export const idempotencyKeySchema = text();

export const uuidParamSchema = z.uuid();

export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const providerParamsSchema = z.object({
  providerId: text(),
  externalTransactionId: text(),
});
