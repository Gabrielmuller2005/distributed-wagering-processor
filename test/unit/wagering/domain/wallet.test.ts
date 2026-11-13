import { describe, expect, test } from "bun:test";
import { LedgerDirection } from "../../../../src/wagering/domain/ledger/ledger-direction";
import { CurrencyMismatchError, Money } from "../../../../src/wagering/domain/money";
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
  Wallet,
} from "../../../../src/wagering/domain/wallet/wallet";

const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-01-01T00:00:01Z");

function openWallet(initial = "100.00"): Wallet {
  return Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl(initial), at: T0 })
    .wallet;
}

describe("Wallet.open", () => {
  test("abre com o saldo inicial, version 1 e a moeda do saldo", () => {
    const { wallet } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("1000.00"),
      at: T0,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe("BRL");
    expect(wallet.createdAt).toEqual(T0);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test("saldo inicial positivo gera o crédito de abertura 0 -> saldo inicial", () => {
    const { openingMovement } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("1000.00"),
      at: T0,
    });

    expect(openingMovement?.direction).toBe(LedgerDirection.Credit);
    expect(openingMovement?.money.toString()).toBe("1000.00");
    expect(openingMovement?.balanceBefore.toString()).toBe("0.00");
    expect(openingMovement?.balanceAfter.toString()).toBe("1000.00");
  });

  test("saldo inicial zero não gera movimento", () => {
    const { wallet, openingMovement } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.zero("BRL"),
      at: T0,
    });

    expect(openingMovement).toBeUndefined();
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test("rejeita saldo inicial negativo", () => {
    const negative = brl("10.00").negate();

    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: negative, at: T0 })).toThrow(
      InvalidWalletOperationError,
    );
  });
});

describe("Wallet.debit", () => {
  test("debita, incrementa a version e devolve o movimento", () => {
    const wallet = openWallet("100.00");

    const movement = wallet.debit(brl("80.00"), T1);

    expect(wallet.balance.toString()).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(T1);
    expect(movement.direction).toBe(LedgerDirection.Debit);
    expect(movement.balanceBefore.toString()).toBe("100.00");
    expect(movement.balanceAfter.toString()).toBe("20.00");
  });

  test("pode debitar o saldo inteiro, ficando em zero", () => {
    const wallet = openWallet("100.00");

    wallet.debit(brl("100.00"), T1);

    expect(wallet.balance.toString()).toBe("0.00");
  });

  test("débito maior que o saldo lança erro e não altera nada", () => {
    const wallet = openWallet("100.00");

    expect(() => wallet.debit(brl("100.01"), T1)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(T0);
  });

  test("canDebit indica se o débito cabe no saldo", () => {
    const wallet = openWallet("100.00");

    expect(wallet.canDebit(brl("100.00"))).toBe(true);
    expect(wallet.canDebit(brl("100.01"))).toBe(false);
  });
});

describe("Wallet.credit", () => {
  test("credita, incrementa a version e devolve o movimento", () => {
    const wallet = openWallet("100.00");

    const movement = wallet.credit(brl("50.50"), T1);

    expect(wallet.balance.toString()).toBe("150.50");
    expect(wallet.version).toBe(2);
    expect(movement.direction).toBe(LedgerDirection.Credit);
    expect(movement.balanceBefore.toString()).toBe("100.00");
    expect(movement.balanceAfter.toString()).toBe("150.50");
  });

  test("move usa a direção indicada", () => {
    const wallet = openWallet("100.00");

    wallet.move(LedgerDirection.Credit, brl("10.00"), T1);
    wallet.move(LedgerDirection.Debit, brl("30.00"), T1);

    expect(wallet.balance.toString()).toBe("80.00");
    expect(wallet.version).toBe(3);
  });
});

describe("Wallet: validação das movimentações", () => {
  test.each([
    ["debit", (w: Wallet, m: Money) => w.debit(m, T1)],
    ["credit", (w: Wallet, m: Money) => w.credit(m, T1)],
  ] as const)("%s de zero é rejeitado e não muda a version", (_name, operation) => {
    const wallet = openWallet("100.00");

    expect(() => operation(wallet, Money.zero("BRL"))).toThrow(InvalidWalletOperationError);
    expect(wallet.version).toBe(1);
  });

  test.each([
    ["debit", (w: Wallet, m: Money) => w.debit(m, T1)],
    ["credit", (w: Wallet, m: Money) => w.credit(m, T1)],
    ["canDebit", (w: Wallet, m: Money) => w.canDebit(m)],
  ] as const)("%s em outra moeda lança CurrencyMismatchError", (_name, operation) => {
    const wallet = openWallet("100.00");

    expect(() => operation(wallet, Money.from({ amount: "10.00", currency: "USD" }))).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });
});

describe("Wallet.rehydrate", () => {
  test("reconstrói o estado persistido sem alterá-lo", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });

    expect(wallet.balance.toString()).toBe("42.00");
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt).toEqual(T1);
  });
});
