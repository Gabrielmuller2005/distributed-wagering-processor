import { TransactionNotFoundError, WalletNotFoundError } from "../errors";
import type { UnitOfWork } from "../ports/unit-of-work";
import {
  type LedgerEntryView,
  ledgerEntryView,
  type WagerTransactionView,
  type WalletView,
  wagerTransactionView,
  walletView,
} from "../views";

export interface LedgerPageView {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  /** Versão do último lançamento da página; undefined quando não há próxima página. */
  readonly nextAfterVersion: number | undefined;
}

/** Consultas de leitura. Não travam nada e não alteram estado. */
export class WageringQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.unitOfWork.run(async ({ wallets }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return walletView(wallet);
    });
  }

  /** Lançamentos em ordem de versão da wallet, a partir de `afterVersion` (exclusivo). */
  listLedger(
    walletId: string,
    page: { readonly afterVersion: number | undefined; readonly limit: number },
  ): Promise<LedgerPageView> {
    return this.unitOfWork.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      const result = await ledger.listByWallet(walletId, page);
      return {
        walletId,
        entries: result.entries.map(ledgerEntryView),
        nextAfterVersion: result.nextAfterVersion,
      };
    });
  }

  getTransaction(transactionId: string): Promise<WagerTransactionView> {
    return this.unitOfWork.run(async ({ transactions }) => {
      const transaction = await transactions.findById(transactionId);
      if (!transaction) throw new TransactionNotFoundError(transactionId);
      return wagerTransactionView(transaction);
    });
  }

  getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.unitOfWork.run(async ({ transactions }) => {
      const transaction = await transactions.findByProviderAndExternalId(
        providerId,
        externalTransactionId,
      );
      if (!transaction) {
        throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
      }
      return wagerTransactionView(transaction);
    });
  }
}
