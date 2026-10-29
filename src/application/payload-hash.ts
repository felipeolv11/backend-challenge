import { createHash } from 'node:crypto';

/**
 * Hash do payload para a idempotência (seção 9):
 *   SHA-256, em hexadecimal, de um JSON CANÔNICO (chaves ordenadas em todos os níveis)
 *   contendo só os campos de negócio.
 *
 * Fica de fora: o header Idempotency-Key e metadados de transporte (messageId, occurredAt...).
 * Chaves ordenadas fazem {"a":1,"b":2} e {"b":2,"a":1} gerarem o mesmo hash. Campos ausentes
 * entram como null, para "sem referência" ter sempre a mesma representação.
 */
export interface HashableWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string | null;
}

export function hashWagerPayload(payload: HashableWagerPayload): string {
  const businessFields = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
  };
  return sha256(canonicalJson(businessFields));
}

/** Hash de qualquer valor JSON (usado na inbox para comparar mensagens com o mesmo messageId). */
export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** JSON com as chaves dos objetos ordenadas, em todos os níveis. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
