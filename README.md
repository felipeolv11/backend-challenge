# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK)
com correção sob concorrência, idempotência persistente e mensageria confiável.

- Enunciado do desafio: [`CHALLENGE.md`](CHALLENGE.md)
- Decisões técnicas e trade-offs: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- [Docker](https://www.docker.com/) com Docker Compose

## Como rodar

```bash
bun install
cp .env.example .env          # no PowerShell: Copy-Item .env.example .env
bun run infra:up              # sobe PostgreSQL e SQS (MiniStack) e cria as filas
bun run migration:up          # cria o schema
bun run start                 # sobe a API em http://localhost:3000
```

## O que roda dentro do processo

Além da API HTTP, cada instância roda três workers em segundo plano (cada um pode ser desligado
por variável de ambiente, ver `.env.example`):

- **Consumidor SQS** (`wager-transactions.fifo`): mesmo caso de uso da API, inbox, retry com
  backoff e DLQ (`wager-transactions-dlq.fifo`);
- **Publisher da outbox**: publica os eventos de integração em `wager-events.fifo`;
- **Worker de PENDING_REFERENCE**: tenta de novo as transações que esperam a referência.

Para enviar uma transação pela fila (formato da seção 10 do enunciado):

```bash
aws --endpoint-url http://localhost:4566 sqs send-message   --queue-url http://localhost:4566/000000000000/wager-transactions.fifo   --message-group-id <walletId> --message-deduplication-id msg-123   --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{...}}'
```

## Observabilidade

| Endpoint | O que mostra |
|---|---|
| `GET /health/live` | Processo vivo |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis (200 ou 503 com o estado de cada um) |
| `GET /metrics` | Métricas no formato Prometheus (transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência) |

Os logs saem em JSON (uma linha por evento) com `correlationId`, `messageId`, `transactionId`,
`walletId` e `providerId`, sem valores financeiros. Detalhes em
[`ARCHITECTURE.md`](ARCHITECTURE.md#9-observabilidade).

## API

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | Cria wallet (saldo inicial gera transação `OPENING`) |
| `GET /wallets/:walletId` | Consulta wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Extrato paginado por cursor |
| `POST /wallets/:walletId/reconciliation` | Compara saldo × ledger |
| `POST /wagering/transactions` (header `Idempotency-Key`) | Submete BET / WIN / LOSS / REFUND / ROLLBACK |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |

Exemplo:

```bash
curl -X POST localhost:3000/wagering/transactions   -H "content-type: application/json"   -H "Idempotency-Key: provider-a:transaction-123"   -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Status HTTP: 200 processada · 202 aguardando referência · 400 payload inválido · 409 conflito de
idempotência · 422 rejeitada por regra de negócio (`failureCode` no corpo) · 503 falha transitória
(reenviar com a mesma key). Detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md#8-taxonomia-de-failurecode-e-mapeamento-de-status-http).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run infra:up` / `infra:down` | Sobe PostgreSQL e SQS e cria as filas / derruba tudo |
| `bun run sqs:setup` | Cria as filas SQS (idempotente) |
| `bun run start` | Sobe a aplicação |
| `bun run start:dev` | Sobe a aplicação recarregando a cada alteração |
| `bun run migration:up` | Aplica as migrations pendentes |
| `bun run migration:down` | Desfaz a última migration |
| `bun run migration:status` | Lista migrations executadas e pendentes |
| `bun run typecheck` | Checagem de tipos (TypeScript estrito) |
| `bun test` | Roda todos os testes (precisa de `infra:up`) |
| `bun run test:unit` | Só os testes unitários (não precisa de Docker) |
| `bun run test:integration` | Só os testes de integração (PostgreSQL real) |

> Os testes de integração usam o PostgreSQL do Docker Compose, num banco separado (`wagering_test`),
> criado automaticamente e recriado do zero a cada arquivo de teste. O banco de desenvolvimento não é tocado.
