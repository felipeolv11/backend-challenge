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
  pelo domínio (`debit`/`credit` sempre devolvem o lançamento), pela transação SQL única e é
  **verificada** pela reconciliação.

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

_(Consumidor, retry e DLQ: a definir na etapa do SQS.)_

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

---

## 5. Concorrência
_(a definir)_

## 6. Idempotência
_(a definir)_

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
_(a definir na etapa da API)_

## 9. Observabilidade
_(a definir)_

## 10. Autenticação
_(a definir)_

## 11. Limitações conhecidas
_(a definir)_
