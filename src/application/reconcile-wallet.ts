import type { MoneyProps } from '../domain/money';
import { NotFoundError } from './errors';
import type { TransactionRunner } from './ports';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** storedBalance - calculatedBalance. Pode ser negativo. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Avisado quando a reconciliação encontra divergência (log + métrica, na camada de fora). */
export type DivergenceListener = (result: ReconciliationResult) => void;

/**
 * Compara o saldo gravado na wallet com o saldo reconstruído pelo ledger (créditos - débitos).
 * Divergências NÃO são corrigidas: são sinalizadas na resposta e avisadas ao listener
 * (seção 9 do enunciado: logar, contar em métrica e sinalizar, nunca corrigir em silêncio).
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly onDivergence: DivergenceListener = () => {},
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const result = await this.runner.run(async (repositories) => {
      // O lock na wallet garante que saldo e ledger são lidos no MESMO momento: nenhuma operação
      // consegue mudar a wallet entre as duas leituras. Sem isso, uma aposta que entrasse no
      // meio daria uma "divergência" falsa.
      const wallet = await repositories.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);

      const totals = await repositories.ledger.totalsByWallet(walletId, wallet.currency);
      const calculated = totals.credits.subtract(totals.debits);
      const difference = wallet.balance.subtract(calculated);

      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.entries,
      };
    });

    if (!result.consistent) {
      this.onDivergence(result);
    }
    return result;
  }
}
