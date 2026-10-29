import { FailureCode } from '../domain/failure-code';
import { InboxMessage } from '../domain/inbox-message';
import { Money, type MoneyProps } from '../domain/money';
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '../domain/wager-transaction';
import { DuplicateRecordError, IdempotencyConflictError, InboxMessageConflictError } from './errors';
import { newId } from './ids';
import { hashWagerPayload } from './payload-hash';
import type { TransactionalRepositories, TransactionRunner } from './ports';
import { PendingReferencePolicy } from './pending-reference-policy';
import { WagerTransactionProcessor } from './wager-transaction-processor';

/** Pedido vindo do provedor. É o mesmo formato para HTTP e fila (seção 10). */
export interface WagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessingContext {
  correlationId: string;
  /** Presente quando o pedido veio da fila: o registro de inbox entra na mesma transação SQL. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Saldo observado ao processar/rejeitar; null enquanto pendente ou sem wallet. */
  balance: MoneyProps | null;
  failureCode: FailureCode | null;
  idempotentReplay: boolean;
}

/**
 * Caso de uso único para HTTP e SQS. Tudo acontece numa transação SQL só:
 * inbox + transação + ledger + saldo + outbox. Ou tudo é confirmado, ou nada.
 */
export class ProcessWagerTransaction {
  private readonly processor: WagerTransactionProcessor;

  constructor(
    private readonly runner: TransactionRunner,
    pendingReferencePolicy = new PendingReferencePolicy(),
  ) {
    this.processor = new WagerTransactionProcessor(pendingReferencePolicy);
  }

  async execute(command: WagerTransactionCommand, context: ProcessingContext): Promise<WagerTransactionResult> {
    // Validação do payload ANTES de abrir transação no banco: payload inválido não é gravado
    // (lança InvalidMoneyError ou InvalidWagerTransactionError).
    const payloadHash = hashWagerPayload(command);
    const props = this.toCreateProps(command, payloadHash);
    WagerTransaction.create(props);

    try {
      return await this.runner.run((repositories) => this.processInTransaction(repositories, props, context));
    } catch (error) {
      // Corrida entre dois pedidos iguais que não passaram pelo lock da wallet (ex.: wallet
      // inexistente): o segundo INSERT bate na constraint UNIQUE. Tentando de novo, ele encontra
      // o registro já gravado e devolve o replay.
      if (error instanceof DuplicateRecordError) {
        return await this.runner.run((repositories) => this.processInTransaction(repositories, props, context));
      }
      throw error;
    }
  }

  private async processInTransaction(
    repositories: TransactionalRepositories,
    props: CreateWagerTransactionProps,
    context: ProcessingContext,
  ): Promise<WagerTransactionResult> {
    const now = new Date();

    // DECISÃO: lock pessimista na wallet (SELECT ... FOR UPDATE) como PRIMEIRO passo.
    // POR QUÊ: operações da mesma wallet passam a rodar uma de cada vez: a segunda aposta espera
    //          a primeira terminar e já lê o saldo atualizado. Isso inclui pedidos duplicados:
    //          o segundo só olha a idempotência depois que o primeiro fez commit. Só aquela linha
    //          é travada; wallets diferentes continuam em paralelo. O UPDATE ainda confere a
    //          version (segunda proteção) e o lock tem timeout (lock_timeout) para não travar
    //          para sempre.
    // ALTERNATIVA 1: lock otimista com retry — não usei porque, com muitas operações na mesma
    //                wallet (50 apostas iguais em paralelo), quase todas conflitariam e
    //                entrariam em retry.
    // ALTERNATIVA 2: UPDATE condicional (balance >= valor) — não usei porque a regra do saldo
    //                sairia da classe Wallet e iria para o SQL.
    const wallet = await repositories.wallets.findByIdForUpdate(props.walletId);

    // ---- Inbox: a mesma mensagem da fila já foi tratada?
    let shouldRecordInbox = context.inbox !== undefined;
    if (context.inbox) {
      const existingInbox = await repositories.inbox.find(context.inbox.consumerName, context.inbox.messageId);
      if (existingInbox) {
        if (!existingInbox.matchesPayload(context.inbox.payloadHash)) {
          throw new InboxMessageConflictError(`Message ${context.inbox.messageId} was already received with a different payload`);
        }
        shouldRecordInbox = false;
      }
    }

    // ---- Idempotência: a mesma key (ou a mesma transação externa) já foi gravada?
    const existing =
      (await repositories.transactions.findByIdempotencyKey(props.providerId, props.idempotencyKey)) ??
      (await repositories.transactions.findByExternalId(props.providerId, props.externalTransactionId));
    if (existing) {
      if (existing.idempotencyKey !== props.idempotencyKey || !existing.matchesPayload(props.payloadHash)) {
        throw new IdempotencyConflictError(
          `Idempotency conflict for provider ${props.providerId}: key or transaction already used with a different payload`,
        );
      }
      if (shouldRecordInbox) {
        await this.recordInbox(repositories, context, now);
      }
      return toResult(existing, true);
    }

    // ---- Transação nova: decide, grava a transação e depois o que a decisão produziu.
    const transaction = WagerTransaction.create(props);
    const outcome = await this.processor.decide(repositories, transaction, wallet, now, {
      correlationId: context.correlationId,
      causationId: context.inbox?.messageId ?? props.idempotencyKey,
    });

    await repositories.transactions.insert(transaction);
    await this.processor.persist(repositories, wallet, outcome);
    if (shouldRecordInbox) {
      await this.recordInbox(repositories, context, now);
    }

    return toResult(transaction, false);
  }

  /**
   * Registra a transação como FAILED (PROCESSING_ERROR) depois de esgotar as tentativas por erro
   * de infraestrutura. Fica auditável e, a partir daí, um reenvio devolve o mesmo FAILED (terminal).
   * Se já existe algo gravado para a key, não faz nada e devolve o que existe.
   * É "melhor esforço": se o banco continuar fora, isto também falha e a mensagem vai para a DLQ
   * do mesmo jeito.
   */
  async recordFailure(command: WagerTransactionCommand, context: ProcessingContext): Promise<WagerTransactionResult> {
    const props = this.toCreateProps(command, hashWagerPayload(command));
    return this.runner.run(async (repositories) => {
      const existing =
        (await repositories.transactions.findByIdempotencyKey(props.providerId, props.idempotencyKey)) ??
        (await repositories.transactions.findByExternalId(props.providerId, props.externalTransactionId));
      if (existing) {
        return toResult(existing, true);
      }

      const transaction = WagerTransaction.create(props);
      transaction.fail(FailureCode.ProcessingError);
      await repositories.transactions.insert(transaction);
      if (context.inbox && !(await repositories.inbox.find(context.inbox.consumerName, context.inbox.messageId))) {
        await this.recordInbox(repositories, context, new Date());
      }
      return toResult(transaction, false);
    });
  }

  private async recordInbox(repositories: TransactionalRepositories, context: ProcessingContext, now: Date): Promise<void> {
    const inbox = InboxMessage.receive({ ...context.inbox!, receivedAt: now });
    inbox.markProcessed(now);
    await repositories.inbox.insert(inbox);
  }

  private toCreateProps(command: WagerTransactionCommand, payloadHash: string): CreateWagerTransactionProps {
    return {
      id: newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: new Date(),
    };
  }
}

/** Monta a resposta a partir da transação gravada. No replay, devolve o resultado ORIGINAL. */
export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.balanceAfter?.toJSON() ?? null,
    failureCode: transaction.failureCode ?? null,
    idempotentReplay,
  };
}
