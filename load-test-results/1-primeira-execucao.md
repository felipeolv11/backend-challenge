# Resultado do teste de carga — 2026-10-29T18:17:02.609Z

## Ambiente

- **date:** 2026-10-29T18:17:02.609Z
- **os:** win32 10.0.26300
- **cpu:** Intel(R) Core(TM) i5-14600KF (20 threads)
- **memoryGb:** 32
- **bun:** 1.4.4
- **postgres:** 18.4
- **setup:** 3 instâncias (processos) + PostgreSQL e MiniStack em containers Docker na mesma máquina; 50 usuários virtuais

## Resultados

| Cenário | Requisições | Throughput (/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Rejeições de negócio | Conflitos de lock | Outbox lag máx (s) | Outbox pendentes máx | Outbox esvaziou em (s) | Saldo = ledger |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Distribuído (HTTP, 500 wallets) | 22628 | 1129 | 37.6 | 86.5 | 101.5 | 260.8 | 0% | 0 | 0 | 20.31 | 45580 | 265.4 | ✅ |
| Hot wallet (HTTP, 1 wallet) | 3001 | 197 | 253.2 | 311.5 | 331.5 | 403.9 | 0% | 0 | 0 | 12.11 | 4774 | 47.9 | ✅ |
| Fila SQS (3 consumidores) | 3000 | 96 | 15765 | 28445 | 29529 | 29926 | 0% | 0 | 0 | 15.72 | 3174 | 24.4 | ✅ |

**Distribuído (HTTP, 500 wallets):** status {"200":22628}. Apostas de 1.00 em wallets aleatórias: pouca disputa pelo mesmo lock.

**Hot wallet (HTTP, 1 wallet):** status {"200":3001}. Todas as requisições na MESMA wallet: o lock pessimista as coloca em fila (custo esperado da escolha).

**Fila SQS (3 consumidores):** status {"PROCESSED":3000}. Latência = do envio ao SQS até a transação gravada no banco (inclui o tempo na fila). Taxa de erro = mensagens que foram para a DLQ.
