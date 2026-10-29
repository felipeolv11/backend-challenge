import { WagerTransactionProcessed } from '../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { Money, type MoneyProps } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { Wallet } from '../domain/wallet';
import { DuplicateRecordError, WalletAlreadyExistsError } from './errors';
import { newId } from './ids';
import type { TransactionRunner } from './ports';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/**
 * Cria a wallet. Se o saldo inicial for maior que zero, na MESMA transação SQL:
 * transação interna OPENING + lançamento CREDIT + eventos na outbox (seção 9).
 */
export class CreateWallet {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(command: CreateWalletCommand, context: { correlationId: string }): Promise<CreateWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const now = new Date();
    const walletId = newId();
    const openingTransactionId = newId();

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance,
      openingTransactionId,
      openingEntryId: newId(),
      at: now,
    });

    try {
      await this.runner.run(async (repositories) => {
        await repositories.wallets.insert(wallet);

        if (openingEntry) {
          const opening = WagerTransaction.opening({
            id: openingTransactionId,
            walletId,
            playerId: command.playerId,
            money: initialBalance,
            at: now,
          });
          await repositories.transactions.insert(opening);
          await repositories.ledger.insert(openingEntry);

          // A abertura também é uma transação aplicada que muda o saldo (de 0 para o inicial).
          const trace = { correlationId: context.correlationId, occurredAt: now };
          await repositories.outbox.insert(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, { ...trace, eventId: newId() })));
          await repositories.outbox.insert(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, { ...trace, eventId: newId() })),
          );
        }
      });
    } catch (error) {
      if (error instanceof DuplicateRecordError && error.constraint === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError(`Player ${command.playerId} already has a ${initialBalance.currency} wallet`);
      }
      throw error;
    }

    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }
}
