import { CurrencyMismatchError, InsufficientBalanceError, InvalidMoneyError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id da transação interna OPENING. Só é usado se o saldo inicial for maior que zero. */
  openingTransactionId: string;
  /** Id do lançamento CREDIT da abertura. Só é usado se o saldo inicial for maior que zero. */
  openingEntryId: string;
  at: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** Lançamento CREDIT da abertura; undefined quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate root: a única forma de mudar o saldo é por debit() e credit(), que sempre
 * devolvem o lançamento do ledger correspondente.
 *
 * Os ids vêm de fora (o caso de uso gera com Bun.randomUUIDv7()) para o domínio não depender
 * do runtime e para os testes conseguirem usar ids previsíveis.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  // DECISÃO: open() devolve a wallet E o lançamento CREDIT da abertura.
  // POR QUÊ: assim não existe nenhum caminho em que o saldo muda sem a Wallet criar o lançamento,
  //          nem na abertura. A invariante "saldo ⇄ ledger" fica garantida pela própria classe.
  // ALTERNATIVA: open() devolver só a Wallet (como no esqueleto) e o caso de uso criar o
  //              lançamento — não usei porque seria a única exceção à regra e dependeria de
  //              alguém lembrar de criar o lançamento.
  static open(props: OpenWalletProps): OpenWalletResult {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance cannot be negative');
    }

    const currency = props.initialBalance.currency;
    // Enunciado: version começa em 1 após a criação, mesmo com saldo inicial.
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);

    if (props.initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência: não revalida, só restaura o estado salvo. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  // DECISÃO: debit() e credit() devolvem o WalletLedgerEntry criado.
  // POR QUÊ: quem muda o saldo recebe obrigatoriamente o lançamento para salvar; não tem
  //          como "esquecer" o ledger.
  // ALTERNATIVA: devolver void e o caso de uso montar o lançamento — não usei porque a
  //              consistência saldo ⇄ ledger dependeria de disciplina de quem chama.

  // DECISÃO: saldo insuficiente lança InsufficientBalanceError.
  // POR QUÊ: mesmo estilo do Money (erro de domínio = exceção), comum no NestJS. O caso de uso
  //          captura e escolhe o failureCode: aposta sem saldo e reversão que deixaria o saldo
  //          negativo são situações diferentes (regra 9 da seção 7 do enunciado).
  // ALTERNATIVA: devolver um objeto { ok, error } — não usei porque misturaria dois estilos de
  //              erro no projeto e deixaria cada chamada mais verbosa.
  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertValidAmount(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientBalanceError(`Insufficient balance in wallet ${this.id}`);
    }
    return this.applyMovement(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertValidAmount(props.money);
    return this.applyMovement(LedgerDirection.Credit, props);
  }

  private applyMovement(direction: LedgerDirection, props: WalletMovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Debit ? balanceBefore.subtract(props.money) : balanceBefore.add(props.money);

    // O lançamento é criado ANTES de alterar o estado: se a criação falhar, a wallet
    // continua exatamente como estava.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    // Enunciado: version incrementa somente quando o saldo muda.
    // Como o valor é sempre > 0, todo debit/credit bem-sucedido muda o saldo.
    this._version += 1;
    this._updatedAt = props.at;
    return entry;
  }

  /** Valor da movimentação: mesma moeda da wallet e maior que zero. */
  private assertValidAmount(money: Money): void {
    this.assertSameCurrency(money);
    // Movimentar zero não muda o saldo; geraria um lançamento vazio e um version++ sem
    // mudança de saldo, o que o enunciado proíbe.
    if (!money.isPositive()) {
      throw new InvalidMoneyError('Movement amount must be greater than zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet ${this.id} is ${this.currency}, operation is ${money.currency}`);
    }
  }
}
