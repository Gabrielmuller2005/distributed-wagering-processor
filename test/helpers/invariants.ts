import { expect } from "bun:test";
import type { UnitOfWork } from "../../src/wagering/application/ports/unit-of-work";
import { LedgerDirection } from "../../src/wagering/domain/ledger/ledger-direction";
import type { WalletLedgerEntry } from "../../src/wagering/domain/ledger/wallet-ledger-entry";
import { Money } from "../../src/wagering/domain/money";

export interface LedgerCheck {
  readonly balance: string;
  readonly entries: number;
  readonly debits: number;
  readonly credits: number;
}

/**
 * Invariante central do sistema, conferida ao fim dos testes:
 * `wallet.balance == saldo reconstruído somando o ledger desde zero`.
 *
 * Também confere a cadeia: versões consecutivas, cada lançamento balanceado e começando no
 * saldo final do anterior, e o último lançamento na mesma versão da wallet.
 */
export async function expectLedgerMatchesWallet(
  unitOfWork: UnitOfWork,
  walletId: string,
): Promise<LedgerCheck> {
  const { wallet, entries, totals } = await unitOfWork.run(async ({ wallets, ledger }) => {
    const found = await wallets.findById(walletId);
    if (!found) throw new Error(`wallet ${walletId} not found`);
    const all: WalletLedgerEntry[] = [];
    let afterVersion: number | undefined;
    do {
      const page = await ledger.listByWallet(walletId, { afterVersion, limit: 500 });
      all.push(...page.entries);
      afterVersion = page.nextAfterVersion;
    } while (afterVersion !== undefined);
    return { wallet: found, entries: all, totals: await ledger.totals(walletId, found.currency) };
  });

  let rebuilt = Money.zero(wallet.currency);
  let previous: WalletLedgerEntry | undefined;
  for (const entry of entries) {
    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceBefore.equals(rebuilt)).toBe(true);
    if (previous) expect(entry.walletVersion).toBe(previous.walletVersion + 1);
    rebuilt =
      entry.direction === LedgerDirection.Debit
        ? rebuilt.subtract(entry.money)
        : rebuilt.add(entry.money);
    previous = entry;
  }

  expect(rebuilt.toString()).toBe(wallet.balance.toString());
  expect(totals.credits.subtract(totals.debits).toString()).toBe(wallet.balance.toString());
  if (previous) expect(previous.walletVersion).toBe(wallet.version);

  return {
    balance: wallet.balance.toString(),
    entries: entries.length,
    debits: entries.filter((entry) => entry.direction === LedgerDirection.Debit).length,
    credits: entries.filter((entry) => entry.direction === LedgerDirection.Credit).length,
  };
}
