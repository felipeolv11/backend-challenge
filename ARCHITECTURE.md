# Arquitetura — Distributed Wagering Processor

Este documento registra as decisões técnicas, os trade-offs e as limitações do projeto.
Ele é atualizado a cada etapa. As seções ainda vazias estão marcadas como _(a definir)_.

---

## 1. Visão geral

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
recebidas por HTTP e por SQS, garantindo correção financeira mesmo com mensagens duplicadas,
fora de ordem ou processadas ao mesmo tempo por várias instâncias.

**Princípio central:** o banco de dados (PostgreSQL) é a fonte da verdade. Constraints,
locks e transações do banco garantem as invariantes. O código da aplicação e o SQS
são a primeira linha de defesa, mas não a garantia final.

---

## 2. Estrutura de pastas

```
src/
  domain/          regras de negócio puras (Money, Wallet, WagerTransaction, eventos)
  application/     casos de uso (ex.: processar transação, criar wallet)
  infrastructure/  PostgreSQL (MikroORM, migrations), SQS, workers
  http/            controllers da API
```

**Decisão:** organização **por camada**.
- **Por quê:** deixa visível a regra da seção 6.1 do enunciado (o domínio não depende do ORM
  nem do NestJS), e fica fácil achar as coisas num projeto deste tamanho.
- **Alternativa descartada:** por módulo (`wallet/`, `wagering/`, cada um com suas camadas).
  Escala melhor em sistemas grandes, mas aqui wallet e wagering estão sempre juntos (toda aposta
  mexe na wallet), e separar geraria imports cruzados sem ganho real.
- **Se o projeto crescer:** migrar para módulos quando houver contextos realmente independentes.

---

## 3. Persistência

### 3.1 ORM: MikroORM

- **Por quê:** é o ORM preferencial do enunciado. `em.transactional()` garante atomicidade
  entre wallet, ledger, inbox e outbox. `LockMode` permite `SELECT ... FOR UPDATE`. O Unit of Work
  acumula as mudanças e grava tudo num commit só.
- **Alternativa descartada:** TypeORM. É aceito, mas é mais fácil gravar algo fora da transação
  por esquecer de usar o `manager` dela.

### 3.2 Domínio separado das entidades de banco

As classes de domínio (`Wallet`, `WagerTransaction` etc.) não têm decorators nem tipos do ORM.
Existem classes só de persistência e um **mapper** que converte o registro do banco em objeto
de domínio usando a factory `rehydrate()` (seção 6.0 do enunciado).

- **Alternativa descartada:** mapear as classes de domínio direto no ORM (EntitySchema). Daria
  menos código, mas o ORM criaria os objetos sem passar pelo `rehydrate()`, o que conflita com
  o construtor privado e os campos privados.

### 3.3 Migrations em SQL escrito à mão

Migrations versionadas do MikroORM com `up()` e `down()` em SQL puro, executadas por um script
próprio (`bun run migration:up | migration:down | migration:status`). Cada migration roda dentro
de uma transação.

- **Por quê:** as garantias de unicidade, imutabilidade e não-negatividade precisam estar
  **no schema** (seção 5, item 9). Isso exige CHECK constraints e triggers, que o gerador
  automático não cria. Em SQL, cada constraint fica legível e explicável.
- **Alternativa descartada:** migrations geradas automaticamente. Precisariam ser editadas de
  qualquer jeito.
- **Por que um script próprio e não a CLI do MikroORM:** o script chama `orm.migrator` direto
  e roda igual no Windows e no Linux, sem configuração extra para a CLI rodar TypeScript no Bun.

### 3.4 Mapeamento do `Money`

| Onde | Representação | Exemplo |
|---|---|---|
| Contratos (API, fila, eventos) | `{ amount: string, currency: string }` | `{ "amount": "25.00", "currency": "BRL" }` |
| Memória (`Money`) | `bigint` em centavos + `currency` | `2500n`, `"BRL"` |
| PostgreSQL | coluna `NUMERIC(20,2)` + coluna `currency CHAR(3)` | `25.00`, `BRL` |

O mapper lê o `NUMERIC` como string e passa por `Money.from()`, então o valor nunca vira `number`.

**Memória: `bigint` em centavos.**
- **Por quê:** inteiro exato e nativo, sem dependência. A escala é sempre 2 e o domínio só
  soma e subtrai, então centavos inteiros cobrem tudo **sem nenhum arredondamento**.
- **Alternativa descartada:** lib de decimal (`decimal.js`), sugerida pelo tipo `Decimal` do
  esqueleto. Adicionaria uma dependência e exigiria configurar precisão e arredondamento que
  nunca seriam usados. Além disso, ela aceita `"1e3"`, então a validação por regex seria
  necessária de qualquer forma.

**Banco: `NUMERIC(20,2)`.**
- **Por quê:** decimal exato do PostgreSQL. O valor aparece legível no banco (`975.00`, igual à
  API), e o `CHECK (balance >= 0)` e o `SUM()` da reconciliação ficam naturais.
- **Alternativa descartada:** `BIGINT` em centavos. Evitaria uma conversão, mas no banco aparece
  `97500`, e quem esquece que é centavo erra por 100x.
- O limite de 18 dígitos inteiros do `NUMERIC(20,2)` também é validado no `Money.from()`. Assim,
  um valor grande demais vira erro de validação, e não erro de banco (que seria confundido com
  falha de infraestrutura).

**Formato de entrada estrito: exatamente 2 casas** (regex `^(0|[1-9]\d*)\.\d{2}$`).
- Rejeita `""`, `"NaN"`, `"Infinity"`, `"1e3"`, `"-25.00"`, `"25"`, `"25.5"`, `"25.001"`, `"007.00"` e
  `amount` do tipo `number`.
- **Por quê:** o enunciado diz "recebido sempre com escala fixa de 2 casas". E como `"25"` e
  `"25.00"` teriam hashes de payload diferentes, aceitar os dois transformaria um reenvio legítimo
  em conflito de idempotência.
- **Alternativa descartada:** aceitar de 0 a 2 casas e normalizar. Exigiria normalizar antes do
  hash de idempotência, mais um ponto de falha.

