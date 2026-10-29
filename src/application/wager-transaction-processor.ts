import { InsufficientBalanceError, WagerRuleViolationError } from '../domain/errors';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { FailureCode } from '../domain/failure-code';
import { OutboxMessage } from '../domain/outbox-message';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { newId } from './ids';
import { PendingReferencePolicy } from './pending-reference-policy';
import type { TransactionalRepositories } from './ports';

/** Dados para montar o contexto dos eventos (rastreabilidade). */
export interface EventTrace {
  correlationId: string;
  causationId?: string;
}

/** Resultado da decisão: o que precisa ser gravado além da própria transação. */
export interface ProcessingOutcome {
  ledgerEntry?: WalletLedgerEntry;
  /** version da wallet ANTES do débito/crédito, para o UPDATE ... WHERE version = ? */
  walletVersionBefore?: number;
  events: IntegrationEvent<unknown>[];
}

/**
 * Decide o destino de uma transação (PROCESSED, REJECTED ou PENDING_REFERENCE) e aplica o
 * efeito no saldo. Usado pelo caso de uso (transações novas) e pelo worker de referências
 * pendentes (transações que estavam esperando).
 *
 * Pré-condição: a wallet já foi carregada com lock (SELECT ... FOR UPDATE) na mesma transação SQL.
 */
export class WagerTransactionProcessor {
  constructor(private readonly pendingReferencePolicy = new PendingReferencePolicy()) {}

  async decide(
    repositories: TransactionalRepositories,
    transaction: WagerTransaction,
    wallet: Wallet | undefined,
    now: Date,
    trace: EventTrace,
  ): Promise<ProcessingOutcome> {
    const outcome: ProcessingOutcome = { events: [] };
    const eventContext = (): EventContext => ({ eventId: newId(), occurredAt: now, ...trace });

    const reject = (code: FailureCode) => {
      transaction.reject(code, wallet?.balance);
      outcome.events.push(WagerTransactionRejected.from(transaction, eventContext()));
      return outcome;
    };

    // ---- 1. A wallet existe, é do player e está na moeda da transação?
    if (!wallet) {
      return reject(FailureCode.WalletNotFound);
    }
    if (wallet.playerId !== transaction.playerId) {
      return reject(FailureCode.PlayerWalletMismatch);
    }
    if (wallet.currency !== transaction.money.currency) {
      return reject(FailureCode.CurrencyMismatch);
    }

    // ---- 2. Referência (obrigatória em REFUND/ROLLBACK, opcional em WIN/LOSS).
    let reference: WagerTransaction | undefined;
    if (transaction.hasReference()) {
      reference = await repositories.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId!,
      );

      // Referência ainda não chegou (ou chegou e ainda não terminou): espera.
      if (!reference || !reference.isTerminal()) {
        // Se já estava esperando (chamada pelo worker), não há transição nem evento novo.
        if (transaction.status === WagerTransactionStatus.Pending) {
          transaction.markPendingReference(this.pendingReferencePolicy.nextAttemptAt(now, 1));
          outcome.events.push(WagerTransactionPendingReference.from(transaction, eventContext()));
        }
        return outcome;
      }

      try {
        transaction.assertValidReference(reference);
      } catch (error) {
        if (error instanceof WagerRuleViolationError) {
          return reject(error.failureCode);
        }
        throw error;
      }

      // Uma reversão por referência (interpretação da regra 4). Como a wallet está travada,
      // outra reversão da mesma referência não consegue rodar ao mesmo tempo; e o índice único
      // wager_tx_one_reversal_per_reference é a garantia final no banco.
      if (transaction.isReversal() && (await repositories.transactions.findProcessedReversalOf(reference.id))) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }

    // ---- 3. Transações que não mexem no saldo (LOSS, WIN de 0.00): processa sem lançamento.
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now, wallet.balance);
      outcome.events.push(WagerTransactionProcessed.from(transaction, eventContext()));
      return outcome;
    }

    // ---- 4. Débito ou crédito. A Wallet garante saldo >= 0 e devolve o lançamento.
    const direction = transaction.ledgerDirectionFor(reference);
    const movement = { entryId: newId(), transactionId: transaction.id, money: transaction.money, at: now };
    const walletVersionBefore = wallet.version;

    let ledgerEntry: WalletLedgerEntry;
    try {
      ledgerEntry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        // Regra 9: aposta sem saldo e reversão que deixaria o saldo negativo são situações
        // operacionalmente diferentes, então têm códigos diferentes.
        const code = transaction.kind === WagerTransactionKind.Bet ? FailureCode.InsufficientFunds : FailureCode.ReversalWouldOverdraw;
        return reject(code);
      }
      throw error;
    }

    transaction.markProcessed(reference?.id, now, wallet.balance);
    outcome.ledgerEntry = ledgerEntry;
    outcome.walletVersionBefore = walletVersionBefore;
    outcome.events.push(WagerTransactionProcessed.from(transaction, eventContext()));
    outcome.events.push(WalletBalanceChanged.from(wallet, ledgerEntry, eventContext()));
    return outcome;
  }

  /**
   * Grava o que a decisão produziu, NA ORDEM das chaves estrangeiras. A transação em si
   * (insert ou update) precisa ter sido gravada antes, porque o lançamento aponta para ela.
   */
  async persist(repositories: TransactionalRepositories, wallet: Wallet | undefined, outcome: ProcessingOutcome): Promise<void> {
    if (outcome.ledgerEntry && wallet) {
      await repositories.ledger.insert(outcome.ledgerEntry);
      await repositories.wallets.updateBalance(wallet, outcome.walletVersionBefore!);
    }
    for (const event of outcome.events) {
      await repositories.outbox.insert(OutboxMessage.enqueue(event));
    }
  }
}
