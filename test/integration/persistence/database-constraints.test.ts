import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WalletAlreadyExistsError } from "../../../src/wagering/application/errors";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction/wager-transaction-kind";
import { WagerTransactionStatus as Status } from "../../../src/wagering/domain/wager-transaction/wager-transaction-status";
import { Wallet } from "../../../src/wagering/domain/wallet/wallet";
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
  type PersistedWallet,
  persistWallet,
  processTransaction,
  sha256,
} from "../../helpers/fixtures";

/**
 * Prova que as invariantes da seção 6 são aplicadas pelo **schema do banco** (restrição 5.9):
 * cada teste tenta violar uma regra com SQL cru, por fora do domínio, e o PostgreSQL recusa.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

type Row = Record<string, unknown>;

function insertSql(table: string, row: Row): string {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => "?").join(", ");
  return `insert into ${table} (${columns.join(", ")}) values (${placeholders})`;
}

function insert(table: string, row: Row): Promise<unknown> {
  return db.sql(insertSql(table, row), Object.values(row));
}

/** Insere com os triggers desligados, para isolar o CHECK ou índice que está sendo testado. */
function insertWithoutTriggers(table: string, row: Row): Promise<unknown> {
  return db.sqlWithoutTriggers(insertSql(table, row), Object.values(row));
}

