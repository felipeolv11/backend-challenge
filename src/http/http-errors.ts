import type { ZodType } from 'zod';

/** Requisição inválida detectada na camada HTTP (formato, header obrigatório, cursor...). */
export class InvalidRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/** Valida com o schema do zod; se falhar, lança InvalidRequestError (HTTP 400) com os detalhes. */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    throw new InvalidRequestError('INVALID_PAYLOAD', `Invalid ${what}`, details);
  }
  return result.data;
}
