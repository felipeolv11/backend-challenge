import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { IdempotencyConflictError, InboxMessageConflictError } from '../../application/errors';
import { hashJson } from '../../application/payload-hash';
import type { ProcessingContext, ProcessWagerTransaction, WagerTransactionCommand } from '../../application/process-wager-transaction';
import type { ConsumerConfig } from '../../config';
import { DomainError } from '../../domain/errors';
import { parseWagerTransactionMessage } from './wager-message';

export interface ConsumerQueues {
  queueUrl: string;
  deadLetterQueueUrl: string;
}

/** O que aconteceu com uma mensagem (útil para testes e métricas). */
export type ConsumerAction = 'acked' | 'retry-scheduled' | 'dead-lettered' | 'released';

export type ConsumerActionListener = (action: ConsumerAction, details: { messageId?: string; reason?: string }) => void;

/**
 * Consumidor da fila wager-transactions.fifo (seção 10 do enunciado).
 *
 * - Usa o MESMO caso de uso da entrada HTTP (ProcessWagerTransaction).
 * - Dedup persistente pela inbox (consumerName, messageId), dentro da transação SQL do caso de uso.
 * - ack (DeleteMessage) SOMENTE depois do commit: execute() só retorna depois do commit.
 * - Três tipos de erro:
 *     negócio (REJECTED etc.) → não é erro: o resultado está gravado, faz ack;
 *     transitório (banco, lock, rede) → devolve à fila com backoff (ChangeMessageVisibility);
 *     permanente (mensagem ilegível, payload inválido, conflito) → DLQ na hora.
 * - Limite de tentativas: na última, registra a transação como FAILED e manda para a DLQ.
 * - SIGTERM (stop): termina a mensagem em andamento e devolve a visibilidade das que não começou.
 *
 * Se o processo morrer DEPOIS do commit e ANTES do ack, o SQS entrega a mensagem de novo; a inbox
 * já tem o registro, então o caso de uso devolve o replay (sem efeito novo) e aí fazemos o ack.
 */