function walletRow(overrides: Row = {}): Row {
  const now = new Date();
  return {
    id: newId(),
    player_id: `player-${newId()}`,
    currency: "BRL",
    balance: "0.00",
    version: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function transactionRow(owner: PersistedWallet, overrides: Row = {}): Row {
  const now = new Date();
  const externalId = `ext-${newId()}`;
  return {
    id: newId(),
    provider_id: "provider-a",
    external_transaction_id: externalId,
    idempotency_key: `provider-a:${externalId}`,
    payload_hash: sha256(externalId),
    wallet_id: owner.wallet.id,
    player_id: owner.wallet.playerId,
    round_id: "round-1",
    game_id: "game-1",
    kind: "BET",
    amount: "10.00",
    currency: "BRL",
    status: "PENDING",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Uma BET já PROCESSED, com wallet debitada e lançamento, pelo fluxo real. */
async function processedBet(owner: PersistedWallet, amount = "10.00") {
  const bet = newTransaction(owner.wallet.id, owner.wallet.playerId, { money: brl(amount) });
  const outcome = await processTransaction(db.unitOfWork, bet);
  expect(outcome.status).toBe(Status.Processed);
  return bet;
}

async function ledgerRowOf(transactionId: string): Promise<Row> {
  const [row] = await db.sql<Row[]>(
    "select * from wallet_ledger_entries where transaction_id = ?",
    [transactionId],
  );
  if (!row) throw new Error("ledger entry not found");
  return row;
}

describe("wallets", () => {
  test("saldo negativo é recusado (CHECK)", async () => {
    await expectDatabaseError(
      insert("wallets", walletRow({ balance: "-0.01" })),
      SqlState.CheckViolation,
      "wallets_balance_non_negative",
    );
  });

  test("UPDATE para saldo negativo é recusado, mesmo incrementando a versão", async () => {
    const owner = await persistWallet(db.unitOfWork, "10.00");

    await expectDatabaseError(
      db.sql("update wallets set balance = -5, version = version + 1 where id = ?", [
        owner.wallet.id,
      ]),
      SqlState.CheckViolation,
      "wallets_balance_non_negative",
    );
  });

  test("segunda wallet para o mesmo player e moeda é recusada (UNIQUE)", async () => {
    const owner = await persistWallet(db.unitOfWork, "0.00");

    await expectDatabaseError(
      insert("wallets", walletRow({ player_id: owner.wallet.playerId })),
      SqlState.UniqueViolation,
      "wallets_player_currency_unique",
    );
  });

  test("o repositório traduz a duplicidade em WalletAlreadyExistsError", async () => {
    const owner = await persistWallet(db.unitOfWork, "0.00");
    const duplicate = Wallet.open({
      id: newId(),
      playerId: owner.wallet.playerId,
      initialBalance: brl("0.00"),
      at: new Date(),
    }).wallet;

    const insertion = db.unitOfWork.run((repositories) => repositories.wallets.insert(duplicate));

    await expect(insertion).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test("o mesmo player pode ter wallets em moedas diferentes", async () => {
    const owner = await persistWallet(db.unitOfWork, "0.00");

    await insert("wallets", walletRow({ player_id: owner.wallet.playerId, currency: "USD" }));
  });

  test("moeda fora do formato ISO-4217 é recusada", async () => {
    await expectDatabaseError(
      insert("wallets", walletRow({ currency: "brl" })),
      SqlState.CheckViolation,
      "wallets_currency_iso4217",
    );
  });

  test("wallet nasce na versão 1", async () => {
    await expectDatabaseError(
      insert("wallets", walletRow({ version: 2 })),
      SqlState.CheckViolation,
      "must be created with version 1",
    );
  });

  test("wallet com saldo inicial exige o lançamento de abertura no ledger", async () => {
    await expectDatabaseError(
      insert("wallets", walletRow({ balance: "100.00" })),
      SqlState.CheckViolation,
      "has no opening ledger entry",
    );
  });

  test("version não muda sem mudança de saldo", async () => {
    const owner = await persistWallet(db.unitOfWork, "10.00");

    await expectDatabaseError(
      db.sql("update wallets set version = version + 1 where id = ?", [owner.wallet.id]),
      SqlState.CheckViolation,
      "must not change when the balance does not change",
    );
  });

  test("saldo não muda sem incrementar a version em exatamente 1", async () => {
    const owner = await persistWallet(db.unitOfWork, "10.00");

    await expectDatabaseError(
      db.sql("update wallets set balance = 5 where id = ?", [owner.wallet.id]),
      SqlState.CheckViolation,
      "must increase by exactly 1",
    );
    await expectDatabaseError(
      db.sql("update wallets set balance = 5, version = version + 2 where id = ?", [
        owner.wallet.id,
      ]),
      SqlState.CheckViolation,
      "must increase by exactly 1",
    );
  });

  test("saldo não muda sem lançamento correspondente no ledger (conferido no commit)", async () => {
    const owner = await persistWallet(db.unitOfWork, "10.00");

    await expectDatabaseError(
      db.sql("update wallets set balance = 5, version = version + 1 where id = ?", [
        owner.wallet.id,
      ]),
      SqlState.CheckViolation,
      "without a ledger entry",
    );
    const [row] = await db.sql<{ balance: string }[]>("select balance from wallets where id = ?", [
      owner.wallet.id,
    ]);
    expect(row?.balance).toBe("10.00");
  });

  test("player e moeda da wallet são imutáveis", async () => {
    const owner = await persistWallet(db.unitOfWork, "0.00");

    await expectDatabaseError(
      db.sql("update wallets set currency = 'USD' where id = ?", [owner.wallet.id]),
      SqlState.RestrictViolation,
      "identity columns are immutable",
    );
  });

  test("wallet não pode ser apagada", async () => {
    const owner = await persistWallet(db.unitOfWork, "0.00");

    await expectDatabaseError(
      db.sql("delete from wallets where id = ?", [owner.wallet.id]),
      SqlState.RestrictViolation,
    );
  });
});

describe("wager_transactions: idempotência", () => {
  test("idempotency key duplicada é recusada (UNIQUE)", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const first = transactionRow(owner);
    await insert("wager_transactions", first);

    await expectDatabaseError(
      insert(
        "wager_transactions",
        transactionRow(owner, { idempotency_key: first.idempotency_key }),
      ),
      SqlState.UniqueViolation,
      "wager_transactions_idempotency_key_unique",
    );
  });

  test("mesmo provider + id externo com outra chave é recusado (UNIQUE)", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const first = transactionRow(owner);
    await insert("wager_transactions", first);

    await expectDatabaseError(
      insert(
        "wager_transactions",
        transactionRow(owner, {
          external_transaction_id: first.external_transaction_id,
          idempotency_key: `other-key-${newId()}`,
        }),
      ),
      SqlState.UniqueViolation,
      "wager_transactions_provider_external_unique",
    );
  });

  test("insertIfAbsent não grava duplicata e devolve false, para as duas unicidades", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const original = newTransaction(owner.wallet.id, owner.wallet.playerId);
    const sameKey = newTransaction(owner.wallet.id, owner.wallet.playerId, {
      idempotencyKey: original.idempotencyKey,
    });
    const sameExternalId = newTransaction(owner.wallet.id, owner.wallet.playerId, {
      externalTransactionId: original.externalTransactionId,
      idempotencyKey: `other-key-${newId()}`,
    });

    const results = await db.unitOfWork.run(async ({ transactions }) => [
      await transactions.insertIfAbsent(original),
      await transactions.insertIfAbsent(sameKey),
      await transactions.insertIfAbsent(sameExternalId),
    ]);

    expect(results).toEqual([true, false, false]);
  });
});

describe("wager_transactions: regras por tipo e status", () => {
  test.each([
    ["kind desconhecido", { kind: "JACKPOT" }, "wager_transactions_kind_valid"],
    ["status desconhecido", { status: "DONE" }, "wager_transactions_status_valid"],
    [
      "failure_code desconhecido",
      { status: "REJECTED", failure_code: "NOPE" },
      "failure_code_valid",
    ],
    ["BET com valor zero", { amount: "0.00" }, "wager_transactions_amount_by_kind"],
    ["payload_hash fora de SHA-256 hex", { payload_hash: "x".repeat(64) }, "payload_hash_sha256"],
    ["REFUND sem referência", { kind: "REFUND" }, "wager_transactions_reference_by_kind"],
    [
      "BET com referência",
      { reference_external_transaction_id: "ext-0" },
      "wager_transactions_reference_by_kind",
    ],
    ["REJECTED sem failure_code", { status: "REJECTED" }, "failure_code_by_status"],
    ["PENDING com failure_code", { failure_code: "INSUFFICIENT_FUNDS" }, "failure_code_by_status"],
    [
      "FAILED com código de negócio",
      { status: "FAILED", failure_code: "INSUFFICIENT_FUNDS", processed_at: new Date() },
      "failed_is_infrastructure",
    ],
    [
      "REJECTED com código de infraestrutura",
      { status: "REJECTED", failure_code: "INFRASTRUCTURE_FAILURE", processed_at: new Date() },
      "rejected_is_business",
    ],
    [
      "PROCESSED sem processed_at",
      { status: "PROCESSED", balance_after: "90.00" },
      "processed_at_by_status",
    ],
    [
      "PROCESSED sem balance_after",
      { status: "PROCESSED", processed_at: new Date() },
      "processed_has_balance",
    ],
    ["identificador em branco", { round_id: "  " }, "identifiers_not_blank"],
  ] as const)("%s é recusado", async (_name, overrides, constraint) => {
    const owner = await persistWallet(db.unitOfWork);

    await expectDatabaseError(
      insert("wager_transactions", transactionRow(owner, overrides)),
      SqlState.CheckViolation,
      constraint,
    );
  });

  test("LOSS com valor zero é aceito", async () => {
    const owner = await persistWallet(db.unitOfWork);

    await insert("wager_transactions", transactionRow(owner, { kind: "LOSS", amount: "0.00" }));
  });

  test("transação de wallet inexistente é recusada (FK)", async () => {
    const owner = await persistWallet(db.unitOfWork);

    await expectDatabaseError(
      insert("wager_transactions", transactionRow(owner, { wallet_id: newId() })),
      SqlState.ForeignKeyViolation,
    );
  });

  test("PROCESSED que move saldo exige lançamento no ledger (conferido no commit)", async () => {
    const owner = await persistWallet(db.unitOfWork);

    await expectDatabaseError(
      insert(
        "wager_transactions",
        transactionRow(owner, {
          status: "PROCESSED",
          processed_at: new Date(),
          balance_after: "90.00",
        }),
      ),
      SqlState.CheckViolation,
      "has no ledger entry",
    );
  });
});

describe("wager_transactions: máquina de estados", () => {
  test("transação terminal não pode ser alterada", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const bet = await processedBet(owner);

    await expectDatabaseError(
      db.sql(
        "update wager_transactions set status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' where id = ?",
        [bet.id],
      ),
      SqlState.RestrictViolation,
      "(terminal) and cannot be modified",
    );
  });

  test("PENDING_REFERENCE não volta para PENDING", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const row = transactionRow(owner, {
      kind: "REFUND",
      reference_external_transaction_id: "ext-missing",
      status: "PENDING_REFERENCE",
    });
    await insert("wager_transactions", row);

    await expectDatabaseError(
      db.sql("update wager_transactions set status = 'PENDING' where id = ?", [row.id]),
      SqlState.CheckViolation,
      "invalid transaction status transition PENDING_REFERENCE -> PENDING",
    );
  });

  test("PENDING_REFERENCE pode ser reagendada sem mudar de status", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const row = transactionRow(owner, {
      kind: "REFUND",
      reference_external_transaction_id: "ext-missing",
      status: "PENDING_REFERENCE",
    });
    await insert("wager_transactions", row);

    await db.sql(
      "update wager_transactions set reference_attempts = reference_attempts + 1, next_reference_attempt_at = now() where id = ?",
      [row.id],
    );
  });

  test.each([
    ["amount", "amount = 999"],
    ["kind", "kind = 'WIN'"],
    ["wallet_id", "wallet_id = gen_random_uuid()"],
    ["payload_hash", `payload_hash = '${"a".repeat(64)}'`],
  ])("coluna de negócio %s é imutável, mesmo em PENDING", async (_column, assignment) => {
    const owner = await persistWallet(db.unitOfWork);
    const row = transactionRow(owner);
    await insert("wager_transactions", row);

    await expectDatabaseError(
      db.sql(`update wager_transactions set ${assignment} where id = ?`, [row.id]),
      SqlState.RestrictViolation,
      "business columns are immutable",
    );
  });

  test("transação não pode ser apagada", async () => {
    const owner = await persistWallet(db.unitOfWork);
    const row = transactionRow(owner);
    await insert("wager_transactions", row);

    await expectDatabaseError(
      db.sql("delete from wager_transactions where id = ?", [row.id]),
      SqlState.RestrictViolation,
    );
  });
});

