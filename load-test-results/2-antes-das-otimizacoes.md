# Resultado do teste de carga — 2026-10-29T18:39:03.081Z

## Ambiente

- **date:** 2026-10-29T18:39:03.081Z
- **os:** win32 10.0.26300
- **cpu:** Intel(R) Core(TM) i5-14600KF (20 threads)
- **memoryGb:** 32
- **bun:** 1.4.4
- **postgres:** 18.4
- **setup:** 3 instâncias (processos) + PostgreSQL e MiniStack em containers Docker na mesma máquina; 50 usuários virtuais; consumidor da fila de eventos ligado
- **events:** 64978 eventos gravados na outbox; 64978 eventIds distintos recebidos na fila de eventos (64978 mensagens, incluindo repetições)

## Resultados

| Cenário | Requisições | Throughput (/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Rejeições de negócio | Conflitos de lock | Outbox lag máx (s) | Outbox pendentes máx | Outbox esvaziou em (s) | Saldo = ledger |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Distribuído (HTTP, 500 wallets) | 22845 | 1139 | 35.5 | 89.5 | 106.7 | 160.8 | 0% | 0 | 0 | 20.45 | 46348 | 251.6 | ✅ |
| Hot wallet (HTTP, 1 wallet) | 3078 | 202 | 240.4 | 318.2 | 338.4 | 370 | 0% | 0 | 0 | 11.91 | 4818 | 48.7 | ✅ |
| Fila SQS (3 consumidores) | 3000 | 100 | 15621 | 27552 | 28588 | 28904 | 0% | 0 | 0 | 14.71 | 3130 | 22.4 | ✅ |

**Distribuído (HTTP, 500 wallets):** status {"200":22845}. Apostas de 1.00 em wallets aleatórias: pouca disputa pelo mesmo lock.

**Hot wallet (HTTP, 1 wallet):** status {"200":3078}. Todas as requisições na MESMA wallet: o lock pessimista as coloca em fila (custo esperado da escolha).

**Fila SQS (3 consumidores):** status {"PROCESSED":3000}. Latência = do envio ao SQS até a transação gravada no banco (inclui o tempo na fila). Taxa de erro = mensagens que foram para a DLQ.
