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
_(a definir na etapa do schema)_

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
_(a definir)_

### 4.3 Transactional Outbox
_(a definir)_

---

## 5. Concorrência
_(a definir)_

## 6. Idempotência
_(a definir)_

## 7. Modelo de domínio e transições de estado
_(a definir)_

## 8. Taxonomia de `failureCode` e mapeamento de status HTTP
_(a definir)_

## 9. Observabilidade
_(a definir)_

## 10. Autenticação
_(a definir)_

## 11. Limitações conhecidas
_(a definir)_
