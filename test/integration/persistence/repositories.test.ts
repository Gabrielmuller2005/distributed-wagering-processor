import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ConcurrentModificationError } from "../../../src/wagering/application/errors";
import { WagerTransactionProcessed } from "../../../src/wagering/domain/events/wager-transaction-processed";
import { FailureCode } from "../../../src/wagering/domain/failure-code";
import { LedgerDirection } from "../../../src/wagering/domain/ledger/ledger-direction";
import { InboxMessage } from "../../../src/wagering/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/wagering/domain/messaging/outbox-message";
import { Money } from "../../../src/wagering/domain/money";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import {
  expectDatabaseError,
  openTestDatabase,
  SqlState,
  type TestDatabase,
} from "../../helpers/database";
import {
  brl,
  newId,
  newTransaction,
  persistWallet,
  processTransaction,
  sha256,
} from "../../helpers/fixtures";

let db: TestDatabase;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

describe("WalletRepository", () => {
  test("ida e volta preserva o estado, com o saldo como Money em string", async () => {
    const { wallet } = await persistWallet(db.unitOfWork, "1234.56");

    const loaded = await db.unitOfWork.run(({ wallets }) => wallets.findById(wallet.id));

    expect(loaded?.id).toBe(wallet.id);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.balance).toBeInstanceOf(Money);
    expect(loaded?.balance.toJSON()).toEqual({ amount: "1234.56", currency: "BRL" });
    expect(loaded?.version).toBe(1);
    expect(loaded?.createdAt.toISOString()).toBe(wallet.createdAt.toISOString());
  });

  test("wallet inexistente devolve undefined", async () => {
    expect(await db.unitOfWork.run(({ wallets }) => wallets.findById(newId()))).toBeUndefined();
  });

  test("saveBalance com versão desatualizada lança ConcurrentModificationError", async () => {
    const { wallet } = await persistWallet(db.unitOfWork, "100.00");
    const stale = await db.unitOfWork.run(({ wallets }) => wallets.findById(wallet.id));
    if (!stale) throw new Error("setup");

    await processTransaction(db.unitOfWork, newTransaction(wallet.id, wallet.playerId));
    stale.debit(brl("1.00"), new Date());

    const save = db.unitOfWork.run(({ wallets }) => wallets.saveBalance(stale, 1));

    await expect(save).rejects.toBeInstanceOf(ConcurrentModificationError);
  });
});

describe("WalletRepository: lock pessimista por wallet", () => {
  test("FOR UPDATE: a segunda transação espera o commit da primeira e lê o saldo novo", async () => {
    const { wallet } = await persistWallet(db.unitOfWork, "100.00");
    const timeline: string[] = [];

    const first = db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      timeline.push("first:locked");
      await Bun.sleep(300);
      timeline.push("first:commit");
    });
    await Bun.sleep(50);
    const second = processTransaction(
      db.unitOfWork,
      newTransaction(wallet.id, wallet.playerId, { money: brl("10.00") }),
    ).then((outcome) => {
      timeline.push("second:done");
      return outcome;
    });

    await Promise.all([first, second]);

    expect(timeline).toEqual(["first:locked", "first:commit", "second:done"]);
  });

  test("lock_timeout: esperar demais pelo lock falha com 55P03, sem ficar preso", async () => {
    const { wallet } = await persistWallet(db.unitOfWork, "100.00");
    const impatient = new MikroOrmUnitOfWork(db.orm, 100);

    const holder = db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      await Bun.sleep(600);
    });
    await Bun.sleep(50);

    await expectDatabaseError(
      impatient.run(({ wallets }) => wallets.findByIdForUpdate(wallet.id)),
      SqlState.LockNotAvailable,
    );
    await holder;
  });

  test("o lock é por wallet: wallets diferentes não esperam uma pela outra", async () => {
    const a = await persistWallet(db.unitOfWork, "100.00");
    const b = await persistWallet(db.unitOfWork, "100.00");
    const impatient = new MikroOrmUnitOfWork(db.orm, 100);

    const holder = db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(a.wallet.id);
      await Bun.sleep(400);
    });
    await Bun.sleep(50);

    const other = await impatient.run(({ wallets }) => wallets.findByIdForUpdate(b.wallet.id));

    expect(other?.id).toBe(b.wallet.id);
    await holder;
  });
});