export class WagerTransactionConsumer {
  private readonly logger = new Logger(WagerTransactionConsumer.name);
  private loop: Promise<void> | undefined;
  private stopRequested = false;
  private longPoll: AbortController | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: ConsumerQueues,
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly config: ConsumerConfig,
    private readonly onAction: ConsumerActionListener = () => {},
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopRequested = false;
    this.loop = this.run();
  }

  /** Parada graciosa: não pega mensagens novas, termina a atual e devolve as outras à fila. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.longPoll?.abort(); // interrompe o long polling, que poderia esperar alguns segundos
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopRequested) break;
        // SQS fora do ar, por exemplo: espera um pouco e tenta de novo (o loop nunca morre).
        this.logger.warn({ event: 'sqs_polling_failed', reason: errorMessage(error) });
        await sleep(1_000);
      }
    }
  }

  /** Uma rodada: recebe até 10 mensagens e as trata (wallets diferentes em paralelo). Devolve quantas recebeu. */
  async pollOnce(): Promise<number> {
    this.longPoll = new AbortController();
    let messages: Message[];
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queues.queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.config.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.longPoll.signal },
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (this.stopRequested) return 0; // o abort do stop() cai aqui: não é erro
      throw error;
    }

    // DECISÃO: mensagens de grupos (wallets) DIFERENTES do mesmo lote são tratadas em paralelo;
    //          as do MESMO grupo, uma de cada vez e em ordem.
    // POR QUÊ: o teste de carga mostrou cerca de 32 mensagens/s por instância tratando tudo em
    //          sequência, mesmo quando o lote trazia wallets diferentes, que não disputam nada
    //          entre si. A ordem que importa (dentro da wallet) continua garantida.
    // ALTERNATIVA: tudo em paralelo — não usei porque duas mensagens da mesma wallet poderiam ser
    //              aplicadas fora de ordem (ex.: a aposta de 80 passar na frente da de 30).
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'unknown';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((groupMessages) => this.handleGroup(groupMessages)));
    return messages.length;
  }

  /** Trata as mensagens de UM grupo (uma wallet) em ordem. */
  private async handleGroup(messages: Message[]): Promise<void> {
    for (let i = 0; i < messages.length; i++) {
      if (this.stopRequested) {
        await this.release(messages.slice(i));
        return;
      }

      let action: ConsumerAction | undefined;
      try {
        action = await this.handle(messages[i]!);
      } catch (error) {
        // Ex.: o ack (DeleteMessage) falhou. Não mexemos na mensagem: ela volta sozinha depois do
        // visibility timeout e a inbox garante o replay.
        this.logger.error({ event: 'sqs_ack_failed', sqsMessageId: messages[i]!.MessageId, reason: errorMessage(error) });
      }

      // A mensagem não foi concluída (vai voltar para a fila): as seguintes da MESMA wallet não podem
      // passar na frente dela. Elas voltam para a fila agora; o FIFO só as entrega de novo depois
      // que a que falhou for concluída.
      if (action !== 'acked' && action !== 'dead-lettered') {
        await this.release(messages.slice(i + 1));
        return;
      }
    }
  }

  async handle(message: Message): Promise<ConsumerAction> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    // ---- Mensagem ilegível ou fora do contrato: permanente, vai para a DLQ.
    let command: WagerTransactionCommand;
    let context: ProcessingContext;
    try {
      const envelope = parseWagerTransactionMessage(message.Body);
      command = envelope.data;
      context = {
        correlationId: envelope.messageId,
        inbox: { consumerName: this.config.consumerName, messageId: envelope.messageId, payloadHash: hashJson(envelope.data) },
      };
    } catch (error) {
      return this.deadLetter(message, 'INVALID_MESSAGE', error);
    }

    try {
      await this.processWagerTransaction.execute(command, context);
    } catch (error) {
      if (isPermanent(error)) {
        return this.deadLetter(message, permanentReason(error), error);
      }

      // Transitório (ou inesperado): tenta de novo, até o limite.
      if (receiveCount >= this.config.maxAttempts) {
        try {
          await this.processWagerTransaction.recordFailure(command, context);
        } catch (recordError) {
          this.logger.error({ event: 'record_failed_transaction_failed', messageId: context.inbox!.messageId, reason: errorMessage(recordError) });
        }
        return this.deadLetter(message, 'MAX_ATTEMPTS_EXCEEDED', error);
      }
      return this.scheduleRetry(message, receiveCount, error);
    }

    // Chegou aqui = commit feito (PROCESSED, REJECTED ou PENDING_REFERENCE). Só agora o ack.
    // Fica FORA do try acima: se o ack falhar, não é um erro de processamento e não pode ser
    // tratado como um (não agenda retry nem manda para a DLQ). A mensagem volta sozinha depois do
    // visibility timeout e o replay da inbox não repete o efeito.
    return this.ack(message, context.inbox!.messageId);
  }

  private async ack(message: Message, messageId: string): Promise<ConsumerAction> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queues.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    this.onAction('acked', { messageId });
    return 'acked';
  }

  /** Backoff: a mensagem só volta a ficar visível depois de base * 2^(tentativa-1) segundos. */
  private async scheduleRetry(message: Message, receiveCount: number, error: unknown): Promise<ConsumerAction> {
    const delaySeconds = Math.min(this.config.retryBaseDelaySeconds * 2 ** (receiveCount - 1), this.config.retryMaxDelaySeconds);
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queues.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delaySeconds,
      }),
    );
    this.logger.warn({
      event: 'sqs_retry_scheduled',
      sqsMessageId: message.MessageId,
      attempt: receiveCount,
      maxAttempts: this.config.maxAttempts,
      delaySeconds,
      reason: errorMessage(error),
    });
    this.onAction('retry-scheduled', { messageId: message.MessageId, reason: errorMessage(error) });
    return 'retry-scheduled';
  }

  /**
   * Copia a mensagem para a DLQ (com o motivo) e só então apaga da fila principal. Se o processo
   * morrer entre os dois passos, a mensagem é entregue de novo e vai para a DLQ de novo; o
   * MessageDeduplicationId evita a cópia repetida dentro de 5 minutos.
   */
  private async deadLetter(message: Message, reason: string, error: unknown): Promise<ConsumerAction> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queues.deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          deadLetterReason: { DataType: 'String', StringValue: reason },
          deadLetterError: { DataType: 'String', StringValue: errorMessage(error).slice(0, 256) || reason },
        },
      }),
    );
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queues.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    this.logger.error({ event: 'sqs_message_dead_lettered', sqsMessageId: message.MessageId, reason, error: errorMessage(error) });
    this.onAction('dead-lettered', { messageId: message.MessageId, reason });
    return 'dead-lettered';
  }

  /** Devolve a visibilidade na hora (VisibilityTimeout 0): outra instância pode pegar já. */
  private async release(messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({ QueueUrl: this.queues.queueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0 }),
      );
      this.onAction('released', { messageId: message.MessageId });
    }
  }
}

/** Erros que não adianta tentar de novo: o conteúdo da mensagem é o problema. */
function isPermanent(error: unknown): boolean {
  return error instanceof DomainError || error instanceof IdempotencyConflictError || error instanceof InboxMessageConflictError;
}

function permanentReason(error: unknown): string {
  if (error instanceof IdempotencyConflictError) return 'IDEMPOTENCY_CONFLICT';
  if (error instanceof InboxMessageConflictError) return 'MESSAGE_ID_CONFLICT';
  return 'INVALID_PAYLOAD';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
