import { InvalidMessageStateError } from './errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro de "esta mensagem da fila já foi tratada por este consumidor".
 * A chave é (consumerName, messageId), única no banco. É gravada na MESMA transação SQL que
 * altera o saldo: se a mensagem chegar de novo (at-least-once), o banco já sabe que ela foi
 * processada, e o efeito não se repete.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`Inbox message ${this.consumerName}/${this.messageId} is already processed`);
    }
    this._processedAt = at;
  }

  // DECISÃO: mesmo messageId com hash diferente é tratado como erro permanente (vai para a DLQ).
  // POR QUÊ: indica bug do produtor (reusou um messageId para outra operação). Mandar para a DLQ
  //          não aplica nada por engano, não descarta nada em silêncio e deixa a mensagem
  //          disponível para investigação.
  // ALTERNATIVA: ignorar como duplicata comum — não usei porque uma operação legítima, com
  //              conteúdo novo, seria descartada sem ninguém saber.
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
