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
bun run infra:up              # sobe PostgreSQL e SQS (MiniStack) e espera ficarem saudáveis
bun run migration:up          # cria o schema
bun run start                 # sobe a API em http://localhost:3000
```

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
| `bun run infra:up` / `infra:down` | Sobe / derruba PostgreSQL e SQS |
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
