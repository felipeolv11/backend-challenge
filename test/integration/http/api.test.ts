import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/create-app';
import { createTestOrm, testDatabaseUrl } from '../../support/test-database';
import { expectWalletMatchesLedger } from '../../support/wagering';

// A API de verdade (NestJS + MikroORM + PostgreSQL), ouvindo numa porta real, chamada com fetch.

let orm: MikroORM;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  orm = await createTestOrm(); // recria o schema do banco de teste
  app = await createApp({ clientUrl: testDatabaseUrl() });
  await app.listen(0); // porta livre qualquer
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await orm.close(true);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl.replace('[::1]', 'localhost')}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
}

async function createWallet(amount = '100.00', playerId: string = Bun.randomUUIDv7()) {
  const response = await call('POST', '/wallets', { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
}

let sequence = 0;
function transaction(wallet: { id: string; playerId: string }, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = `http-tx-${++sequence}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const submit = (body: Record<string, unknown>, key = `provider-a:${body.externalTransactionId}`) =>
  call('POST', '/wagering/transactions', body, { 'Idempotency-Key': key });

describe('POST /wallets', () => {
  test('201 com o formato do enunciado', async () => {
    const playerId = Bun.randomUUIDv7();
    const response = await call('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
  });

  test('409 para wallet duplicada (mesmo player + moeda)', async () => {
    const wallet = await createWallet();
    const response = await call('POST', '/wallets', { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([
    ['playerId que não é UUID', { playerId: 'abc', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['amount como number', { playerId: Bun.randomUUIDv7(), initialBalance: { amount: 1, currency: 'BRL' } }],
    ['amount com 3 casas', { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.001', currency: 'BRL' } }],
    ['moeda inválida', { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.00', currency: 'real' } }],
  ])('400 para %s', async (_name, body) => {
    const response = await call('POST', '/wallets', body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('400 para JSON malformado', async () => {
    const response = await call('POST', '/wallets', '{not json');
    expect(response.status).toBe(400);
  });
});

describe('POST /wagering/transactions — status HTTP por situação', () => {
  test('200 PROCESSED, com o formato do enunciado', async () => {
    const wallet = await createWallet('1000.00');
    const response = await submit(transaction(wallet));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      failureCode: null,
      idempotentReplay: false,
    });
    await expectWalletMatchesLedger(orm, wallet.id);
  });

  test('replay: mesmo status e mesmo corpo, com idempotentReplay = true', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);
    const first = await submit(body);
    const replay = await submit(body);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  test('422 REJECTED por regra de negócio, com failureCode; o replay também é 422', async () => {
    const wallet = await createWallet('10.00');
    const body = transaction(wallet, { money: { amount: '10.01', currency: 'BRL' } });
    const response = await submit(body);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect((await submit(body)).status).toBe(422);
  });

  test('202 PENDING_REFERENCE quando a referência ainda não chegou', async () => {
    const wallet = await createWallet();
    const response = await submit(transaction(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-that-never-came' }));
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: null });
  });

  test('409 IDEMPOTENCY_CONFLICT para a mesma key com payload diferente', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);
    await submit(body);
    const response = await submit({ ...body, money: { amount: '1.00', currency: 'BRL' } });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('400 MISSING_IDEMPOTENCY_KEY sem o header', async () => {
    const wallet = await createWallet();
    const response = await call('POST', '/wagering/transactions', transaction(wallet));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test.each([
    ['campo obrigatório faltando', { gameId: undefined }],
    ['walletId que não é UUID', { walletId: 'wallet-1' }],
    ['kind OPENING (interno)', { kind: 'OPENING' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
    ['amount em notação científica', { money: { amount: '1e3', currency: 'BRL' } }],
  ])('400 INVALID_PAYLOAD para %s', async (_name, overrides) => {
    const wallet = await createWallet();
    const response = await submit(transaction(wallet, overrides));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });

  test('503 com Retry-After quando a wallet fica travada além do lock_timeout (falha transitória)', async () => {
    const wallet = await createWallet();

    // Outra transação segura o lock da wallet por 6 segundos (o lock_timeout é 5s).
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => (releaseLock = resolve));
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (lockAcquired = resolve));
    const holder = orm.em.fork().transactional(async (em) => {
      await em.execute(`SELECT id FROM wallets WHERE id = ? FOR UPDATE`, [wallet.id]);
      lockAcquired();
      await lockHeld;
    });
    await acquired;

    const body = transaction(wallet);
    const response = await submit(body);
    releaseLock();
    await holder;

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.body.error.code).toBe('TEMPORARILY_UNAVAILABLE');

    // Reenviar com a MESMA key depois que o lock foi liberado funciona normalmente.
    const retried = await submit(body);
    expect(retried.status).toBe(200);
    expect(retried.body.idempotentReplay).toBe(false);
  }, 20_000);
});

describe('GETs', () => {
  test('GET /wallets/:id → 200; inexistente → 404; id inválido → 400', async () => {
    const wallet = await createWallet('55.00');
    const found = await call('GET', `/wallets/${wallet.id}`);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ id: wallet.id, balance: { amount: '55.00', currency: 'BRL' }, version: 1 });

    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/not-a-uuid')).status).toBe(400);
  });

  test('GET da transação por id interno e por (provider, id externo)', async () => {
    const wallet = await createWallet();
    const body = transaction(wallet);
    const created = await submit(body);

    const byId = await call('GET', `/wagering/transactions/${created.body.transactionId}`);
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);

    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toMatchObject({ transactionId: created.body.transactionId, kind: 'BET', status: 'PROCESSED', money: { amount: '25.00' } });
    expect((await call('GET', `/providers/provider-a/wagering/transactions/does-not-exist`)).status).toBe(404);
  });
});

describe('GET /wallets/:id/ledger — paginação por cursor', () => {
  test('percorre o extrato em ordem cronológica, sem repetir nem pular, mesmo com lançamentos novos no meio', async () => {
    const wallet = await createWallet('100.00'); // lançamento 1: abertura
    for (let i = 0; i < 4; i++) await submit(transaction(wallet, { money: { amount: '1.00', currency: 'BRL' } })); // 2..5

    const page1 = await call('GET', `/wallets/${wallet.id}/ledger?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).toEqual(expect.any(String));

    // Um lançamento novo chega no meio da paginação: não pode deslocar as páginas.
    await submit(transaction(wallet, { money: { amount: '1.00', currency: 'BRL' } })); // 6

    const page2 = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.body.nextCursor}`);
    const page3 = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${page2.body.nextCursor}`);
    expect(page3.body.nextCursor).toBeNull();

    const all = [...page1.body.items, ...page2.body.items, ...page3.body.items];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((e) => e.id)).size).toBe(6);
    expect(all.map((e) => e.balanceAfter.amount)).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00', '95.00']);
    expect(all.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('cursor adulterado → 400; limit fora do intervalo → 400; wallet inexistente → 404', async () => {
    const wallet = await createWallet();
    expect((await call('GET', `/wallets/${wallet.id}/ledger?cursor=bogus`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=1000`)).status).toBe(400);
    expect((await call('GET', `/wallets/${Bun.randomUUIDv7()}/ledger`)).status).toBe(404);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  test('wallet consistente', async () => {
    const wallet = await createWallet('100.00');
    await submit(transaction(wallet, { money: { amount: '25.00', currency: 'BRL' } }));
    const response = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('divergência é sinalizada e NÃO é corrigida', async () => {
    const wallet = await createWallet('100.00');
    // Simula uma corrupção: alguém mexe no saldo direto no banco, sem lançamento no ledger.
    await orm.em.fork().execute(`UPDATE wallets SET balance = balance + 1.00, version = version + 1 WHERE id = ?`, [wallet.id]);

    const response = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(response.body).toMatchObject({
      storedBalance: { amount: '101.00' },
      calculatedBalance: { amount: '100.00' },
      difference: { amount: '1.00' },
      consistent: false,
    });
    const again = await call('GET', `/wallets/${wallet.id}`);
    expect(again.body.balance.amount).toBe('101.00'); // continua divergente: nada foi "consertado"
  });
});

describe('correlation id', () => {
  test('é devolvido no header e no corpo dos erros; um id do cliente é respeitado', async () => {
    const response = await call('GET', `/wallets/${Bun.randomUUIDv7()}`, undefined, { 'X-Correlation-Id': 'abc-123' });
    expect(response.headers.get('x-correlation-id')).toBe('abc-123');
    expect(response.body.correlationId).toBe('abc-123');
  });
});
