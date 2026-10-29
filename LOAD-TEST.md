# Teste de carga

```bash
bun run infra:up
bun run test:load       # ~6 minutos; resultado em load-test-results/last-run.md e .json
```

Resumo: a aplicação sustentou **~1.270 req/s com p99 de ~100 ms e 0% de erro** no cenário
distribuído, e **saldo = ledger em todas as wallets** e **nenhum evento perdido** em todos os cenários.
O teste encontrou **três gargalos da aplicação**, que foram corrigidos e medidos antes e depois, e
mostrou que **o emulador de SQS (MiniStack) é o teto** de tudo o que passa pela fila neste ambiente.
Os números de fila **não representam o SQS real**, e o motivo está medido abaixo.

---

## 1. Ambiente

| Item | Valor |
|---|---|
| Máquina | Intel Core i5-14600KF (20 threads), 32 GB RAM |
| Sistema | Windows 11 Pro; Docker Desktop (WSL 2) |
| Runtime | Bun 1.4.4 |
| Banco | PostgreSQL 18.4 (container, configuração padrão) |
| SQS | MiniStack 1.5.34 (emulador, container) |
| Topologia | **Tudo na mesma máquina**: gerador de carga + 3 instâncias da aplicação + PostgreSQL + MiniStack disputam a mesma CPU |

## 2. Metodologia

- **3 instâncias reais** da aplicação (processos `bun run src/main.ts`, cada uma com API + consumidor
  SQS + publisher da outbox + worker de pendentes), banco próprio (`wagering_load`) e filas próprias,
  todos **recriados do zero** a cada execução.
- **Carga em loop fechado:** 50 usuários virtuais, cada um envia uma requisição, espera a resposta e
  envia a próxima, alternando entre as 3 instâncias. 3 segundos de aquecimento (fora da medição).
- **Latência** medida pelo cliente, por requisição; p50/p95/p99 calculados sobre todas as amostras.
- **Erro** = 5xx, 503 ou erro de rede. 422 (rejeição de negócio) **não** é erro.
- **Conflitos de lock** e **outbox lag** vêm do `/metrics` das instâncias (amostrado a cada 500 ms).
- **Consumidor de eventos:** 4 leitores consomem `wager-events.fifo` durante todo o teste, como um
  sistema real faria, e conferem que **todo evento gravado na outbox chegou** (por `eventId`).
- **Invariante final:** em todas as wallets do banco, `saldo == ledger reconstruído`.

| Cenário | O que exercita |
|---|---|
| **Distribuído** | 20 s de apostas de 1.00 em 500 wallets aleatórias: o caso normal, com pouca disputa por lock |
| **Hot wallet** | 15 s de apostas na **mesma** wallet: o custo do lock pessimista |
| **Fila** | 3.000 mensagens em 200 wallets, enfileiradas de uma vez e consumidas pelas 3 instâncias |

## 3. Resultados (código final)

Arquivo: [`load-test-results/3-depois-das-otimizacoes.md`](load-test-results/3-depois-das-otimizacoes.md)

| Cenário | Throughput | p50 | p95 | p99 | Erros | Conflitos de lock | Outbox lag máx | Saldo = ledger |
|---|---|---|---|---|---|---|---|---|
| Distribuído (HTTP) | **1.267 req/s** | 29,5 ms | 85,2 ms | 100,9 ms | 0% | 0 | 18,3 s ⚠️ | ✅ |
| Hot wallet (HTTP) | **202 req/s** | 242 ms | 307 ms | 336 ms | 0% | 0 | 12,5 s | ✅ |
| Fila (publisher ligado) | **63 msg/s** ⚠️ | 20,6 s* | 37,8 s* | 39,4 s* | 0% (nenhuma DLQ) | 0 | 5,0 s | ✅ |

\* Na fila, a latência vai do envio ao SQS até a transação gravada, e é quase toda **tempo de espera na
fila**: as 3.000 mensagens foram enfileiradas de uma vez.

**Eventos:** 70.042 gravados na outbox → **70.042 `eventId` distintos recebidos** pelo consumidor de
eventos. Nenhum perdido, nenhuma repetição observada.

## 4. Análise

### 4.1 API e correção sob carga ✅
- ~1.270 req/s com p99 de ~100 ms, 0% de erro e **saldo = ledger em todas as wallets** após ~31 mil
  transações concorrentes, em 3 processos.
- **Conflitos de lock = 0** em todos os cenários. Esperado: com lock pessimista as operações
  **esperam a vez** em vez de conflitar. `version_conflict = 0` confirma que nenhuma escrita tentou
  passar por cima de outra, e não houve `lock_timeout` (o limite é 5 s).

### 4.2 Hot wallet: o custo do lock pessimista, medido ✅
- ~200 req/s numa única wallet ≈ 1 transação a cada ~5 ms, uma de cada vez.
- A latência bate com a **Lei de Little**: 50 usuários / 202 req/s ≈ **247 ms**, e o p50 medido foi
  **242 ms**. Ou seja, a latência é fila no lock, não lentidão do código.
- Esse é o trade-off documentado no `ARCHITECTURE.md` §5: correto, mas sem paralelismo **dentro** da
  mesma wallet. Na prática, uma wallet é de um jogador, e 200 apostas por segundo de um mesmo jogador
  não é um cenário realista. Se fosse, as alternativas seriam reduzir o tempo dentro do lock ou mover o
  trabalho não financeiro (eventos, por exemplo) para fora dele.

### 4.3 Outbox e fila: o teto é o emulador ⚠️

No cenário distribuído, a API gera ~2.500 eventos/s, mas a outbox publica bem menos: o lag chega a
~18 s e leva minutos para esvaziar depois da carga. A investigação, medida passo a passo:

