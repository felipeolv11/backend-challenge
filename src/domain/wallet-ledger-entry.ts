import { InvalidLedgerEntryError } from './errors';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /**
   * version da wallet DEPOIS deste lançamento (abertura = 1). Como a version sobe exatamente 1
   * a cada mudança de saldo, cada lançamento ocupa uma posição única na "corrente" da wallet:
   * o banco tem UNIQUE (wallet_id, wallet_version), então dois lançamentos continuando do mesmo
   * ponto (lost update) são recusados mesmo que o código perca as outras proteções.
   */
  walletVersion: number;
  createdAt: Date;
}

// Estado já persistido: mesmos campos, mas sem validação na reconstrução.
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do extrato (ledger) de uma wallet. Imutável: só campos readonly, nenhum método
 * que altere estado, e o objeto é congelado com Object.freeze. O banco também impede
 * UPDATE e DELETE nesta tabela (ver migrations).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    // readonly só vale para o TypeScript; o freeze garante a imutabilidade também em runtime.
    Object.freeze(this);
  }

  /** Cria um lançamento novo, validando a aritmética: balanceBefore ± money === balanceAfter. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be greater than zero');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry balances cannot be negative');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('Ledger entry walletVersion must be an integer >= 1');
    }

    const entry = WalletLedgerEntry.fromProps(props);
    // isBalanced usa add/subtract do Money, que já lançam CurrencyMismatchError
    // se money, balanceBefore e balanceAfter não estiverem na mesma moeda.
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced ledger entry: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrói um lançamento lido do banco. Não revalida: o dado já foi validado ao ser criado. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.fromProps(state);
  }

  /** DEBIT: antes - valor = depois. CREDIT: antes + valor = depois. */
  isBalanced(): boolean {
    const expectedAfter =
      this.direction === LedgerDirection.Debit ? this.balanceBefore.subtract(this.money) : this.balanceBefore.add(this.money);
    return expectedAfter.equals(this.balanceAfter);
  }

  private static fromProps(props: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
  }
}