describe("WagerTransactionRepository", () => {
  test("ida e volta de uma transação PROCESSED, com referência e saldo observado", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl("30.00") });
    await processTransaction(db.unitOfWork, bet);
    const refund = newTransaction(owner.wallet.id, owner.wallet.playerId, {
      kind: Kind.Refund,
      money: brl("30.00"),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await processTransaction(db.unitOfWork, refund);

    const loaded = await db.unitOfWork.run(({ transactions }) => transactions.findById(refund.id));

    expect(loaded?.status).toBe(Status.Processed);
    expect(loaded?.kind).toBe(Kind.Refund);
    expect(loaded?.referenceExternalTransactionId).toBe(bet.externalTransactionId);
    expect(loaded?.referenceTransactionId).toBe(bet.id);
    expect(loaded?.balanceAfter?.toString()).toBe("100.00");
    expect(loaded?.money.toJSON()).toEqual({ amount: "30.00", currency: "BRL" });
    expect(loaded?.processedAt).toBeInstanceOf(Date);
    expect(loaded?.isTerminal()).toBe(true);
  });

  test("ida e volta de uma rejeição, com código e saldo observado", async () => {
    const owner = await persistWallet(db.unitOfWork, "10.00");
    const bet = newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl("50.00") });
    await processTransaction(db.unitOfWork, bet);

    const loaded = await db.unitOfWork.run(({ transactions }) =>
      transactions.findByIdempotencyKey(bet.idempotencyKey),
    );

    expect(loaded?.status).toBe(Status.Rejected);
    expect(loaded?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loaded?.balanceAfter?.toString()).toBe("10.00");
  });

  test("PENDING_REFERENCE e busca por provider + id externo", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const refund = newTransaction(owner.wallet.id, owner.wallet.playerId, {
      kind: Kind.Refund,
      referenceExternalTransactionId: "bet-not-arrived",
    });
    await processTransaction(db.unitOfWork, refund);

    const loaded = await db.unitOfWork.run(({ transactions }) =>
      transactions.findByProviderAndExternalId("provider-a", refund.externalTransactionId),
    );

    expect(loaded?.status).toBe(Status.PendingReference);
    expect(loaded?.balanceAfter).toBeUndefined();
    expect(loaded?.processedAt).toBeUndefined();
  });

  test("hasProcessedReversal só conta reversões PROCESSED", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl("30.00") });
    await processTransaction(db.unitOfWork, bet);

    const before = await db.unitOfWork.run(({ transactions }) =>
      transactions.hasProcessedReversal(bet.id),
    );
    await processTransaction(
      db.unitOfWork,
      newTransaction(owner.wallet.id, owner.wallet.playerId, {
        kind: Kind.Refund,
        money: brl("30.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    const after = await db.unitOfWork.run(({ transactions }) =>
      transactions.hasProcessedReversal(bet.id),
    );

    expect([before, after]).toEqual([false, true]);
  });
});

