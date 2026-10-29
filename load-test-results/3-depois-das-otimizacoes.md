# Resultado do teste de carga — 2026-10-29T18:46:37.349Z

## Ambiente

- **date:** 2026-10-29T18:46:37.349Z
- **os:** win32 10.0.26300
- **cpu:** Intel(R) Core(TM) i5-14600KF (20 threads)
- **memoryGb:** 32
- **bun:** 1.4.4
- **postgres:** 18.4
- **setup:** 3 instâncias (processos) + PostgreSQL e MiniStack em containers Docker na mesma máquina; 50 usuários virtuais; consumidor da fila de eventos ligado
- **events:** 70042 eventos gravados na outbox; 70042 eventIds distintos recebidos na fila de eventos (70042 mensagens, incluindo repetições)

## Resultados

| Cenário | Requisições | Throughput (/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Rejeições de negócio | Conflitos de lock | Outbox lag máx (s) | Outbox pendentes máx | Outbox esvaziou em (s) | Saldo = ledger |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Distribuído (HTTP, 500 wallets) | 25387 | 1267 | 29.5 | 85.2 | 100.9 | 124.5 | 0% | 0 | 0 | 18.28 | 46692 | 290.4 | ✅ |
| Hot wallet (HTTP, 1 wallet) | 3077 | 202 | 242.1 | 306.8 | 335.6 | 409.4 | 0% | 0 | 0 | 12.45 | 5050 | 37.6 | ✅ |
| Fila SQS (3 consumidores) | 3000 | 63 | 20562 | 37806 | 39412 | 39865 | 0% | 0 | 0 | 5.04 | 654 | 2.8 | ✅ |

**Distribuído (HTTP, 500 wallets):** status {"200":25387}. Apostas de 1.00 em wallets aleatórias: pouca disputa pelo mesmo lock.

**Hot wallet (HTTP, 1 wallet):** status {"200":3077}. Todas as requisições na MESMA wallet: o lock pessimista as coloca em fila (custo esperado da escolha).

**Fila SQS (3 consumidores):** status {"PROCESSED":3000}. Latência = do envio ao SQS até a transação gravada no banco (inclui o tempo na fila). Taxa de erro = mensagens que foram para a DLQ.
