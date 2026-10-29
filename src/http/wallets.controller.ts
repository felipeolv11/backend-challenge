import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CreateWallet } from '../application/create-wallet';
import { ReconcileWallet } from '../application/reconcile-wallet';
import { WalletQueries } from '../application/wallet-queries';
import { AuthGuard } from './auth.guard';
import { parseOrThrow } from './http-errors';
import type { HttpRequest } from './http-types';
import { decodeCursor, encodeCursor, ledgerEntryView, walletView } from './presenters';
import { createWalletSchema, ledgerQuerySchema, uuidParamSchema } from './schemas';

// Os @Inject(...) são explícitos de propósito: não dependem dos metadados de tipo do
// TypeScript (emitDecoratorMetadata), deixando a injeção de dependência previsível no Bun.
@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(WalletQueries) private readonly queries: WalletQueries,
    @Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() request: HttpRequest) {
    const input = parseOrThrow(createWalletSchema, body, 'wallet');
    return this.createWallet.execute(input, { correlationId: request.correlationId! });
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const id = parseOrThrow(uuidParamSchema, walletId, 'walletId');
    return walletView(await this.queries.getWallet(id));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: unknown) {
    const id = parseOrThrow(uuidParamSchema, walletId, 'walletId');
    const { cursor, limit } = parseOrThrow(ledgerQuerySchema, query, 'query');
    const page = await this.queries.listLedger(id, cursor ? decodeCursor(cursor) : undefined, limit);
    return {
      items: page.items.map(ledgerEntryView),
      nextCursor: page.nextAfterEntryId ? encodeCursor(page.nextAfterEntryId) : null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const id = parseOrThrow(uuidParamSchema, walletId, 'walletId');
    return this.reconcileWallet.execute(id);
  }
}
