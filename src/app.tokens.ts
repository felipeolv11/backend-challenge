// Tokens de injeção de dependência do NestJS para o que não é classe (interfaces, configuração).
// Ficam num arquivo próprio para evitar import circular (app.module ⇄ controllers).
export const TRANSACTION_RUNNER = Symbol('TRANSACTION_RUNNER');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const QUEUE_NAMES = Symbol('QUEUE_NAMES');
