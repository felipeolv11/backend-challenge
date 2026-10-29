import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import {
  IdempotencyConflictError,
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../application/errors';
import { DomainError } from '../domain/errors';
import { InvalidRequestError } from './http-errors';
import type { HttpRequest, HttpResponse } from './http-types';

// DECISÃO: mapeamento de status HTTP (o mesmo em todos os endpoints):
//   200 PROCESSED (novo ou replay)      201 wallet criada
//   202 PENDING_REFERENCE (aceito)      400 payload inválido / sem Idempotency-Key
//   404 não encontrado                  409 conflito de idempotência / wallet já existe
//   422 REJECTED por regra de negócio   503 falha transitória (+ Retry-After)
//   500 bug nosso
// POR QUÊ: o enunciado pede que o provedor saiba, só pelo status, se pode reenviar (503), se
//          deve corrigir o payload (400), se é conflito (409) ou se foi uma rejeição definitiva de
//          negócio (422). O replay devolve o mesmo status do original.
// ALTERNATIVA: 200 para tudo que foi gravado (PROCESSED/REJECTED/PENDING) — não usei porque obriga
//              o provedor a ler o corpo para saber se a aposta foi rejeitada.
//
// 200, 202 e 422 de POST /wagering/transactions são decididos no controller (pelo status da
// transação). Este filtro cuida dos ERROS (exceções).

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  correlationId: string | undefined;
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const response = http.getResponse<HttpResponse>();
    const { status, code, message, details } = this.classify(exception);

    if (status === 503) {
      // Retry-After: o provedor pode tentar de novo depois de 1 segundo, com a MESMA key.
      response.setHeader('Retry-After', '1');
    }
    if (status >= 500) {
      this.logger.error(`${code}: ${exception instanceof Error ? exception.message : String(exception)}`, {
        correlationId: request.correlationId,
      });
    }

    const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) }, correlationId: request.correlationId };
    response.status(status).json(body);
  }

  private classify(exception: unknown): { status: number; code: string; message: string; details?: unknown } {
    if (exception instanceof InvalidRequestError) {
      return { status: 400, code: exception.code, message: exception.message, details: exception.details };
    }
    // Erros de domínio que escapam até aqui são de valor do payload (ex.: amount "25.5",
    // REFUND sem referência). Rejeições de negócio NÃO chegam aqui: viram 422 no controller.
    if (exception instanceof DomainError) {
      return { status: 400, code: 'INVALID_PAYLOAD', message: exception.message };
    }
    if (exception instanceof IdempotencyConflictError) {
      return { status: 409, code: 'IDEMPOTENCY_CONFLICT', message: exception.message };
    }
    if (exception instanceof WalletAlreadyExistsError) {
      return { status: 409, code: 'WALLET_ALREADY_EXISTS', message: exception.message };
    }
    if (exception instanceof NotFoundError) {
      return { status: 404, code: 'NOT_FOUND', message: exception.message };
    }
    if (exception instanceof TransientInfrastructureError) {
      return { status: 503, code: 'TEMPORARILY_UNAVAILABLE', message: 'Temporarily unavailable, retry with the same Idempotency-Key' };
    }
    // Erros do próprio NestJS/Express (rota inexistente, JSON malformado...).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: status === 404 ? 'NOT_FOUND' : status < 500 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: exception.message };
    }
    // Qualquer outra coisa é bug nosso (ProgrammingError ou inesperado): não vaza detalhes.
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal error' };
  }
}
