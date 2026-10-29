import { type EntityManager, LockMode } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors';
import type {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  TransactionalRepositories,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { OutboxMessage } from '../../domain/outbox-message';
import type { WagerTransaction } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { InboxMessageRecord, LedgerEntryRecord, OutboxMessageRecord, WagerTransactionRecord, WalletRecord } from './entities';
import {
  inboxMessageToRow,
  ledgerEntryToRow,
  outboxMessageToRow,
  toInboxMessage,
  toWagerTransaction,
  toWallet,
  walletToRow,
  wagerTransactionToRow,
} from './mappers';

// DECISÃO: gravar com comandos explícitos (em.insert / em.nativeUpdate), na ordem certa.
// POR QUÊ: cada SQL fica visível e na ordem das chaves estrangeiras, e a checagem da version
//          fica explícita no UPDATE. Tudo continua dentro do em.transactional() (atômico).
// ALTERNATIVA: Unit of Work (em.persist + flush) — não usei porque a ordem das gravações e o
//              controle da version ficariam implícitos, e o versionamento automático do ORM
//              incrementaria a version de novo (o domínio já incrementa).
//
// As leituras usam disableIdentityMap: os registros lidos não ficam "gerenciados" pelo ORM,
// então nada é gravado sem passar por um comando explícito.

const readOptions = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletRecord, { id }, readOptions);
    return row ? toWallet(row) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    // SELECT ... FOR UPDATE: outra transação que tentar travar a mesma wallet espera aqui.
    const row = await this.em.findOne(WalletRecord, { id }, { ...readOptions, lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? toWallet(row) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, walletToRow(wallet));
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    // UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?
    const affectedRows = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affectedRows !== 1) {
      throw new ConcurrencyConflictError(`Wallet ${wallet.id} changed concurrently (expected version ${expectedVersion})`);
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, { id }, readOptions);
    return row ? toWagerTransaction(row) : undefined;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey }, readOptions);
    return row ? toWagerTransaction(row) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, readOptions);
    return row ? toWagerTransaction(row) : undefined;
  }

  async findProcessedReversalOf(referenceTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      WagerTransactionRecord,
      { referenceTransactionId, kind: { $in: ['REFUND', 'ROLLBACK'] }, status: 'PROCESSED' },
      readOptions,
    );
    return row ? toWagerTransaction(row) : undefined;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, wagerTransactionToRow(transaction, new Date()));
  }

  async updateOutcome(transaction: WagerTransaction): Promise<void> {
    const row = wagerTransactionToRow(transaction, new Date());
    await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      {
        status: row.status,
        failureCode: row.failureCode,
        referenceTransactionId: row.referenceTransactionId,
        balanceAfter: row.balanceAfter,
        processedAt: row.processedAt,
        updatedAt: row.updatedAt,
      },
    );
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, ledgerEntryToRow(entry));
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, readOptions);
    return row ? toInboxMessage(row) : undefined;
  }

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageRecord, inboxMessageToRow(message));
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageRecord, outboxMessageToRow(message));
  }
}

export function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}