describe("wager_transactions: reversão única no total", () => {
  test("REFUND e depois ROLLBACK da mesma BET: o banco barra a segunda reversão", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = await processedBet(owner, "30.00");
    const reversal = (kind: Kind.Refund | Kind.Rollback) =>
      newTransaction(owner.wallet.id, owner.wallet.playerId, {
        kind,
        money: brl("30.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      });

    const refund = await processTransaction(db.unitOfWork, reversal(Kind.Refund));
    expect(refund.status).toBe(Status.Processed);

    // A checagem do domínio é desligada: quem precisa barrar aqui é o índice único parcial.
    await expectDatabaseError(
      processTransaction(db.unitOfWork, reversal(Kind.Rollback), { skipDomainReversalCheck: true }),
      SqlState.UniqueViolation,
      "wager_transactions_single_reversal",
    );

    const [wallet] = await db.sql<{ balance: string }[]>(
      "select balance from wallets where id = ?",
      [owner.wallet.id],
    );
    expect(wallet?.balance).toBe("100.00");
  });
});

describe("wallet_ledger_entries: append-only", () => {
  test("UPDATE é recusado", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = await processedBet(owner);
    const entry = await ledgerRowOf(bet.id);

    await expectDatabaseError(
      db.sql("update wallet_ledger_entries set amount = 1 where id = ?", [entry.id]),
      SqlState.RestrictViolation,
      "UPDATE on wallet_ledger_entries is not allowed",
    );
  });

  test("DELETE é recusado", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = await processedBet(owner);
    const entry = await ledgerRowOf(bet.id);

    await expectDatabaseError(
      db.sql("delete from wallet_ledger_entries where id = ?", [entry.id]),
      SqlState.RestrictViolation,
      "DELETE on wallet_ledger_entries is not allowed",
    );
  });

  test("TRUNCATE é recusado", async () => {
    await expectDatabaseError(
      db.sql("truncate wallet_ledger_entries"),
      SqlState.RestrictViolation,
      "TRUNCATE on wallet_ledger_entries is not allowed",
    );
  });
});

