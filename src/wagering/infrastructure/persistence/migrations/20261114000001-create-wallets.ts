import { Migration } from "@mikro-orm/migrations";

/**
 * Carteiras. Unicidade por player + moeda e saldo não negativo garantidos pelo banco.
 * Dinheiro em numeric(19,2), nunca em float; moeda em formato ISO-4217.
 */
export class CreateWallets20261114000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id text not null,
        currency char(3) not null,
        balance numeric(19, 2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_player_id_not_blank check (length(trim(player_id)) between 1 and 128),
        constraint wallets_currency_iso4217 check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1)
      )
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop table wallets");
  }
}
