import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Clock } from "../../../src/shared/application/clock";
import { UuidV7Generator } from "../../../src/shared/application/id-generator";
import {
  type PendingReferenceOptions,
  RetryPendingReferences,
} from "../../../src/wagering/application/use-cases/retry-pending-references";
import type { WalletView } from "../../../src/wagering/application/views";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { MikroOrmUnitOfWork } from "../../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import { openTestDatabase, type TestDatabase } from "../../helpers/database";
import { newId } from "../../helpers/fixtures";
import { expectLedgerMatchesWallet } from "../../helpers/invariants";
import { openWallet, useCases, wagerCommand } from "../../helpers/use-cases";

let db: TestDatabase;
let cases: ReturnType<typeof useCases>;

/** Relógio do worker, adiantável: "o tempo passa" sem sleep. */
let offsetMs = 0;
const clock: Clock = { now: () => new Date(Date.now() + offsetMs) };

const OPTIONS: PendingReferenceOptions = { batchSize: 20, ttlMs: 60_000, leaseMs: 30_000 };

beforeAll(async () => {
  db = await openTestDatabase();
  cases = useCases(db.unitOfWork);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  offsetMs = 0;
  // Pendências de outros testes não entram na conta deste.
  await db.sqlWithoutTriggers(
    "update wager_transactions set next_reference_attempt_at = 'infinity' where status = 'PENDING_REFERENCE'",
  );
});

function worker(options: Partial<PendingReferenceOptions> = {}) {
  return new RetryPendingReferences(
    db.unitOfWork,
    new UuidV7Generator(),
    clock,
    { ...OPTIONS, ...options },
    () => 0,
  );
}

async function submitBet(wallet: WalletView, externalId: string, amount = "30.00") {
  return cases.submit.execute(
    wagerCommand(wallet, {
      externalTransactionId: externalId,
      kind: "BET",
      money: { amount, currency: "BRL" },
    }),
  );
}

async function submitReversal(
  wallet: WalletView,
  kind: "REFUND" | "ROLLBACK",
  referenceExternalId: string,
  amount = "30.00",
) {
  return cases.submit.execute(
    wagerCommand(wallet, {
      kind,
      referenceExternalTransactionId: referenceExternalId,
      money: { amount, currency: "BRL" },
    }),
  );
}

interface Row {
  status: string;
  failure_code: string | null;
  reference_attempts: number;
  next_reference_attempt_at: string | null;
  reference_transaction_id: string | null;
}

const rowOf = async (transactionId: string) => {
  const [row] = await db.sql<Row[]>("select * from wager_transactions where id = ?", [
    transactionId,
  ]);
  if (!row) throw new Error(`transaction ${transactionId} not found`);
  return row;
};

const eventTypesOf = async (transactionId: string) =>
  (
    await db.sql<{ event_type: string }[]>(
      `select event_type from outbox_messages
       where payload -> 'data' ->> 'transactionId' = ? order by occurred_at, id`,
      [transactionId],
    )
  ).map((row) => row.event_type);

describe("referência que chega depois", () => {
  test.each([["REFUND" as const], ["ROLLBACK" as const]])(
    "%s antes da BET é aplicado depois que a BET chega, uma única vez",
    async (kind) => {
      const wallet = await openWallet(cases.createWallet, "100.00");
      const betId = `bet-${newId()}`;
      const reversal = await submitReversal(wallet, kind, betId);
      expect(reversal.status).toBe(WagerTransactionStatus.PendingReference);

      const bet = await submitBet(wallet, betId);
      // A BET terminou: o reversal ficou vencido na hora, sem esperar o backoff.
      const result = await worker().execute();
      const again = await worker().execute();

      expect(bet.status).toBe(WagerTransactionStatus.Processed);
      expect(result).toMatchObject({ claimed: 1, outcomes: { RESOLVED: 1, FAILED: 0 } });
      expect(again.claimed).toBe(0);
      const row = await rowOf(reversal.transactionId);
      expect(row).toMatchObject({
        status: "PROCESSED",
        reference_transaction_id: bet.transactionId,
      });
      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "100.00",
        debits: 1,
        credits: 2, // abertura + reversal
      });
      expect(await eventTypesOf(reversal.transactionId)).toEqual([
        "WagerTransactionPendingReference",
        "WagerTransactionProcessed",
        "WalletBalanceChanged",
      ]);
    },
  );

  test("o replay da submissão original devolve o resultado resolvido", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const betId = `bet-${newId()}`;
    const command = wagerCommand(wallet, {
      kind: "REFUND",
      referenceExternalTransactionId: betId,
      money: { amount: "30.00", currency: "BRL" },
    });
    await cases.submit.execute(command);
    await submitBet(wallet, betId);
    await worker().execute();

    const replay = await cases.submit.execute(command);

    expect(replay).toMatchObject({
      status: WagerTransactionStatus.Processed,
      idempotentReplay: true,
      balance: { amount: "100.00" },
    });
  });

  test("a referência chega, mas a regra rejeita (valor divergente): REJECTED com o código da regra", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const betId = `bet-${newId()}`;
    const refund = await submitReversal(wallet, "REFUND", betId, "10.00");
    await submitBet(wallet, betId, "30.00");

    const result = await worker().execute();

    expect(result.outcomes.RESOLVED).toBe(1);
    expect(await rowOf(refund.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "AMOUNT_MISMATCH",
    });
    expect(await eventTypesOf(refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
  });
});