describe("wallet_ledger_entries: aritmética e coerência", () => {
  /** Lançamento válido para a próxima versão de uma wallet recém-aberta com 100.00. */
  async function nextEntry(overrides: Row = {}) {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const row = transactionRow(owner);
    await insert("wager_transactions", row);
    return {
      owner,
      transactionId: row.id as string,
      entry: {
        id: newId(),
        wallet_id: owner.wallet.id,
        transaction_id: row.id,
        wallet_version: 2,
        direction: "DEBIT",
        amount: "10.00",
        currency: "BRL",
        balance_before: "100.00",
        balance_after: "90.00",
        created_at: new Date(),
        ...overrides,
      },
    };
  }

  test.each([
    [
      "débito com saldo final errado",
      { balance_after: "90.01" },
      "wallet_ledger_entries_arithmetic",
    ],
    ["direção trocada", { direction: "CREDIT" }, "wallet_ledger_entries_arithmetic"],
    ["valor zero", { amount: "0.00", balance_after: "100.00" }, "amount_positive"],
    [
      "saldo final negativo",
      { amount: "150.00", balance_after: "-50.00" },
      "balances_non_negative",
    ],
  ] as const)(
    "%s é recusado pelo CHECK, mesmo com os triggers desligados",
    async (_name, overrides, constraint) => {
      const { entry } = await nextEntry(overrides);

      await expectDatabaseError(
        insertWithoutTriggers("wallet_ledger_entries", entry),
        SqlState.CheckViolation,
        constraint,
      );
      // Com os triggers ligados, o banco também recusa (às vezes por uma regra que dispara antes).
      await expectDatabaseError(insert("wallet_ledger_entries", entry), SqlState.CheckViolation);
    },
  );

  test("moeda diferente da wallet é recusada", async () => {
    const { entry } = await nextEntry({ currency: "USD" });

    await expectDatabaseError(
      insert("wallet_ledger_entries", entry),
      SqlState.CheckViolation,
      "differs from wallet currency",
    );
  });

  test("valor diferente do da transação é recusado", async () => {
    const { entry } = await nextEntry({ amount: "20.00", balance_after: "80.00" });

    await expectDatabaseError(
      insert("wallet_ledger_entries", entry),
      SqlState.CheckViolation,
      "differs from its transaction amount",
    );
  });

  test("cadeia quebrada: saldo inicial diferente do saldo final anterior", async () => {
    const { entry } = await nextEntry({ balance_before: "50.00", balance_after: "40.00" });

    await expectDatabaseError(
      insert("wallet_ledger_entries", entry),
      SqlState.CheckViolation,
      "ledger chain broken",
    );
  });

  test("cadeia quebrada: versão pulada", async () => {
    const { entry } = await nextEntry({ wallet_version: 5 });

    await expectDatabaseError(
      insert("wallet_ledger_entries", entry),
      SqlState.CheckViolation,
      "missing entry for wallet version 4",
    );
  });

  test("dois lançamentos para a mesma versão da wallet são recusados (UNIQUE)", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = await processedBet(owner);
    const existing = await ledgerRowOf(bet.id);
    const other = transactionRow(owner);
    await insert("wager_transactions", other);

    await expectDatabaseError(
      insert("wallet_ledger_entries", {
        ...existing,
        id: newId(),
        transaction_id: other.id,
      }),
      SqlState.UniqueViolation,
      "wallet_ledger_entries_wallet_version_unique",
    );
  });

  test("dois lançamentos para a mesma transação na mesma wallet são recusados (UNIQUE)", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const bet = await processedBet(owner);
    const existing = await ledgerRowOf(bet.id);

    // Com os triggers ligados, a cadeia de versões já recusaria; sem eles, o índice único segura.
    await expectDatabaseError(
      insertWithoutTriggers("wallet_ledger_entries", {
        ...existing,
        id: newId(),
        wallet_version: 3,
      }),
      SqlState.UniqueViolation,
      "wallet_ledger_entries_wallet_transaction_unique",
    );
  });

  test("LOSS não gera lançamento", async () => {
    const owner = await persistWallet(db.unitOfWork, "100.00");
    const loss = transactionRow(owner, { kind: "LOSS" });
    await insert("wager_transactions", loss);

    await expectDatabaseError(
      insert("wallet_ledger_entries", {
        id: newId(),
        wallet_id: owner.wallet.id,
        transaction_id: loss.id,
        wallet_version: 2,
        direction: "DEBIT",
        amount: "10.00",
        currency: "BRL",
        balance_before: "100.00",
        balance_after: "90.00",
        created_at: new Date(),
      }),
      SqlState.CheckViolation,
      "LOSS transactions do not produce ledger entries",
    );
  });

  test("lançamento de transação que não está PROCESSED é recusado no commit", async () => {
    const { entry } = await nextEntry();

    await expectDatabaseError(
      insert("wallet_ledger_entries", entry),
      SqlState.CheckViolation,
      "not PROCESSED",
    );
  });
});