describe("LedgerRepository", () => {
  test("pagina por versão da wallet, de forma estável", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    for (const amount of ["1.00", "2.00", "3.00", "4.00"]) {
      await processTransaction(
        db.unitOfWork,
        newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl(amount) }),
      );
    }

    const first = await db.unitOfWork.run(({ ledger }) =>
      ledger.listByWallet(owner.wallet.id, { limit: 2 }),
    );
    const second = await db.unitOfWork.run(({ ledger }) =>
      ledger.listByWallet(owner.wallet.id, { afterVersion: first.nextAfterVersion, limit: 2 }),
    );
    const last = await db.unitOfWork.run(({ ledger }) =>
      ledger.listByWallet(owner.wallet.id, { afterVersion: second.nextAfterVersion, limit: 2 }),
    );

    expect(first.entries.map((e) => e.walletVersion)).toEqual([1, 2]);
    expect(second.entries.map((e) => e.walletVersion)).toEqual([3, 4]);
    expect(last.entries.map((e) => e.walletVersion)).toEqual([5]);
    expect(last.nextAfterVersion).toBeUndefined();
    expect(first.entries[0]?.direction).toBe(LedgerDirection.Credit);
    expect(first.entries.every((e) => e.isBalanced())).toBe(true);
  });

  test("totals soma créditos e débitos no banco, e bate com o saldo da wallet", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    await processTransaction(
      db.unitOfWork,
      newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl("30.10") }),
    );
    await processTransaction(
      db.unitOfWork,
      newTransaction(owner.wallet.id, owner.wallet.playerId, {
        kind: Kind.Win,
        money: brl("0.20"),
      }),
    );

    const [totals, wallet] = await db.unitOfWork.run(async ({ ledger, wallets }) => [
      await ledger.totals(owner.wallet.id, "BRL"),
      await wallets.findById(owner.wallet.id),
    ]);

    expect(totals.credits.toString()).toBe("100.20");
    expect(totals.debits.toString()).toBe("30.10");
    expect(totals.entries).toBe(3);
    expect(totals.credits.subtract(totals.debits).equals(wallet?.balance as Money)).toBe(true);
  });

  test("totals de uma wallet sem lançamentos é zero", async () => {
    const owner = await persistWallet(db.unitOfWork, "0.00");

    const totals = await db.unitOfWork.run(({ ledger }) => ledger.totals(owner.wallet.id, "BRL"));

    expect(totals.entries).toBe(0);
    expect(totals.credits.isZero() && totals.debits.isZero()).toBe(true);
  });
});

describe("InboxRepository", () => {
  test("insertIfAbsent registra uma vez e reconhece a redelivery", async () => {
    const message = InboxMessage.receive({
      messageId: `msg-${newId()}`,
      consumerName: "wager-transactions-consumer",
      payloadHash: sha256("body"),
      receivedAt: new Date(),
    });
    message.markProcessed(new Date());

    const inserted = await db.unitOfWork.run(async ({ inbox }) => [
      await inbox.insertIfAbsent(message),
      await inbox.insertIfAbsent(message),
    ]);
    const loaded = await db.unitOfWork.run(({ inbox }) =>
      inbox.find(message.consumerName, message.messageId),
    );

    expect(inserted).toEqual([true, false]);
    expect(loaded?.isProcessed()).toBe(true);
    expect(loaded?.matchesPayload(sha256("body"))).toBe(true);
  });

  test("se a transação SQL desfaz, a mensagem não fica registrada", async () => {
    const message = InboxMessage.receive({
      messageId: `msg-${newId()}`,
      consumerName: "wager-transactions-consumer",
      payloadHash: sha256("body"),
      receivedAt: new Date(),
    });

    const failing = db.unitOfWork.run(async ({ inbox }) => {
      await inbox.insertIfAbsent(message);
      throw new Error("processing failed");
    });

    await expect(failing).rejects.toThrow("processing failed");
    expect(
      await db.unitOfWork.run(({ inbox }) => inbox.find(message.consumerName, message.messageId)),
    ).toBeUndefined();
  });
});

