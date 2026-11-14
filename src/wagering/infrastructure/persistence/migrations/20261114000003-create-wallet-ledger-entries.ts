import { Migration } from "@mikro-orm/migrations";

/**
 * Ledger da wallet: aritmética, unicidade e encadeamento por versão garantidos no schema.
 * A imutabilidade (sem UPDATE, DELETE ou TRUNCATE) vem dos triggers da migration de integridade.
 */
export class CreateWalletLedgerEntries20261114000003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets (id),
        transaction_id uuid not null references wager_transactions (id),
        wallet_version integer not null,
        direction text not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        balance_before numeric(19, 2) not null,
        balance_after numeric(19, 2) not null,
        created_at timestamptz not null,

        -- Uma transação gera no máximo um lançamento por wallet.
        constraint wallet_ledger_entries_wallet_transaction_unique
          unique (wallet_id, transaction_id),
        -- Cada versão da wallet tem no máximo um lançamento: o ledger é uma cadeia sem bifurcação.
        constraint wallet_ledger_entries_wallet_version_unique unique (wallet_id, wallet_version),

        constraint wallet_ledger_entries_wallet_version_positive check (wallet_version >= 1),
        constraint wallet_ledger_entries_direction_valid check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_currency_iso4217 check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative
          check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_arithmetic check (
          (direction = 'DEBIT' and balance_after = balance_before - amount)
          or (direction = 'CREDIT' and balance_after = balance_before + amount)
        )
      )
    `);
    this.addSql(
      "create index wallet_ledger_entries_transaction on wallet_ledger_entries (transaction_id)",
    );
  }

  override async down(): Promise<void> {
    this.addSql("drop table wallet_ledger_entries");
  }
}
