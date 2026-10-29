import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { NotFoundError } from './errors';
import type { TransactionRunner } from './ports';

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Id do último item, quando pode haver mais itens; undefined na última página. */
  nextAfterEntryId: string | undefined;
}

/**
 * Consultas da API (GET). Usam o mesmo TransactionRunner das escritas: cada consulta roda numa
 * transação curta, só de leitura.
 */
export class WalletQueries {
  constructor(private readonly runner: TransactionRunner) {}

  async getWallet(walletId: string): Promise<Wallet> {
    const wallet = await this.runner.run((repositories) => repositories.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);
    return wallet;
  }

  async listLedger(walletId: string, afterEntryId: string | undefined, limit: number): Promise<LedgerPage> {
    return this.runner.run(async (repositories) => {
      if (!(await repositories.wallets.findById(walletId))) {
        throw new NotFoundError(`Wallet ${walletId} not found`);
      }
      // Busca 1 a mais para saber se existe uma próxima página sem precisar de COUNT.
      const entries = await repositories.ledger.listByWallet(walletId, afterEntryId, limit + 1);
      const hasMore = entries.length > limit;
      const items = hasMore ? entries.slice(0, limit) : entries;
      return { items, nextAfterEntryId: hasMore ? items[items.length - 1]!.id : undefined };
    });
  }

  async getTransaction(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.runner.run((repositories) => repositories.transactions.findById(transactionId));
    if (!transaction) throw new NotFoundError(`Transaction ${transactionId} not found`);
    return transaction;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.runner.run((repositories) =>
      repositories.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) throw new NotFoundError(`Transaction ${externalTransactionId} of provider ${providerId} not found`);
    return transaction;
  }
}
