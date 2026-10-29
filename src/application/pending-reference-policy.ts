// DECISÃO: transações PENDING_REFERENCE são tentadas de novo até 10 vezes, com backoff
//          exponencial (2s, 4s, 8s... com teto de 5 min): ao todo, cerca de 18 minutos.
// POR QUÊ: referências fora de ordem normalmente chegam em segundos (corrida entre fila, HTTP e
//          instâncias). Cerca de 18 minutos cobre atrasos longos de provedor sem deixar uma
//          transação pendurada por horas. O backoff evita consultar o banco no mesmo ritmo o tempo todo.
//          Tudo é configurável por variável de ambiente (os testes usam valores pequenos).
// ALTERNATIVA: TTL fixo (ex.: 30 min, tentando a cada X segundos) — não usei porque, sem
//              backoff, consulta o banco no mesmo ritmo durante todo o período.

export interface PendingReferencePolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultPendingReferencePolicy: PendingReferencePolicyOptions = {
  maxAttempts: 10,
  baseDelayMs: 2_000,
  maxDelayMs: 5 * 60 * 1_000,
};

export class PendingReferencePolicy {
  constructor(private readonly options: PendingReferencePolicyOptions = defaultPendingReferencePolicy) {}

  /** Quando fazer a nova tentativa de número `attempt` (1, 2, 3...). */
  nextAttemptAt(now: Date, attempt: number): Date {
    const delay = Math.min(this.options.baseDelayMs * 2 ** (attempt - 1), this.options.maxDelayMs);
    return new Date(now.getTime() + delay);
  }

  /** As novas tentativas já feitas esgotaram o limite? */
  isExhausted(attemptsMade: number): boolean {
    return attemptsMade >= this.options.maxAttempts;
  }
}