**Negativos:** `Money.from()` rejeita valores negativos (contrato de entrada). Valores negativos
só surgem de operações internas, como `negate()` ou a diferença da reconciliação, e são
serializados com sinal (`"-0.05"`).

**Moeda:** valida o formato ISO-4217 (3 letras maiúsculas). Operações entre moedas diferentes
lançam `CurrencyMismatchError`. O projeto usa `BRL`, mas o modelo é multi-moeda.

### 3.5 Schema, constraints e índices

Migration: `src/infrastructure/database/migrations/Migration20261029120000_initial_schema.ts`.
Cada garantia abaixo é testada em `test/integration/database/schema.test.ts` **com SQL direto no
PostgreSQL real**, sem passar pelo domínio: o banco recusa sozinho.

| Garantia (seção 6) | Onde está no banco |
|---|---|
| Saldo nunca negativo | `wallets_balance_non_negative` CHECK; `ledger_balances_non_negative`; `wager_tx_balance_after_non_negative` |
| Uma wallet por player + moeda | `wallets_player_currency_unique` UNIQUE |
| `version` sobe 1 só quando o saldo muda | trigger `wallets_guard_update` |
| Aritmética do lançamento | `ledger_arithmetic` CHECK (antes ± valor = depois) |
| Um lançamento por transação por wallet | `ledger_one_entry_per_transaction_per_wallet` UNIQUE |
| Corrente do ledger sem bifurcação (lost update) | `ledger_one_entry_per_wallet_version` UNIQUE `(wallet_id, wallet_version)`, da migration 2 (ver §5.1) |
| Ledger imutável | triggers `ledger_append_only` (UPDATE/DELETE) e `ledger_no_truncate` |
| Idempotência | `wager_tx_provider_idempotency_key_unique` e `wager_tx_provider_external_id_unique` |
| Uma reversão por referência (regra 4) | índice único parcial `wager_tx_one_reversal_per_reference` |
| Estados terminais não mudam | trigger `wager_tx_guard_update` |
| Dados do pedido imutáveis | trigger `wager_tx_guard_update` |
| Transações e wallets não são apagadas | triggers `wager_tx_no_delete`, `wager_tx_no_truncate`, `wallets_no_delete` |
| Inbox: dedup por `(consumer, messageId)` | `inbox_messages_pkey` |
| Coerência status ⇄ campos | `wager_tx_failure_code_iff_failed`, `wager_tx_processed_at_iff_processed`, `wager_tx_processed_has_balance_after` |
| Taxonomia fechada | `wager_tx_kind_valid`, `wager_tx_status_valid`, `wager_tx_failure_code_valid` |

**Decisões do schema:**
- **Imutabilidade por trigger** (e não por `REVOKE`): vale para qualquer cliente (app, script,
  DBeaver) e funciona com um único usuário de banco. Alternativa descartada: dois usuários de
  banco com permissões diferentes, que dá mais configuração e não protege contra o usuário dono.
- **`TEXT + CHECK` em vez de `ENUM` do Postgres:** adicionar ou remover valores é uma migration
  simples e reversível.
- **Idempotência única por provider:** dois provedores podem usar a mesma `Idempotency-Key`
  sem colidir, e a mesma transação externa com outra key é barrada.
- **`balance_after` na transação:** guarda o saldo observado ao processar/rejeitar, para o replay
  idempotente (regra 7). Alternativa descartada: snapshot JSON da resposta HTTP, que misturaria o
  formato da API com o dado financeiro.
- **Sem FK de `wager_transactions.wallet_id` para `wallets`:** uma transação `WALLET_NOT_FOUND`
  também é gravada (auditoria e replay). O ledger tem FK para os dois.
- **`reference_transaction_id` obrigatório em reversões `PROCESSED`:** sem isso, um `NULL`
  escaparia do índice único de reversão.
- **Constraints com nome explícito:** a aplicação identifica qual regra foi violada pelo nome
  (ex.: `wallets_player_currency_unique` → 409).
- **Trade-off:** o banco não verifica que `wallets.balance` é igual ao último `balance_after` do
  ledger (isso exigiria um trigger entre tabelas a cada operação). Essa consistência é garantida
  pelo domínio (`debit`/`credit` sempre devolvem o lançamento), pela transação SQL única, pela
  corrente `UNIQUE (wallet_id, wallet_version)` e é **verificada** pela reconciliação.
- **Migration 2 (`ledger_wallet_version`)** mostra uma evolução de schema com **backfill**: os
  lançamentos existentes são numerados pela ordem dos ids (UUID v7). Como o ledger não aceita
  UPDATE, o trigger é desligado **só durante o backfill**, dentro da transação da migration, e o
  teste confirma que ele volta ligado.

**Banco de teste:** os testes de integração usam o PostgreSQL do Compose num banco separado
(`wagering_test`), criado automaticamente e recriado do zero (migrations) a cada arquivo. Alternativa
descartada: Testcontainers (dependência nova, mais lento, mais pontos de falha no Windows com Bun).

### 3.6 Conexão com o banco é "preguiçosa"

