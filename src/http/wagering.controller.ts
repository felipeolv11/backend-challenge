import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { WalletQueries } from '../application/wallet-queries';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { AuthGuard } from './auth.guard';
import { InvalidRequestError, parseOrThrow } from './http-errors';
import type { HttpRequest, HttpResponse } from './http-types';
import { transactionView } from './presenters';
import { idempotencyKeySchema, providerParamsSchema, submitWagerTransactionSchema, uuidParamSchema } from './schemas';

/** Status HTTP de acordo com o resultado da transação (ver a tabela no error-filter.ts). */
const STATUS_CODE_BY_RESULT: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  // FAILED só é produzido pelo consumidor da fila (erro permanente de infraestrutura).
  // Se um replay HTTP encontrar uma transação FAILED, devolve 500 com o corpo da transação.
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processWagerTransaction: ProcessWagerTransaction,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ) {
    if (!idempotencyKeyHeader) {
      throw new InvalidRequestError('MISSING_IDEMPOTENCY_KEY', 'The Idempotency-Key header is required');
    }
    const idempotencyKey = parseOrThrow(idempotencyKeySchema, idempotencyKeyHeader, 'Idempotency-Key header');
    const input = parseOrThrow(submitWagerTransactionSchema, body, 'wager transaction');

    const result = await this.processWagerTransaction.execute(
      { ...input, idempotencyKey },
      { correlationId: request.correlationId! },
    );

    response.status(STATUS_CODE_BY_RESULT[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const id = parseOrThrow(uuidParamSchema, transactionId, 'transactionId');
    return transactionView(await this.queries.getTransaction(id));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param() params: unknown) {
    const { providerId, externalTransactionId } = parseOrThrow(providerParamsSchema, params, 'path');
    return transactionView(await this.queries.getTransactionByExternalId(providerId, externalTransactionId));
  }
}