describe("inbox_messages e outbox_messages", () => {
  test("mensagem repetida na inbox do mesmo consumidor é recusada (PK)", async () => {
    const row = {
      consumer_name: "wager-transactions-consumer",
      message_id: `msg-${newId()}`,
      payload_hash: sha256("payload"),
      received_at: new Date(),
    };
    await insert("inbox_messages", row);

    await expectDatabaseError(
      insert("inbox_messages", row),
      SqlState.UniqueViolation,
      "inbox_messages_pk",
    );
  });

  test("a mesma mensagem pode ser registrada por consumidores diferentes", async () => {
    const messageId = `msg-${newId()}`;
    const row = { message_id: messageId, payload_hash: sha256("p"), received_at: new Date() };

    await insert("inbox_messages", { ...row, consumer_name: "consumer-a" });
    await insert("inbox_messages", { ...row, consumer_name: "consumer-b" });
  });

  test("outbox: o payload precisa ser o envelope do próprio evento (eventId = id)", async () => {
    await expectDatabaseError(
      insert("outbox_messages", {
        id: newId(),
        aggregate_id: "wallet-1",
        event_type: "WalletBalanceChanged",
        payload: JSON.stringify({ eventId: newId() }),
        occurred_at: new Date(),
        next_attempt_at: new Date(),
      }),
      SqlState.CheckViolation,
      "outbox_messages_payload_matches_id",
    );
  });

  test("outbox: attempts negativo é recusado", async () => {
    const id = newId();

    await expectDatabaseError(
      insert("outbox_messages", {
        id,
        aggregate_id: "wallet-1",
        event_type: "WalletBalanceChanged",
        payload: JSON.stringify({ eventId: id }),
        occurred_at: new Date(),
        attempts: -1,
        next_attempt_at: new Date(),
      }),
      SqlState.CheckViolation,
      "outbox_messages_attempts_non_negative",
    );
  });
});