O MikroORM 7 só abre a conexão na primeira consulta. O serviço **sobe mesmo com o PostgreSQL
fora do ar**, o que está de acordo com a seção 3 do enunciado ("PostgreSQL pode ficar
temporariamente indisponível"). A indisponibilidade é sinalizada pelo `GET /health/ready`.

---

## 4. Mensageria (SQS)

### 4.1 Emulador: MiniStack

- **Por quê:** o enunciado aceita LocalStack ou MiniStack. Desde março de 2026, o LocalStack exige
  conta e auth token, então o avaliador também precisaria de um. Com o MiniStack, basta
  `docker compose up`.
- **Risco e mitigação:** é um projeto novo. Antes de adotá-lo, validei com o SDK oficial da AWS:
  filas FIFO, deduplicação, ordem por `MessageGroupId`, `ApproximateReceiveCount` e redrive
  para a DLQ. Tudo funcionou.

### 4.2 Consumidor, inbox, retry e DLQ

**Inbox (`InboxMessage`):** registro único por `(consumerName, messageId)`, gravado **na mesma
transação SQL** da alteração financeira. Se a mesma mensagem chegar de novo (at-least-once,
crash entre o commit e o ack), o registro já existe e o efeito não se repete.

**Mesmo `messageId` com conteúdo diferente** (hash do payload diferente) é tratado como **erro
permanente e vai para a DLQ**. Indica bug do produtor; mandar para a DLQ não aplica nada por engano
e não descarta nada em silêncio.
- **Alternativa descartada:** ignorar como duplicata. Uma operação legítima com conteúdo novo
  seria descartada sem ninguém saber.

**Filas** (criadas pelo script idempotente `bun run sqs:setup`, que também roda como serviço
de uma execução só no Docker Compose):

| Fila | Para quê |
|---|---|
| `wager-transactions.fifo` | Entrada das transações. `RedrivePolicy` com `maxReceiveCount = 6` |
| `wager-transactions-dlq.fifo` | Mensagens que não podem ser processadas |
| `wager-events.fifo` | Saída dos eventos de integração (publisher da outbox) |

- **Por que um script e não a aplicação criando as filas:** criar fila é infraestrutura (em
  produção seria Terraform); a aplicação normalmente não tem essa permissão.
- **Recomendação ao produtor:** `MessageGroupId = walletId`. Assim o FIFO entrega em ordem por
  wallet, o que é uma **otimização**: a correção é garantida pelo banco, mesmo fora de ordem.

**Consumidor** (`src/infrastructure/sqs/wager-transaction-consumer.ts`):
- Usa **o mesmo caso de uso** do HTTP (`ProcessWagerTransaction`), com o registro de inbox na
  mesma transação SQL.
- **ack somente após o commit:** `DeleteMessage` só é chamado depois que `execute()` retorna, e
  fica **fora** do `try` do processamento. Se o ack falhar, a mensagem volta sozinha (visibility
  timeout) e a inbox devolve o replay, sem efeito duplicado.
- Mensagens de um lote são tratadas **em sequência** (ordem dentro do grupo FIFO). O paralelismo
  vem de várias instâncias e grupos diferentes.

| Tipo de erro | Exemplos | Ação |
|---|---|---|
| Negócio | REJECTED (sem saldo, referência inválida...) | Não é erro: o resultado está gravado. **ack** |
| Transitório | Banco fora, `lock_timeout`, rede, erro inesperado | `ChangeMessageVisibility` com backoff **2s, 4s, 8s, 16s** (teto de 60s) |
| Transitório na 5ª tentativa | idem | Grava a transação como **FAILED** (`PROCESSING_ERROR`, auditável) e manda para a **DLQ** (`MAX_ATTEMPTS_EXCEEDED`) |
| Permanente | JSON inválido, fora do contrato, payload inválido, conflito de idempotência, mesmo messageId com outro conteúdo | **DLQ na hora**, com o motivo em `MessageAttributes` |

- **Por que backoff pela visibilidade e não só a RedrivePolicy:** com a RedrivePolicy pura, o
  intervalo seria sempre o mesmo, erro permanente gastaria todas as tentativas e não existiria o
  registro FAILED auditável. A RedrivePolicy (6) fica como **rede de segurança**, para o caso do
  processo morrer em loop numa mensagem.
- **Ida para a DLQ:** copia para a DLQ e depois apaga da fila principal. Se morrer no meio, a
  mensagem volta e vai para a DLQ de novo; o `MessageDeduplicationId` evita a cópia repetida.
- **SIGTERM:** `enableShutdownHooks` + `beforeApplicationShutdown`. O consumidor para de pegar
  mensagens (aborta o long polling), **termina a mensagem em andamento** (commit + ack) e devolve a
  visibilidade das que ainda não começou (`VisibilityTimeout = 0`), para outra instância pegar
  na hora. Isso roda **antes** de o NestJS fechar o banco.

**Testado contra o SQS real** (`test/integration/messaging/sqs-consumer.test.ts`): duplicata,
**worker morto depois do commit e antes do ack** (redelivery real após o visibility timeout, sem
débito duplo), DLQ para cada tipo de erro permanente, retry com backoff, FAILED + DLQ no limite
e parada graciosa.

### 4.3 Transactional Outbox

O evento é gravado na tabela de outbox **na mesma transação SQL** do saldo, ledger e inbox. Um
worker separado publica os pendentes. O `id` da mensagem de outbox **é o `eventId`**: qualquer
republicação usa o mesmo id, e o consumidor deduplica por ele.

**Política de retry da publicação: infinita, com backoff exponencial e teto.** A espera é de 1s,
2s, 4s, 8s... até 5 minutos e, a partir daí, uma tentativa a cada 5 minutos, para sempre.
- **Por quê:** o enunciado proíbe perder eventos confirmados, e nunca desistir garante isso. O teto
  evita esperas enormes quando o SQS volta. Eventos presos aparecem nas métricas (outbox lag e
  tentativas).
- **Alternativa descartada:** limite de tentativas e evento "dead". Um SQS fora do ar por algumas
  horas estacionaria eventos válidos, que dependeriam de reprocessamento manual.
- **Sem jitter:** cálculo determinístico, fácil de testar. Publishers concorrentes não disputam o
  mesmo evento porque travam as linhas que pegam _(etapa do worker)_.

**Eventos (`IntegrationEvent<T>`):** classe abstrata com o envelope do enunciado e uma subclasse
por evento. `eventType` e `version` ficam **no tipo**. `data` só tem tipos JSON (`MoneyProps` como
string, datas ISO-8601, `null` em vez de `undefined` para o formato ser estável) e é congelado.

| Evento | `aggregateId` | Quando |
|---|---|---|
| `WagerTransactionProcessed` | id da transação | Qualquer transação aplicada, inclusive LOSS. Leva o saldo logo após a aplicação |
| `WagerTransactionRejected` | id da transação | Rejeição por regra de negócio, com `failureCode` |
| `WagerTransactionPendingReference` | id da transação | Referência ausente |
| `WalletBalanceChanged` | id da wallet | **Somente** quando há lançamento no ledger. Leva saldo antes/depois e `walletVersion` |

Cada factory `from()` confere o estado da origem (ex.: `WagerTransactionProcessed` exige transação
`PROCESSED`; `WalletBalanceChanged` exige que o lançamento corresponda ao saldo atual da wallet).
Criar evento a partir de estado errado é bug (`InvalidEventSourceError`).

**Publisher** (`src/application/publish-outbox.ts` + `SqsEventPublisher`):
- Pega um lote com `SELECT ... FOR UPDATE SKIP LOCKED`, publica, marca `published_at` e faz
  commit, numa transação. **Vários publishers concorrentes** dividem o trabalho: um pula as linhas
  travadas pelo outro. Testado: dois publishers simultâneos, cada evento publicado **exatamente uma vez**.
- Publica em `wager-events.fifo` com `MessageGroupId = walletId` (ordem por wallet) e
  `MessageDeduplicationId = eventId`.
- **Cenário da seção 11** (testado): commit feito → processo morre antes de publicar → outra
  instância publica. E se morrer **depois** de publicar e **antes** de marcar: o evento é
  republicado com o **mesmo `eventId`**. O SQS FIFO descarta a cópia em 5 minutos (otimização) e o
  consumidor deve deduplicar pelo `eventId` (garantia).
- **Alternativa descartada:** reserva por coluna `locked_until` (lease), que adicionaria mais
  estados sem ganho aqui.
- **Trade-off:** a transação fica aberta durante a chamada ao SQS (o lote é pequeno: 10). E a
  ordem entre eventos da mesma wallet é **best-effort**: se um evento falhar e o seguinte não, o
  seguinte pode sair antes. Por isso o `WalletBalanceChanged` leva `walletVersion`, e o
  consumidor pode ordenar por ela.

### 4.4 Workers em segundo plano

Os três workers (consumidor SQS, publisher da outbox e worker de PENDING_REFERENCE) rodam
**dentro do processo da API** e podem ser desligados por variável de ambiente
(`ENABLE_SQS_CONSUMER`, `ENABLE_OUTBOX_PUBLISHER`, `ENABLE_PENDING_REFERENCE_WORKER`).
Com N instâncias, há N de cada, e o banco garante que não se atrapalham. A subida da API não
espera o SQS: as filas são procuradas em segundo plano até aparecerem. Quando um lote vem cheio, o
worker roda de novo na hora, sem esperar o intervalo.

### 4.5 Referências fora de ordem (worker de PENDING_REFERENCE, seção 7.1)

- Transação com referência ausente (ou ainda não terminal) fica `PENDING_REFERENCE`, com
  `reference_attempts` e `next_reference_attempt_at` (migration 3).
- O worker busca as vencidas e trata cada uma numa transação: **trava a wallet** (mesma ordem de
  lock do caso de uso, sem deadlock), **relê** a transação (outra instância pode ter tratado) e
  reaproveita a decisão do `WagerTransactionProcessor`.
- **Limite: 10 novas tentativas, backoff 2s, 4s, 8s... com teto de 5 min (cerca de 18 minutos no
  total).** Referências fora de ordem costumam chegar em segundos; 18 minutos cobrem atrasos longos
  sem deixar a transação pendurada por horas. Configurável por variável de ambiente.
  Alternativa descartada: TTL fixo sem backoff, que consulta o banco no mesmo ritmo o tempo todo.
- Esgotou: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.
- Testado: REFUND antes da BET, ROLLBACK antes do WIN, esgotamento do limite e **3 workers
  simultâneos** sobre a mesma pendente (processada uma vez só).

---

## 5. Concorrência

**Unidade de concorrência: a wallet.** Cada operação roda numa transação SQL (READ COMMITTED)
e começa travando **só a linha da wallet** envolvida. Não existe lock global.

### 5.1 Três camadas de proteção contra lost update

| Camada | Onde | O que faz |
|---|---|---|
| 1. Lock pessimista | `WalletRepository.findByIdForUpdate()` → `SELECT ... FOR UPDATE` | A 2ª operação na mesma wallet **espera** a 1ª terminar e já lê o saldo atualizado. É a proteção do dia a dia: não há colisão nem retry |
| 2. Checagem de version | `WalletRepository.updateBalance()` → `UPDATE ... WHERE id = ? AND version = ?` | Se a wallet mudou entre a leitura e a gravação, nenhuma linha é afetada e a operação falha (`ConcurrencyConflictError`, transitório) |
| 3. Corrente do ledger no banco | `UNIQUE (wallet_id, wallet_version)` em `wallet_ledger_entries` (migration 2) | Cada lançamento guarda a version da wallet depois dele. Dois lançamentos "continuando" do mesmo ponto são recusados **pelo banco**, mesmo sem as camadas 1 e 2 |

**Por que lock pessimista (e não as alternativas):**
- **Lock otimista com retry:** no cenário obrigatório de 50 apostas iguais em paralelo na
  mesma wallet, quase todas conflitariam e entrariam em retry; esgotar os retries vira erro
  para o provedor. O lock pessimista simplesmente enfileira.
- **UPDATE condicional (`balance >= valor`):** rápido, mas a regra do saldo sairia da classe
  `Wallet` e iria para o SQL, e o `wallet.debit()` deixaria de ser usado no caminho principal.
- **Trade-off aceito:** numa wallet muito disputada ("hot wallet"), as operações entram em fila.
  Continuam corretas; só não ficam paralelas *dentro da mesma wallet*. Wallets diferentes seguem
  100% em paralelo.

**`lock_timeout = 5s`** (`SET LOCAL` em cada transação): uma transação não espera um lock para
sempre. Estourou, vira `TransientInfrastructureError` (HTTP 503 / a mensagem da fila volta para retry).

**Deadlock:** cada operação trava uma única wallet, então não há espera circular entre wallets.

### 5.2 Como foi provado (testes de mutação)

Os testes de concorrência (`test/integration/concurrency/`) usam paralelismo real: `Promise.all`,
cada chamada na sua transação e na sua conexão do pool do Postgres. Foram executados com
proteções removidas de propósito:

| Mutação | Resultado |
|---|---|
| Nenhuma | 15/15 passam |
| Sem lock (camada 1) | A camada 2 segura: as operações concorrentes falham com `ConcurrencyConflictError`, e **nenhum dado errado é gravado** |
| Sem lock e sem checagem de version (1 e 2), **antes** da camada 3 | **Lost update real:** as duas apostas de 80 foram aceitas com saldo 100. Nenhum CHECK ou trigger percebia, porque cada linha, sozinha, estava certa. Isso motivou a camada 3 |
| Sem lock e sem checagem de version, **com** a camada 3 | O banco recusa o lançamento duplicado; o caso de uso tenta de novo e rejeita com `INSUFFICIENT_FUNDS`. 12/15 passam; os 3 que falham (disputa pesada, segunda colisão no retry único) falham com **erro**, nunca com saldo errado |

### 5.3 Ordem das gravações na transação

1. `SELECT ... FOR UPDATE` na wallet;
2. inbox (se veio da fila): já existe?;
3. idempotência: a transação já existe?;
4. decisão (domínio) → `INSERT` da transação → `INSERT` do lançamento → `UPDATE` da wallet
   (com version) → `INSERT` dos eventos na outbox → `INSERT` da inbox;
5. commit.

## 6. Idempotência

**A chave é o header `Idempotency-Key`** (fonte da verdade), única **por provider** no banco.
A mesma transação externa (`providerId + externalTransactionId`) também é única.

**Hash do payload** (`src/application/payload-hash.ts`): **SHA-256 (hex) de um JSON canônico**,
com chaves ordenadas em todos os níveis, contendo só os campos de negócio: `providerId`,
`externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
`money.amount`, `money.currency` e `referenceExternalTransactionId` (`null` se ausente).
O header e metadados de transporte (messageId, occurredAt) ficam de fora.

| Situação | Resultado |
|---|---|
| Mesma key + mesmo hash | **Replay:** devolve o resultado original (status, `failureCode` e o saldo observado **naquele momento**, coluna `balance_after`) com `idempotentReplay: true`. Nada é gravado de novo |
| Mesma key + hash diferente | `IdempotencyConflictError`: conflito, **não** replay |
| Mesmo `externalTransactionId` + key diferente | `IdempotencyConflictError` |
| Duas requisições iguais ao mesmo tempo | O lock da wallet serializa: a 2ª só olha a idempotência depois do commit da 1ª e vê o replay. Sem wallet para travar (`WALLET_NOT_FOUND`), a 2ª bate na constraint UNIQUE (`DuplicateRecordError`); o caso de uso tenta de novo **uma vez** e encontra o replay |

**Nada de cache em memória:** toda a deduplicação é feita por constraints e consultas no PostgreSQL.

**Teste:** a mesma aposta enviada 50 vezes em paralelo gera 1 transação, 1 débito e 49 replays
idênticos (inclusive o saldo observado).

### 6.1 Organização da camada de aplicação (portas)

O caso de uso (`ProcessWagerTransaction`) depende só de **interfaces** (`src/application/ports.ts`):
`WalletRepository`, `WagerTransactionRepository`, `LedgerRepository`, `InboxRepository`,
`OutboxRepository` e `TransactionRunner`. A infraestrutura implementa com MikroORM
(`src/infrastructure/database/`).

- **Por quê:** o caso de uso tem só regra de negócio, sem SQL nem ORM, e a fronteira entre camadas
  fica explícita. O teste de atomicidade troca a porta da outbox por uma que falha.
- **Alternativa descartada:** o caso de uso usar o `EntityManager` direto, o que acoplaria a
  application ao ORM.

**Gravação com comandos explícitos** (`em.insert` / `em.nativeUpdate`), na ordem das FKs,
dentro de `em.transactional()`. As leituras usam `disableIdentityMap`, então nada é gravado
"por baixo".
- **Alternativa descartada:** Unit of Work (`persist` + `flush`). A ordem e o controle da version
  ficariam implícitos, e o versionamento automático do ORM incrementaria a version uma segunda vez.

**Entidades de banco com `defineEntity`** (recomendado pelo MikroORM 7, sem dependência extra).
Os valores `NUMERIC` chegam como **string** e vão direto para `Money.from()`.

**`WagerTransactionProcessor`** separa a **decisão** (PROCESSED / REJECTED / PENDING_REFERENCE)
do caso de uso, para ser reutilizado pelo worker de referências pendentes.

## 7. Modelo de domínio e transições de estado

Todas as classes de domínio usam construtor privado + factories estáticas (`create`/`open`/`from`
para criar com validação, `rehydrate` para reconstruir do banco sem revalidar).

### 7.1 `Wallet` (aggregate root) e `WalletLedgerEntry`

**A única forma de mudar o saldo é `debit()` / `credit()`, e ambos devolvem o lançamento do ledger.**
Não existe caminho em que o saldo muda sem um lançamento, nem na abertura: `Wallet.open()` devolve
`{ wallet, openingEntry }`, com o lançamento CREDIT da transação `OPENING` quando o saldo inicial
é maior que zero.

- **Alternativa descartada:** a `Wallet` devolver `void` e o caso de uso montar o lançamento. Daria
  classes mais independentes, mas a consistência saldo ⇄ ledger dependeria de quem chama
  lembrar de criar o lançamento.

**Regras garantidas na `Wallet`:**
- O valor da movimentação precisa ser > 0 e estar na moeda da wallet (`CurrencyMismatchError`).
  Movimentar zero geraria um lançamento vazio e um `version++` sem mudança de saldo.
- Débito maior que o saldo lança `InsufficientBalanceError`, e o estado não muda.
- `version` começa em 1 na abertura e incrementa a cada `debit`/`credit` bem-sucedido. Como o
  valor é sempre > 0, todo movimento aceito muda o saldo.
- O lançamento é criado **antes** de alterar o estado. Se a criação falhar, a wallet fica intacta.

**Erros como exceção:** saldo insuficiente lança `InsufficientBalanceError`. O caso de uso
captura e escolhe o `failureCode`: aposta sem saldo e reversão que deixaria o saldo negativo
recebem códigos diferentes (regra 9 da seção 7 do enunciado).
- **Alternativa descartada:** devolver `{ ok, error }`. Misturaria dois estilos de erro (o `Money`
  já lança exceção) e deixaria cada chamada mais verbosa.

**`WalletLedgerEntry` é imutável de forma estrutural:** só campos `readonly`, nenhum método que
altere estado, e `Object.freeze(this)` no construtor (o `readonly` só existe no TypeScript;
o `freeze` vale em runtime). `create()` valida que o valor é > 0, que os saldos não são negativos,
que as moedas batem e que `balanceBefore ± money === balanceAfter`. `rehydrate()` não valida:
um dado inconsistente no banco deve ser **detectado pela reconciliação**, não quebrar a leitura.

**Defesa em camadas contra saldo negativo:** (1) `Wallet.debit()` checa o saldo; (2)
`WalletLedgerEntry.create()` recusa `balanceAfter` negativo; (3) `CHECK (balance >= 0)` no banco
_(etapa do schema)_. Um teste de mutação (remover a checagem 1) confirmou que a camada 2 segura
o saldo e que os testes detectam a regressão.

### 7.2 `WagerTransaction`: estados e transições

```
PENDING ──► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
PROCESSED, REJECTED, FAILED: terminais (nenhuma transição)
```

Qualquer outra transição lança `InvalidTransactionStateError`. Ele herda de `ProgrammingError`,
**não** de `DomainError`: tentar mudar uma transação terminal é bug nosso (deve virar 500), não
erro do provedor (4xx). O mesmo vale para `InvalidLedgerEntryError`.

| Kind | Valor aceito | Referência | Efeito no saldo |
|---|---|---|---|
| `BET` | > 0 | não usa | DEBIT |
| `WIN` | ≥ 0 | opcional; se vier, deve ser uma `BET` | CREDIT (0.00 não move saldo) |
| `LOSS` | ≥ 0 | opcional; se vier, deve ser uma `BET` | nenhum |
| `REFUND` | > 0, igual ao da referência | obrigatória; só `BET` | CREDIT |
| `ROLLBACK` | > 0, igual ao da referência | obrigatória; `BET`, `WIN` ou `REFUND` | inverso da referência |
| `OPENING` | > 0 | — (interno, não pode ser submetido) | CREDIT |

**Erros de payload × rejeição de negócio:**
- `InvalidWagerTransactionError`: o payload não faz sentido (REFUND sem referência, BET de 0.00,
  kind `OPENING`). A transação **não é persistida**.
- `WagerRuleViolationError(failureCode)`: o payload é válido, mas viola uma regra (referência de
  outra rodada, valor diferente da referência...). A transação é **persistida como `REJECTED`**,
  com o `failureCode`, e fica auditável.

**`OPENING` é interno:** é criado por `WagerTransaction.opening()`, nunca por `create()`. Já nasce
`PROCESSED` porque é aplicado na mesma transação SQL que cria a wallet. Os campos de provedor
recebem valores fixos (`providerId = "internal"`, `externalTransactionId = "opening:{walletId}"`).

### 7.3 Interpretações adotadas (o enunciado pede para documentar)

1. **Uma reversão por referência, no total (regra 4).** O texto diz "não pode ser revertida duas
   vezes pelo **mesmo tipo** de operação". Lido ao pé da letra, uma BET de 80 aceitaria um REFUND
   (+80) **e** um ROLLBACK (+80): crédito duplicado, que é falha eliminatória. Por isso cada
   transação pode ser revertida **uma única vez**, por REFUND ou por ROLLBACK. Encadear continua
   permitido: `BET → REFUND → ROLLBACK do REFUND`. Garantia no banco: índice único parcial em
   `reference_transaction_id` para reversões `PROCESSED` _(etapa do schema)_.
2. **Referência opcional de WIN/LOSS é validada quando vier.** Mesmas regras de contexto (provider,
   player, wallet, moeda e rodada) e deve apontar para uma `BET`. Se a BET ainda não chegou, o WIN
   fica `PENDING_REFERENCE`: um prêmio nunca é pago antes da aposta existir. O valor do WIN pode ser
   diferente do da BET (o prêmio não é a aposta).
3. **Valores:** BET, REFUND e ROLLBACK exigem > 0. WIN e LOSS aceitam 0.00 (WIN 0.00 é comum para
   fechar uma rodada sem prêmio). WIN 0.00 e LOSS ficam `PROCESSED` sem lançamento e sem
   `version++`. Consequência: o ROLLBACK de um WIN de 0.00 não é possível (ROLLBACK exige > 0 e
   valor igual ao da referência), o que faz sentido porque não há nada a desfazer.
4. **Referência `REJECTED`/`FAILED`:** não há o que reverter, então `REFERENCE_NOT_PROCESSED`.
   **Referência ainda `PENDING`/`PENDING_REFERENCE`:** a transação aguarda (`PENDING_REFERENCE`),
   como se a referência não tivesse chegado.
5. **Uma transação não pode referenciar a si mesma:** payload inválido.

**Ids vêm de fora:** o caso de uso gera os ids (UUID v7) e os passa ao domínio. Assim o domínio não
depende do runtime e os testes usam ids previsíveis.

## 8. Taxonomia de `failureCode` e mapeamento de status HTTP

### 8.1 `failureCode`

Códigos estáveis e legíveis por máquina (`src/domain/failure-code.ts`). São **contrato público**:
nunca são renomeados, só adicionados.

- **Formato:** lista simples em MAIÚSCULAS. Alternativa descartada: códigos hierárquicos
  (`BALANCE.INSUFFICIENT_FUNDS`), porque o prefixo não muda a decisão do provedor.

| Código | Status | Quando | O que o provedor deve fazer |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | BET maior que o saldo | Não reenviar; informar o jogador |
| `REVERSAL_WOULD_OVERDRAW` | REJECTED | REFUND/ROLLBACK deixaria o saldo negativo (ex.: rollback de um WIN já apostado) | Não reenviar; tratar manualmente (caso operacional, diferente de aposta sem saldo) |
| `CURRENCY_MISMATCH` | REJECTED | Moeda diferente da moeda da wallet | Corrigir o payload |
| `WALLET_NOT_FOUND` | REJECTED | Wallet inexistente | Corrigir o payload |
| `PLAYER_WALLET_MISMATCH` | REJECTED | Wallet de outro player | Corrigir o payload |
| `REFERENCE_NOT_FOUND` | REJECTED | Referência não chegou dentro do limite de tentativas | Enviar a referência e depois uma nova reversão, com novo id |
| `REFERENCE_MISMATCH` | REJECTED | Referência de outro provider/player/wallet/moeda/rodada | Corrigir o payload |
| `INVALID_REFERENCE_KIND` | REJECTED | Tipo de referência não permitido | Corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | Referência terminou REJECTED/FAILED | Não reenviar; não há o que reverter |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | Referência já revertida | Não reenviar |
| `AMOUNT_MISMATCH` | REJECTED | Valor da reversão ≠ valor da referência | Corrigir o valor |
| `PROCESSING_ERROR` | FAILED | Erro inesperado que persistiu após os retries | Contatar o operador; a transação fica auditável |

### 8.2 Status HTTP

O mesmo mapeamento em todos os endpoints (`src/http/error-filter.ts` e `wagering.controller.ts`).
O provedor decide o que fazer **só pelo status**:

| Status | Quando | O provedor deve... |
|---|---|---|
| 200 | Transação `PROCESSED` (nova ou replay) | Nada. Seguir |
| 201 | Wallet criada | Nada |
| 202 | `PENDING_REFERENCE`: aceita, aguardando a referência | Esperar o evento (ou consultar depois). **Não** reenviar outro id |
| 400 | Payload inválido, `Idempotency-Key` ausente, cursor inválido | **Corrigir** o pedido. Reenviar igual não adianta |
| 404 | Recurso não encontrado (GETs) | Conferir o id |
| 409 | Conflito de idempotência / wallet já existe | **Não** é replay: investigar (mesma key usada para outra coisa) |
| 422 | `REJECTED` por regra de negócio; o corpo traz `transactionId` e `failureCode` | Decidir pelo `failureCode` (tabela 8.1). Reenviar igual devolve o mesmo 422 |
| 503 | Falha transitória (banco fora, lock demorou) + `Retry-After: 1` | **Reenviar com a mesma `Idempotency-Key`** |
| 500 | Bug nosso | Avisar o operador; reenviar com a mesma key é seguro |

- **Replay devolve o mesmo status do original** (200 → 200, 422 → 422), com `idempotentReplay: true`.
- **Erros** têm sempre o formato `{ "error": { "code", "message", "details"? }, "correlationId" }`.
- **Alternativa descartada:** 200 para tudo que foi gravado (PROCESSED/REJECTED/PENDING), que
  obrigaria o provedor a ler o corpo para saber se foi rejeitado.
- **Validação:** zod valida a forma (tipos, obrigatórios, tamanhos, UUIDs); as regras de valor
  (formato do `amount`, moeda, `kind`) ficam no domínio, a única fonte da verdade. Alternativas
  descartadas: class-validator + class-transformer (duas dependências e metadados de tipo) e
  validação à mão (código repetitivo).

### 8.3 Paginação do extrato

`GET /wallets/:id/ledger?cursor=...&limit=50` usa **keyset pelo id** (UUID v7, ordenado pelo
tempo): `WHERE wallet_id = ? AND id > ? ORDER BY id LIMIT ?`, em ordem cronológica. O cursor é o id
do último item em base64url (opaco, com prefixo de versão `v1:`). É **estável**: lançamentos novos
entram no fim e não deslocam páginas já lidas (testado). Busca `limit + 1` para saber se há
próxima página sem `COUNT`.
- **Alternativa descartada:** `OFFSET`, que não é estável e fica lento com offsets grandes.

### 8.4 Reconciliação

`POST /wallets/:id/reconciliation` trava a wallet (para ler saldo e ledger no mesmo instante), soma
créditos e débitos **no banco** (NUMERIC, exato) e compara. Divergência é **sinalizada**
(`consistent: false`, `difference`) e **não é corrigida**. O aviso para log e métrica é feito por um
listener (`DivergenceListener`) _(log estruturado e métrica: etapa de observabilidade)_.

## 9. Observabilidade

### 9.1 Health checks (abertos, sem autenticação)

| Endpoint | Responde |
|---|---|
| `GET /health/live` | 200 se o processo está vivo. **Não** olha dependências: reiniciar o processo não conserta um banco fora do ar |
| `GET /health/ready` | 200 se PostgreSQL (`SELECT 1`) e SQS (`GetQueueUrl`) respondem; senão **503** com o estado de cada um. Cada verificação tem timeout de 2s, para uma dependência travada não travar o health |

Feitos à mão (cerca de 40 linhas). Alternativa descartada: `@nestjs/terminus`, que é mais uma
dependência e não tem verificação pronta para SQS.

### 9.2 Logs estruturados

Logger JSON embutido do NestJS (`ConsoleLogger({ json: true })`), sem dependência nova. Cada
linha é um JSON; os eventos de negócio são objetos com campo `event`:

```json
{"level":"log","context":"WagerTransaction","message":{"event":"wager_transaction_handled",
 "correlationId":"...","messageId":"...","providerId":"provider-a","externalTransactionId":"...",
 "walletId":"...","transactionId":"...","kind":"BET","status":"PROCESSED","failureCode":null,
 "idempotentReplay":false,"durationMs":12}}
```

- Campos de rastreio: `correlationId` (header `X-Correlation-Id` ou gerado; na fila, o
  `messageId`), `messageId`, `transactionId`, `walletId`, `providerId`.
- **Sem dados sensíveis nem payload financeiro:** valores e saldos **não** são logados (há um
  teste que captura o stdout e confere isso). A exceção é a diferença de uma divergência na
  reconciliação, necessária para o diagnóstico.
- Eventos logados: transação tratada/falhou, retry agendado, mensagem na DLQ, falha de ack,
  falha de publicação da outbox, divergência de reconciliação e falha de rodada de worker.
- Alternativa descartada: pino + nestjs-pino (duas dependências, por uma performance que não
  precisamos).

### 9.3 Métricas (`GET /metrics`, formato Prometheus, `prom-client`)

| Métrica (seção 12) | Nome |
|---|---|
| Transações por status | `wagering_transactions_total{status,kind,source}` (só transações novas) |
| Duplicatas detectadas | `wagering_duplicates_detected_total{source,reason}` (`idempotent_replay` no HTTP, `redelivery` na fila) |
| Retries | `wagering_retries_total{component}` (`sqs_consumer`, `outbox_publisher`, `pending_reference_worker`) |
| Mensagens em DLQ | `wagering_dlq_messages_total{reason}` |
| Conflitos de lock | `wagering_lock_conflicts_total{type}` (`lock_timeout`, `deadlock`, `version_conflict`, `duplicate_key`) |
| Outbox lag | `wagering_outbox_lag_seconds` (idade do evento pendente mais antigo, lida do banco a cada coleta) e `wagering_outbox_pending_events` |
| Latência de processamento | `wagering_processing_duration_seconds{source,outcome}` (histograma: p50/p95/p99) |
| Extras | `wagering_reconciliation_divergences_total`, `wagering_pending_reference_outcomes_total{outcome}`, `wagering_outbox_events_published_total`, métricas padrão do processo |

- Cada app tem o seu `Registry` (e não o global), para os testes subirem mais de um app no mesmo processo.
- A instrumentação do processamento fica numa subclasse do caso de uso
  (`ObservedProcessWagerTransaction`, na infraestrutura): a application continua só com regra de
  negócio, e HTTP e fila recebem a versão observada sem mudar nada.
- O `/metrics` está aberto; em produção, ficaria numa porta ou rede interna.
- Alternativa descartada: contadores próprios em JSON (histograma à mão, formato não lido por
  nenhuma ferramenta).

## 10. Autenticação

**Não implementada**, como a seção 2 permite: ela não vale pontos, e o tempo foi para correção
financeira, concorrência e idempotência. O **ponto de extensão** está no código:
`src/http/auth.guard.ts`, um `AuthGuard` no-op aplicado aos controllers de wallets e wagering.

**Desenho que eu adotaria:**
1. **Keycloak** no Docker Compose. Cada provedor é um *client* OAuth2 com **client credentials**.
2. O provedor obtém um JWT e o envia em `Authorization: Bearer <token>`.
3. O `AuthGuard` valida assinatura (JWKS do Keycloak), expiração, `iss` e `aud`.
4. O `providerId` vem do token (ex.: claim `azp`) e fica na requisição.
5. O controller confere que o `providerId` do **payload** é o do **token** (senão 403): um
   provedor não lança transações em nome de outro.
6. Health checks ficam abertos. A fila é canal interno confiável, mas o `providerId` da mensagem
   continua passando pelas mesmas validações de domínio.

**Alternativa descartada agora:** integrar o Keycloak. Consumiria boa parte do prazo em algo que
não pontua.

## 11. Estratégia de testes

Todos os testes de integração usam **PostgreSQL e SQS (MiniStack) reais**; nenhum mock de banco ou
fila. Todo teste de integração e concorrência termina conferindo a invariante
`wallet.balance == saldo reconstruído pelo ledger` (`expectWalletMatchesLedger`). As proteções mais
importantes também foram validadas por **testes de mutação** (remover a proteção e ver o teste falhar).

| Seção 13 | Onde |
|---|---|
| Unidade: `Money`, `Wallet`, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, idempotência | `test/unit/domain/` |
| Migrations e constraints | `test/integration/database/schema.test.ts` (SQL direto contra o banco, incluindo down/up e backfill) |
| Atomicidade entre wallet, ledger, inbox e outbox | `test/integration/application/process-wager-transaction.test.ts` |
| Inbox e redelivery; retry e DLQ | `test/integration/messaging/sqs-consumer.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `test/integration/messaging/outbox-publisher.test.ts` |
| Recuperação após reinicialização | `test/integration/multi-instance/multi-instance.test.ts` |
| **Concorrência 1:** mesma aposta 50x em paralelo | `concurrency/same-wallet.test.ts` e `multi-instance.test.ts` (espalhada por 3 processos) |
| **Concorrência 2:** saldo 100, duas apostas de 80 | `concurrency/same-wallet.test.ts` (repetido 10x) |
| **Concorrência 3:** wallets distintas em paralelo | `concurrency/same-wallet.test.ts` |
| **Concorrência 4:** ≥ 3 processos simultâneos | `multi-instance.test.ts`: 3 processos `bun run src/main.ts`, HTTP + fila, com duplicatas |
| **Concorrência 5:** worker morto depois do commit e antes do ack | `sqs-consumer.test.ts` (redelivery real após o visibility timeout) |
| **Concorrência 6:** dois publishers sobre a mesma outbox | `outbox-publisher.test.ts` |
| **Concorrência 7:** ROLLBACK/REFUND antes da referência | `pending-reference-worker.test.ts` e `multi-instance.test.ts` |
| **Concorrência 8:** reinício do serviço com consistência final | `multi-instance.test.ts`: **kill -9** de uma instância e depois de todas, no meio de 410 mensagens; 3 instâncias novas concluem tudo |
| API HTTP, status e observabilidade | `test/integration/http/` |
| Fluxo completo com os workers ligados | `test/integration/e2e/full-flow.test.ts` |

**Teste de queda (item 8), em números típicos:** o serviço cai com ~110 de 410 transações gravadas.
As instâncias novas concluem as ~300 restantes, e no fim: cada mensagem virou **exatamente uma**
transação e um registro de inbox, os saldos batem com o ledger, os REFUNDs pendentes atravessaram a
queda e foram processados, e **todo evento confirmado no banco chegou à fila de eventos**.

**Docker Compose com várias instâncias:** `bun run stack:up` sobe infraestrutura + migrations +
3 instâncias da aplicação (portas 3000 a 3002), usando o `Dockerfile` (imagem do Bun, sem build).

## 12. Limitações conhecidas
_(a definir)_
