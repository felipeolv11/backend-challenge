import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { InvalidRequestError } from './http-errors';

// Formato das respostas da API. Dinheiro sempre como { amount: "25.00", currency: "BRL" };
// datas em ISO-8601; campos ausentes como null (o formato fica estável).

export function walletView(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function ledgerEntryView(entry: WalletLedgerEntry) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function transactionView(transaction: WagerTransaction) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    processedAt: transaction.processedAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
  };
}

// DECISÃO: cursor "keyset" com o id do último lançamento, codificado em base64url.
// POR QUÊ: os ids são UUID v7 (ordenados pelo tempo), então "id > cursor ORDER BY id" percorre o
//          extrato em ordem cronológica e é ESTÁVEL: lançamentos novos entram no fim e nunca
//          deslocam páginas já lidas. O base64url deixa o cursor opaco: o cliente não deve
//          montar nem interpretar o cursor, só devolver o que recebeu.
// ALTERNATIVA: OFFSET/página — não usei porque não é estável (itens novos deslocam as páginas)
//              e fica lento com offsets grandes.
const CURSOR_PREFIX = 'v1:';
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(entryId: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${entryId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const entryId = decoded.startsWith(CURSOR_PREFIX) ? decoded.slice(CURSOR_PREFIX.length) : '';
  if (!UUID_FORMAT.test(entryId)) {
    throw new InvalidRequestError('INVALID_CURSOR', 'The cursor is invalid');
  }
  return entryId;
}