| Medição | Resultado |
|---|---|
| Publisher **sozinho**, fila de eventos vazia | ~1.670 eventos/s por publisher |
| 1 instância publicando (app real) | 1.560 eventos/s |
| **3 instâncias** publicando juntas | **1.740 eventos/s**: quase não escala |
| MiniStack: 20 envios "em paralelo" | 19 ms, o mesmo que 20 em sequência: **atende uma chamada por vez** |
| MiniStack: custo de enviar × tamanho da fila | **3,6 ms → 38 ms** por lote de 10, de 0 para 40 mil mensagens na fila |

**Conclusão:** neste ambiente, o MiniStack é um recurso **serial** cujo custo **cresce com o tamanho da
fila**. Ele limita o publisher, e o publisher e os consumidores **disputam a mesma "fila de
atendimento"** do emulador: com o publisher **desligado**, o consumidor processa **689 msg/s**; com o
publisher ligado, cai para 63 a 100 msg/s. Num SQS real (serviço distribuído, sem esse custo por
tamanho de fila), essa disputa não existe. **Não afirmo números para o SQS real**: isso exigiria
medir lá.

## 5. Gargalos encontrados e corrigidos (antes × depois)

Para uma comparação justa, o **código antigo** (commit `bca7a0f`) foi medido com **o mesmo teste de
carga** final. Arquivos: [`2-antes-das-otimizacoes.md`](load-test-results/2-antes-das-otimizacoes.md) e
[`3-depois-das-otimizacoes.md`](load-test-results/3-depois-das-otimizacoes.md).

| # | Gargalo | Correção | Medição isolada |
|---|---|---|---|
| 1 | A consulta que pega o lote da outbox lia a tabela inteira e ordenava todos os pendentes a cada lote (`Seq Scan` + `Sort`) | Índice parcial `(occurred_at, id) WHERE published_at IS NULL` (migration 4) | `EXPLAIN ANALYZE` com 40 mil pendentes: **13,5 ms → 0,085 ms** (~160x) |
| 2 | Publisher enviava **um evento por chamada** ao SQS | `SendMessageBatch` (10 por chamada), lote de 100 por transação, lotes em sequência para manter a ordem por wallet; falha parcial tratada mensagem a mensagem | ~1.670 eventos/s por publisher |
| 3 | Consumidor tratava as 10 mensagens do lote **uma de cada vez**, mesmo sendo de wallets diferentes | Wallets diferentes em paralelo; a mesma wallet continua em ordem | Só o consumidor (publisher desligado), 2 execuções cada: **322 → 689 msg/s** (2,1x); p99 **8,4 s → 3,3 s** |

**Bug de ordem encontrado no caminho:** se a 1ª mensagem de uma wallet falhava de forma transitória,
o consumidor antigo processava a 2ª **da mesma wallet** antes dela. O saldo continuava correto (o banco
garante), mas o resultado podia inverter: com saldo 100, uma aposta de 30 seguida de uma de 80 podia
virar "80 aprovada, 30 recusada". Agora as seguintes voltam para a fila atrás da que falhou. Há um teste
para isso, e um teste de mutação confirmou que ele pega a regressão.

**Ponta a ponta (com tudo ligado), antes × depois:**

| Cenário | Antes | Depois | Leitura |
|---|---|---|---|
| Distribuído: API | 1.139 req/s, p99 107 ms | 1.267 req/s, p99 101 ms | Parecido (dentro da variação) |
| Distribuído: outbox esvaziou em | 252 s | 290 s | Parecido: limitado pelo MiniStack (§4.3) |
| Hot wallet | 202 req/s, p50 240 ms | 202 req/s, p50 242 ms | Igual (limitado pelo lock, como esperado) |
| Fila: outbox esvaziou em | 22,4 s | **2,8 s** | ✅ 8x |
| Fila: vazão do consumidor | 100 msg/s | 63 msg/s | ❌ Pior: o publisher mais rápido disputa o MiniStack com os consumidores (§4.3) |

Registro também o que **não** melhorou: com o emulador como recurso serial compartilhado, acelerar
o publisher tirou capacidade dos consumidores. Mantive as três correções porque cada uma melhora o que
mede **isoladamente** e porque nenhuma delas depende do emulador para estar certa. A disputa observada
é do ambiente de teste.

## 6. Limitações do experimento

- **Tudo na mesma máquina:** gerador de carga, 3 instâncias, banco e emulador disputam a CPU.
- **MiniStack não é o SQS:** serial e com custo que cresce com o tamanho da fila (medido).
- **Loop fechado:** com 50 usuários, a carga se ajusta à velocidade do sistema, então ela não mede
  o comportamento sob uma taxa de chegada fixa acima da capacidade ("coordinated omission"). Para isso,
  seria preciso um gerador de taxa constante (loop aberto).
- **Durações curtas** (15 a 20 s por cenário). Não é um teste de resistência (horas).
- **PostgreSQL e pool de conexões com configuração padrão**, sem tuning.
- **Uma execução** completa antes e outra depois. As medições isoladas do consumidor foram repetidas
  (2x cada, variação abaixo de 1%).

## 7. Arquivos

- `test/load/load-test.ts`: o teste de carga. Opções de diagnóstico: `LOAD_SCENARIOS=distributed,hot,queue`
  e `LOAD_OUTBOX_PUBLISHER=false`.
- `test/load/sqs-latency.ts`: latência de cada tipo de chamada ao SQS.
- `load-test-results/1-primeira-execucao.md`: a 1ª execução, que revelou os gargalos (sem o consumidor
  de eventos; por isso não é comparável com as outras).
- `load-test-results/2-antes-das-otimizacoes.md` e `3-depois-das-otimizacoes.md`: a comparação justa.
