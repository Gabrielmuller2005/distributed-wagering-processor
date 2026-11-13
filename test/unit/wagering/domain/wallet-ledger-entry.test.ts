import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../../src/wagering/domain/ledger/ledger-direction";
import {
  type CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  WalletLedgerEntry,
} from "../../../../src/wagering/domain/ledger/wallet-ledger-entry";
import { CurrencyMismatchError, Money } from "../../../../src/wagering/domain/money";
import { Wallet } from "../../../../src/wagering/domain/wallet/wallet";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00Z");

function props(overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("80.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("20.00"),
    createdAt: T0,
    ...overrides,
  };
}

describe("WalletLedgerEntry.create", () => {
  test("aceita débito balanceado: 100.00 - 80.00 = 20.00", () => {
    const entry = WalletLedgerEntry.create(props());

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  test("aceita crédito balanceado: 20.00 + 80.00 = 100.00", () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        balanceBefore: brl("20.00"),
        balanceAfter: brl("100.00"),
      }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    ["débito com saldo final errado", props({ balanceAfter: brl("20.01") })],
    ["direção trocada", props({ direction: LedgerDirection.Credit })],
  ])("rejeita aritmética errada: %s", (_name, invalid) => {
    expect(() => WalletLedgerEntry.create(invalid)).toThrow(InvalidLedgerEntryError);
  });

  test.each([
    ["zero", Money.zero("BRL")],
    ["negativo", brl("1.00").negate()],
  ])("rejeita valor %s", (_name, money) => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money, balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(money) }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita saldo final negativo, mesmo com a aritmética certa", () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("80.00")) }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita moedas misturadas", () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: Money.from({ amount: "80.00", currency: "USD" }) })),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("WalletLedgerEntry: imutabilidade estrutural", () => {
  test("a instância é congelada e não tem setters", () => {
    const entry = WalletLedgerEntry.create(props());

    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = "CREDIT";
    }).toThrow(TypeError);
  });

  test("alterar a Date usada na criação não altera o lançamento", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const entry = WalletLedgerEntry.create(props({ createdAt }));

    createdAt.setFullYear(1999);
    entry.createdAt.setFullYear(1999);

    expect(entry.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("reconstrói sem revalidar, e isBalanced revela inconsistência", () => {
    const corrupted = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("99.00") }));

    expect(corrupted.isBalanced()).toBe(false);
  });
});

describe("Wallet + ledger: saldo e lançamento nascem do mesmo cálculo", () => {
  test("cada movimento da wallet produz um lançamento balanceado", () => {
    const { wallet, openingMovement } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("100.00"),
      at: T0,
    });
    if (!openingMovement) throw new Error("expected opening movement");

    const movements = [
      openingMovement,
      wallet.debit(brl("80.00"), T0),
      wallet.credit(brl("35.50"), T0),
    ];
    const entries = movements.map((movement, index) =>
      WalletLedgerEntry.create({
        ...movement,
        id: `entry-${index}`,
        walletId: wallet.id,
        transactionId: `tx-${index}`,
        createdAt: T0,
      }),
    );

    const rebuilt = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Debit
          ? balance.subtract(entry.money)
          : balance.add(entry.money),
      Money.zero("BRL"),
    );
    expect(entries.every((entry) => entry.isBalanced())).toBe(true);
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe("55.50");
  });
});
