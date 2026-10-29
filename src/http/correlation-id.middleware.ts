import { newId } from '../application/ids';
import type { HttpRequest, HttpResponse } from './http-types';

// Aceita só ids "comportados" vindos do cliente, para ninguém injetar texto estranho nos logs.
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Cada requisição ganha um correlationId: o do header X-Correlation-Id (se for válido) ou um novo.
 * Ele acompanha a operação nos logs, nos eventos da outbox e volta no header da resposta.
 */
export function correlationIdMiddleware(request: HttpRequest, response: HttpResponse, next: () => void): void {
  const incoming = request.headers['x-correlation-id'];
  const correlationId = typeof incoming === 'string' && SAFE_CORRELATION_ID.test(incoming) ? incoming : newId();
  request.correlationId = correlationId;
  response.setHeader('X-Correlation-Id', correlationId);
  next();
}
