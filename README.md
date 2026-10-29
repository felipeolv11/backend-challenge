# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas
por HTTP e por SQS, mantendo a correção com mensagens duplicadas, fora de ordem e processadas ao
mesmo tempo por várias instâncias.

- Enunciado: [`CHALLENGE.md`](CHALLENGE.md)
- Decisões técnicas, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Teste de carga (metodologia, resultados e análise): [`LOAD-TEST.md`](LOAD-TEST.md)

## Destaques

- **Dinheiro exato:** `Money` com `bigint` em centavos e `NUMERIC(20,2)` no banco. Nenhum `number`.
- **Concorrência:** lock pessimista por wallet + `version` no UPDATE + `UNIQUE (wallet_id, wallet_version)`
  no ledger. Três camadas, cada uma validada removendo as outras (testes de mutação).
- **Garantias no schema:** saldo ≥ 0, ledger append-only (triggers), estados terminais imutáveis,
  idempotência e "uma reversão por referência" garantidos pelo PostgreSQL.
- **Idempotência persistente:** `Idempotency-Key` + hash SHA-256 do JSON canônico; replay devolve o
  resultado original, inclusive o saldo observado na época.
- **Mensageria:** inbox, Transactional Outbox, retry com backoff, DLQ e desligamento gracioso.
- **Provado com processos reais:** 3 instâncias em paralelo e queda com `kill -9` no meio da carga,
  terminando com saldo = ledger em todas as wallets. Mais de 270 testes contra PostgreSQL e SQS reais
  (sem mocks).
- **Teste de carga:** ~1.270 req/s com p99 de ~100 ms e 0% de erro; os gargalos encontrados foram
  corrigidos e medidos antes e depois ([`LOAD-TEST.md`](LOAD-TEST.md)).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x (testado com 1.4.4)
- [Docker](https://www.docker.com/) com Docker Compose

## Como rodar (desenvolvimento)

```bash
bun install
cp .env.example .env          # no PowerShell: Copy-Item .env.example .env
bun run infra:up              # sobe PostgreSQL e SQS (MiniStack) e cria as filas
bun run migration:up          # cria o schema
bun run start                 # API em http://localhost:3000 (+ workers em segundo plano)
```

## Como rodar o sistema inteiro no Docker (3 instâncias)

Sobe PostgreSQL, SQS, migrations e **3 instâncias** da aplicação (portas 3000, 3001 e 3002), todas
consumindo a mesma fila e usando o mesmo banco:

```bash
docker compose --profile app up -d --build --scale app=3   # ou: bun run stack:up
docker compose --profile app down                          # ou: bun run stack:down
```

> Usa as portas 3000 a 3002: pare o `bun run start` antes, se ele estiver rodando.

## O que roda dentro de cada instância

Além da API HTTP, cada instância roda três workers em segundo plano (cada um pode ser desligado por
variável de ambiente, ver `.env.example`):

- **Consumidor SQS** (`wager-transactions.fifo`): o mesmo caso de uso da API, com inbox, retry com
  backoff e DLQ (`wager-transactions-dlq.fifo`);
- **Publisher da outbox**: publica os eventos de integração em `wager-events.fifo`;
- **Worker de PENDING_REFERENCE**: tenta de novo as transações que esperam a referência.

## API

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | Cria wallet (saldo inicial gera a transação interna `OPENING`) |
| `GET /wallets/:walletId` | Consulta a wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | Extrato paginado por cursor (estável e opaco) |
| `POST /wallets/:walletId/reconciliation` | Compara saldo × ledger (sinaliza divergências, não corrige) |
| `POST /wagering/transactions` (header `Idempotency-Key`) | Submete BET / WIN / LOSS / REFUND / ROLLBACK |
| `GET /wagering/transactions/:transactionId` | Consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por id do provedor |

```bash
curl -X POST localhost:3000/wallets \
  -H "content-type: application/json" \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -X POST localhost:3000/wagering/transactions \
  -H "content-type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id devolvido acima>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Status | Significado | O provedor deve... |
|---|---|---|
| 200 | Processada (nova ou replay, com `idempotentReplay`) | Seguir |
| 202 | Aceita, aguardando a transação referenciada | Esperar |
| 400 | Payload inválido / sem `Idempotency-Key` | Corrigir o pedido |
| 409 | Conflito de idempotência (mesma key, payload diferente) | Investigar; não é replay |
| 422 | Rejeitada por regra de negócio (`failureCode` no corpo) | Decidir pelo `failureCode` |
| 503 | Falha transitória (+ `Retry-After`) | Reenviar com a mesma key |

Tabela de `failureCode` e detalhes em [`ARCHITECTURE.md`](ARCHITECTURE.md#8-taxonomia-de-failurecode-e-mapeamento-de-status-http).

### Enviando pela fila

Formato da seção 10 do enunciado (exemplo com o [AWS CLI](https://aws.amazon.com/cli/); qualquer
cliente SQS serve):

```bash
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"<uuid>","walletId":"<uuid>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

## Observabilidade

| Endpoint | O que mostra |
|---|---|
| `GET /health/live` | Processo vivo |
| `GET /health/ready` | PostgreSQL e SQS alcançáveis (200, ou 503 com o estado de cada um) |
| `GET /metrics` | Métricas Prometheus: transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência |

Os logs saem em JSON (uma linha por evento) com `correlationId`, `messageId`, `transactionId`,
`walletId` e `providerId`, sem valores financeiros.

## Testes

```bash
bun run infra:up                # os testes de integração usam PostgreSQL e SQS reais
bun test                        # tudo (inclui 3 processos reais e queda com kill -9)
bun run test:unit               # só unitários (não precisa de Docker)
bun run test:integration        # só integração
bun run test:load               # teste de carga (~6 min), ver LOAD-TEST.md
```

Os testes de integração usam o PostgreSQL do Docker Compose num banco separado (`wagering_test`),
criado e recriado automaticamente, e filas SQS com nomes únicos por execução. O banco de
desenvolvimento não é tocado. O mapa "cenário da seção 13 → teste" está na
[§11 do `ARCHITECTURE.md`](ARCHITECTURE.md#11-estratégia-de-testes).

## Comandos

| Comando | O que faz |
|---|---|
| `bun run infra:up` / `infra:down` | Sobe PostgreSQL e SQS e cria as filas / derruba os containers |
| `bun run sqs:setup` | Cria as filas SQS (idempotente) |
| `bun run start` / `start:dev` | Sobe a aplicação / recarregando a cada alteração |
| `bun run migration:up` / `migration:down` / `migration:status` | Migrations |
| `bun run stack:up` / `stack:down` | Sistema inteiro no Docker com 3 instâncias |
| `bun run typecheck` | Checagem de tipos (TypeScript estrito) |
| `bun test` / `test:unit` / `test:integration` | Testes |
| `bun run test:load` | Teste de carga (3 instâncias, 3 cenários) |
