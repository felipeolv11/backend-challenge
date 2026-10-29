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
| `bun test` | Roda os testes |
