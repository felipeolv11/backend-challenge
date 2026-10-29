import type { InboxMessage } from '../domain/inbox-message';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

// DECISÃO: a application define interfaces (portas) e a infrastructure as implementa com MikroORM.
// POR QUÊ: o caso de uso fica só com regra de negócio, sem SQL nem ORM, e a fronteira entre as
//          camadas fica explícita (o enunciado avalia "boundaries, portas, simplicidade").
//          De bônus, os testes conseguem trocar uma porta para simular falhas (ex.: atomicidade).
// ALTERNATIVA: o caso de uso usar o EntityManager direto — não usei porque a application passaria
//              a depender do ORM e a regra de negócio ficaria misturada com detalhes de banco.

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE: trava a linha da wallet até o fim da transação. */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /**
   * UPDATE ... WHERE id = ? AND version = ?. Lança ConcurrencyConflictError se nenhuma linha
   * for afetada (outra transação mudou a wallet). Com o lock pessimista isso não deveria
   * acontecer: é a segunda proteção.
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Reversão (REFUND/ROLLBACK) PROCESSED que aponta para a transação informada, se existir. */
  findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  insert(transaction: WagerTransaction): Promise<void>;
  /** Grava os campos de resultado (status, failureCode, referência, balanceAfter, processedAt, tentativas). */
  updateOutcome(transaction: WagerTransaction): Promise<void>;
  /** Ids das transações PENDING_REFERENCE cuja próxima tentativa já venceu. */
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Página do extrato em ordem cronológica: lançamentos com id maior que afterEntryId. */
  listByWallet(walletId: string, afterEntryId: string | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  /** Somas exatas (feitas no banco, em NUMERIC) de créditos e débitos, e a quantidade de lançamentos. */
  totalsByWallet(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface LedgerTotals {
  credits: Money;
  debits: Money;
  entries: number;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  insert(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  /**
   * Pega e TRAVA um lote de mensagens pendentes e vencidas (SELECT ... FOR UPDATE SKIP LOCKED).
   * Outra instância rodando ao mesmo tempo pula as linhas travadas e pega outras: dois
   * publishers nunca publicam a mesma mensagem ao mesmo tempo.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Grava publishedAt, attempts e nextAttemptAt. */
  update(message: OutboxMessage): Promise<void>;
  /** Marca várias mensagens como publicadas num UPDATE só. */
  markPublished(ids: string[], at: Date): Promise<void>;
}

/** Resultado da publicação de uma mensagem dentro de um lote: sem `error` = publicada. */
export interface PublishOutcome {
  messageId: string;
  error?: unknown;
}

/**
 * Porta de publicação dos eventos (implementada com SQS).
 * Publica um lote NA ORDEM recebida e diz, mensagem por mensagem, o que foi publicado: uma falha
 * parcial não pode fazer o lote inteiro ser repetido nem marcar como publicado o que não foi.
 */
export interface EventPublisher {
  publishAll(messages: OutboxMessage[]): Promise<PublishOutcome[]>;
}

/** Repositórios que trabalham DENTRO da mesma transação SQL. */
export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Executa `work` numa transação SQL: tudo o que os repositórios gravarem é confirmado junto
 * (commit) ou desfeito junto (rollback) se `work` lançar erro.
 */
export interface TransactionRunner {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}