describe("OutboxRepository", () => {
  async function enqueueEvents(count: number, at = new Date()): Promise<OutboxMessage[]> {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const messages = Array.from({ length: count }, () => {
      const tx = newTransaction(owner.wallet.id, owner.wallet.playerId);
      tx.markProcessed({ balanceAfter: brl("100.00"), at });
      return OutboxMessage.enqueue(
        WagerTransactionProcessed.from(tx, {
          eventId: newId(),
          correlationId: newId(),
          occurredAt: at,
        }),
      );
    });
    await db.unitOfWork.run(({ outbox }) => outbox.add(messages));
    return messages;
  }

  test("claimDue devolve só as pendentes e vencidas; save grava a publicação", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const [due] = await enqueueEvents(1);
    const [notYet] = await enqueueEvents(1, future);
    if (!due || !notYet) throw new Error("setup");

    const claimed = await db.unitOfWork.run(async ({ outbox }) => {
      const batch = await outbox.claimDue(new Date(), 1_000);
      for (const message of batch) message.markPublished(new Date());
      for (const message of batch) await outbox.save(message);
      return batch.map((message) => message.id);
    });
    const again = await db.unitOfWork.run(({ outbox }) => outbox.claimDue(new Date(), 1_000));

    expect(claimed).toContain(due.id);
    expect(claimed).not.toContain(notYet.id);
    expect(again.map((message) => message.id)).not.toContain(due.id);
  });

  test("o payload jsonb volta idêntico ao envelope gravado", async () => {
    const [message] = await enqueueEvents(1);
    if (!message) throw new Error("setup");

    const [row] = await db.sql<{ payload: unknown }[]>(
      "select payload from outbox_messages where id = ?",
      [message.id],
    );

    expect(row?.payload).toEqual(message.payload);
  });

  test("FOR UPDATE SKIP LOCKED: dois publishers simultâneos pegam lotes disjuntos", async () => {
    await db.unitOfWork.run(async ({ outbox }) => {
      for (const message of await outbox.claimDue(new Date(), 10_000)) {
        message.markPublished(new Date());
        await outbox.save(message);
      }
    });
    const messages = await enqueueEvents(6);

    const claimBatch = () =>
      db.unitOfWork.run(async ({ outbox }) => {
        const batch = await outbox.claimDue(new Date(), 3);
        await Bun.sleep(200); // segura os locks enquanto o outro publisher busca
        return batch.map((message) => message.id);
      });
    const [a, b] = await Promise.all([claimBatch(), claimBatch()]);

    expect(a).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(a.filter((id) => b.includes(id))).toEqual([]);
    expect([...a, ...b].sort()).toEqual(messages.map((message) => message.id).sort());
  });

  test("scheduleRetry persiste tentativas, próxima tentativa e erro", async () => {
    const [message] = await enqueueEvents(1);
    if (!message) throw new Error("setup");
    const now = new Date();

    await db.unitOfWork.run(async ({ outbox }) => {
      message.scheduleRetry(now, "SQS unavailable", () => 0);
      await outbox.save(message);
    });
    // SQL cru devolve timestamptz como texto ISO.
    const [row] = await db.sql<{ attempts: number; last_error: string; next_attempt_at: string }[]>(
      "select attempts, last_error, next_attempt_at from outbox_messages where id = ?",
      [message.id],
    );

    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toBe("SQS unavailable");
    expect(new Date(row?.next_attempt_at ?? 0).getTime()).toBe(now.getTime() + 500);
  });
});

describe("UnitOfWork: atomicidade", () => {
  test("exceção no meio desfaz tudo: nada de wallet, ledger ou transação pela metade", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl("40.00") });

    const failing = db.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findByIdForUpdate(owner.wallet.id);
      if (!wallet) throw new Error("setup");
      await repositories.transactions.insertIfAbsent(bet);
      wallet.debit(bet.money, new Date());
      await repositories.wallets.saveBalance(wallet, 1);
      throw new Error("crash before commit");
    });

    await expect(failing).rejects.toThrow("crash before commit");
    const state = await db.unitOfWork.run(async ({ wallets, transactions, ledger }) => ({
      wallet: await wallets.findById(owner.wallet.id),
      transaction: await transactions.findById(bet.id),
      totals: await ledger.totals(owner.wallet.id, "BRL"),
    }));
    expect(state.wallet?.balance.toString()).toBe("100.00");
    expect(state.wallet?.version).toBe(1);
    expect(state.transaction).toBeUndefined();
    expect(state.totals.entries).toBe(1);
  });
});
