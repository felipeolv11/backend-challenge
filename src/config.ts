// Configuração lida das variáveis de ambiente, num lugar só, com valores padrão para rodar
// localmente com o docker-compose. Os testes passam valores próprios (filas com nomes únicos,
// tempos curtos) direto para as classes, sem mexer aqui.

function text(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

export interface SqsConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface QueueNames {
  wagerQueue: string;
  wagerDeadLetterQueue: string;
  eventsQueue: string;
}

export interface ConsumerConfig {
  consumerName: string;
  /** Tentativas para erro transitório antes de FAILED + DLQ. */
  maxAttempts: number;
  /** Backoff entre tentativas: base * 2^(tentativa-1), em segundos, com teto. */
  retryBaseDelaySeconds: number;
  retryMaxDelaySeconds: number;
  /** Long polling: quanto tempo o ReceiveMessage espera por mensagens. */
  waitTimeSeconds: number;
}

export interface OutboxPublisherConfig {
  batchSize: number;
  pollIntervalMs: number;
}

export interface PendingReferenceConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
  pollIntervalMs: number;
}

export function loadSqsConfig(): SqsConfig {
  return {
    endpoint: text('SQS_ENDPOINT', 'http://localhost:4566'),
    region: text('AWS_REGION', 'us-east-1'),
    accessKeyId: text('AWS_ACCESS_KEY_ID', 'test'),
    secretAccessKey: text('AWS_SECRET_ACCESS_KEY', 'test'),
  };
}

export function loadQueueNames(): QueueNames {
  return {
    wagerQueue: text('WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
    wagerDeadLetterQueue: text('WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
    eventsQueue: text('EVENTS_QUEUE_NAME', 'wager-events.fifo'),
  };
}

export function loadConsumerConfig(): ConsumerConfig {
  return {
    consumerName: text('CONSUMER_NAME', 'wager-transactions-consumer'),
    maxAttempts: integer('CONSUMER_MAX_ATTEMPTS', 5),
    retryBaseDelaySeconds: integer('CONSUMER_RETRY_BASE_DELAY_SECONDS', 2),
    retryMaxDelaySeconds: integer('CONSUMER_RETRY_MAX_DELAY_SECONDS', 60),
    waitTimeSeconds: integer('CONSUMER_WAIT_TIME_SECONDS', 5),
  };
}

export function loadOutboxPublisherConfig(): OutboxPublisherConfig {
  return {
    batchSize: integer('OUTBOX_BATCH_SIZE', 10),
    pollIntervalMs: integer('OUTBOX_POLL_INTERVAL_MS', 500),
  };
}

export function loadPendingReferenceConfig(): PendingReferenceConfig {
  return {
    maxAttempts: integer('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
    baseDelayMs: integer('PENDING_REFERENCE_BASE_DELAY_MS', 2_000),
    maxDelayMs: integer('PENDING_REFERENCE_MAX_DELAY_MS', 5 * 60 * 1_000),
    batchSize: integer('PENDING_REFERENCE_BATCH_SIZE', 20),
    pollIntervalMs: integer('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
  };
}

export function loadWorkerFlags() {
  return {
    sqsConsumer: flag('ENABLE_SQS_CONSUMER', true),
    outboxPublisher: flag('ENABLE_OUTBOX_PUBLISHER', true),
    pendingReferenceWorker: flag('ENABLE_PENDING_REFERENCE_WORKER', true),
  };
}