describe("backoff e prazo", () => {
  test("recém-submetida não é reprocessada antes do backoff", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    await submitReversal(wallet, "REFUND", `bet-${newId()}`);

    expect((await worker().execute()).claimed).toBe(0);
  });

  test("ainda sem referência, dentro do prazo: reagenda com backoff crescente, sem evento novo", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const refund = await submitReversal(wallet, "REFUND", `bet-${newId()}`);

    offsetMs = 5_000;
    const first = await worker().execute();
    const afterFirst = await rowOf(refund.transactionId);
    offsetMs = 10_000;
    const second = await worker().execute();
    const afterSecond = await rowOf(refund.transactionId);

    expect(first.outcomes.RESCHEDULED).toBe(1);
    expect(second.outcomes.RESCHEDULED).toBe(1);
    expect(afterSecond).toMatchObject({ status: "PENDING_REFERENCE", reference_attempts: 2 });
    const firstDelay = Date.parse(afterFirst.next_reference_attempt_at ?? "") - Date.now() - 5_000;
    const secondDelay =
      Date.parse(afterSecond.next_reference_attempt_at ?? "") - Date.now() - 10_000;
    // random = 0: metade do exponencial (2ª tentativa: 2 s; 3ª: 4 s), com folga de execução.
    expect(firstDelay).toBeGreaterThan(1_500);
    expect(firstDelay).toBeLessThanOrEqual(2_000);
    expect(secondDelay).toBeGreaterThan(3_500);
    expect(secondDelay).toBeLessThanOrEqual(4_000);
    expect(await eventTypesOf(refund.transactionId)).toEqual(["WagerTransactionPendingReference"]);
  });

  test("prazo esgotado: REJECTED(REFERENCE_NOT_FOUND), evento publicado e saldo intacto", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const betId = `bet-${newId()}`;
    const refund = await submitReversal(wallet, "REFUND", betId);

    offsetMs = OPTIONS.ttlMs + 1_000;
    const result = await worker().execute();

    expect(result.outcomes.EXPIRED).toBe(1);
    expect(await rowOf(refund.transactionId)).toMatchObject({
      status: "REJECTED",
      failure_code: "REFERENCE_NOT_FOUND",
    });
    expect(await eventTypesOf(refund.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionRejected",
    ]);
    const [rejected] = await db.sql<{ payload: { data: Record<string, unknown> } }[]>(
      `select payload from outbox_messages
       where event_type = 'WagerTransactionRejected' and payload -> 'data' ->> 'transactionId' = ?`,
      [refund.transactionId],
    );
    expect(rejected?.payload.data).toMatchObject({ failureCode: "REFERENCE_NOT_FOUND" });
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "100.00",
      credits: 1,
    });

    // A BET que chega tarde é aplicada normalmente; o REFUND expirado não volta.
    await submitBet(wallet, betId);
    expect((await worker().execute()).claimed).toBe(0);
    expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
      balance: "70.00",
      debits: 1,
    });
  });

  test("prazo esgotado, mas a referência chegou: aplica em vez de expirar", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const betId = `bet-${newId()}`;
    const refund = await submitReversal(wallet, "REFUND", betId);
    await submitBet(wallet, betId);

    offsetMs = OPTIONS.ttlMs + 1_000;
    const result = await worker().execute();

    expect(result.outcomes).toMatchObject({ RESOLVED: 1, EXPIRED: 0 });
    expect((await rowOf(refund.transactionId)).status).toBe("PROCESSED");
  });
});

describe("concorrência", () => {
  test("dois workers em paralelo: cada pendência resolvida uma única vez", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 4 }, () => openWallet(cases.createWallet, "100.00")),
    );
    const refunds: string[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 3; i++) {
        const betId = `bet-${newId()}`;
        refunds.push((await submitReversal(wallet, "REFUND", betId, "5.00")).transactionId);
        await submitBet(wallet, betId, "5.00");
      }
    }
    const small = { batchSize: 2 };

    const drain = async (subject: RetryPendingReferences) => {
      let resolved = 0;
      for (;;) {
        const result = await subject.execute();
        if (result.claimed === 0) return resolved;
        expect(result.outcomes.FAILED).toBe(0);
        resolved += result.outcomes.RESOLVED;
      }
    };
    const [a, b] = await Promise.all([drain(worker(small)), drain(worker(small))]);

    expect(a + b).toBe(refunds.length);
    for (const id of refunds) expect((await rowOf(id)).status).toBe("PROCESSED");
    for (const wallet of wallets) {
      expect(await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).toMatchObject({
        balance: "100.00",
        debits: 3,
        credits: 4,
      });
    }
  });

  test("wallet travada: a tentativa falha sem efeito e a pendência volta depois da reserva", async () => {
    const wallet = await openWallet(cases.createWallet, "100.00");
    const betId = `bet-${newId()}`;
    const refund = await submitReversal(wallet, "REFUND", betId);
    await submitBet(wallet, betId);
    const shortLock = new RetryPendingReferences(
      new MikroOrmUnitOfWork(db.orm, 200),
      new UuidV7Generator(),
      clock,
      { ...OPTIONS, leaseMs: 5_000 },
      () => 0,
    );
    const holder = db.unitOfWork.run(async ({ wallets }) => {
      await wallets.findByIdForUpdate(wallet.id);
      await Bun.sleep(600);
    });
    await Bun.sleep(50);

    const blocked = await shortLock.execute();
    await holder;
    const whileLeased = await shortLock.execute();
    offsetMs = 6_000; // reserva de 5 s vencida
    const retried = await shortLock.execute();

    expect(blocked.outcomes.FAILED).toBe(1);
    expect(blocked.errors).toHaveLength(1);
    expect(whileLeased.claimed).toBe(0);
    expect(retried.outcomes.RESOLVED).toBe(1);
    expect((await rowOf(refund.transactionId)).status).toBe("PROCESSED");
    expect((await expectLedgerMatchesWallet(db.unitOfWork, wallet.id)).credits).toBe(2);
  });
});
