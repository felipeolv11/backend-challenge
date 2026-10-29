import { InvalidMessageStateError } from './errors';
import type { IntegrationEvent } from './events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

// DECISÃO: retry infinito com backoff exponencial e teto: 1s, 2s, 4s, 8s... até 5 minutos,
//          e a partir daí uma tentativa a cada 5 minutos, para sempre.
// POR QUÊ: o enunciado proíbe perder eventos confirmados. Nunca desistir garante isso; o teto
//          evita esperas absurdas quando o SQS volta. Eventos presos aparecem nas métricas
//          (outbox lag e tentativas), que servem de alerta.
// ALTERNATIVA: limite de tentativas e marcar o evento como "dead" — não usei porque um SQS fora
//              do ar por algumas horas estacionaria eventos válidos, que dependeriam de alguém
//              reprocessar à mão.
// Sem jitter (aleatoriedade): o cálculo fica determinístico e fácil de testar. Vários publishers
// não disputam o mesmo evento porque cada um trava as linhas que pegou (ver o worker da outbox).
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60 * 1_000;

/**
 * Evento de integração gravado na MESMA transação SQL da alteração financeira.
 * Um worker separado publica os pendentes. Se o processo morrer antes de publicar, outra
 * instância publica depois. Publicar duas vezes é seguro: o consumidor deduplica pelo eventId
 * (que é o próprio id desta mensagem).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: assim o consumidor deduplica pelo mesmo id em qualquer reenvio. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    // nextAttemptAt = occurredAt: o evento já está pronto para a primeira tentativa.
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, payload, event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com o horário da próxima tentativa já alcançado. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda a próxima tentativa: 1s, 2s, 4s... com teto de 5 minutos. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + OutboxMessage.retryDelayMs(this._attempts));
  }

  /** Espera depois da tentativa número `attempt` (1, 2, 3...). */
  static retryDelayMs(attempt: number): number {
    // 2 ** grande vira Infinity, e o Math.min devolve o teto: não tem como estourar.
    return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Outbox message ${this.id} is already published`);
    }
  }
}
