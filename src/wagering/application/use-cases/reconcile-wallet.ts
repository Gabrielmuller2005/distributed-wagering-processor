import type { MoneyProps } from "../../domain/money";
import { WalletNotFoundError } from "../errors";
import type { UnitOfWork } from "../ports/unit-of-work";

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  /** storedBalance - calculatedBalance. Zero quando consistente. */
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

/**
 * Recalcula o saldo pelo ledger (créditos - débitos, somados pelo banco em numeric) e compara
 * com o saldo armazenado na wallet.
 *
 * A wallet é lida com FOR UPDATE: enquanto as duas leituras acontecem, nenhuma movimentação
 * dela pode confirmar no meio, o que geraria uma divergência falsa. O lock dura só as duas
 * consultas.
 *
 * Divergência **não** é corrigida aqui: corrigir em silêncio esconderia o problema. O resultado é
 * sinalizado na resposta, e quem chama loga e conta em métrica.
 */
export class ReconcileWallet {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(walletId: string): Promise<ReconciliationReport> {
    return this.unitOfWork.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);

      const totals = await ledger.totals(walletId, wallet.currency);
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
  }
}
