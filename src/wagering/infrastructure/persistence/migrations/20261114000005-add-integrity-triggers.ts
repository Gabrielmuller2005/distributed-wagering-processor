import { Migration } from "@mikro-orm/migrations";

/**
 * Invariantes que um CHECK sozinho não expressa (comparam linhas, estados anteriores ou tabelas
 * diferentes) viram triggers. Assim o banco protege as regras mesmo contra SQL manual ou bug na
 * aplicação, e não só o código.
 *
 * Códigos de erro (SQLSTATE), todos da classe 23 (violação de integridade):
 * - 23001 restrict_violation: tentativa de alterar ou apagar o que é imutável;
 * - 23514 check_violation: regra violada (transição inválida, cadeia do ledger quebrada etc.).
 */
export class AddIntegrityTriggers20261114000005 extends Migration {
  override async up(): Promise<void> {
    // ---------------------------------------------------------------------------------------
    // Imutabilidade genérica: usada no ledger (UPDATE/DELETE/TRUNCATE) e nas tabelas de
    // auditoria (DELETE/TRUNCATE em wallets e wager_transactions).
    this.addSql(`
      create function wagering_forbid_modification() returns trigger
      language plpgsql as $$
      begin
        raise exception '% on % is not allowed', tg_op, tg_table_name
          using errcode = 'restrict_violation',
                hint = 'ledger entries are append-only; wallets and transactions are audit records';
      end;
      $$
    `);

    // ---------------------------------------------------------------------------------------
    // Ledger: append-only.
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function wagering_forbid_modification()
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wagering_forbid_modification()
    `);

    // Ledger: coerência com a wallet e com a transação, e continuidade da cadeia de versões.
    this.addSql(`
      create function wallet_ledger_entries_check_insert() returns trigger
      language plpgsql as $$
      declare
        wallet_currency char(3);
        tx record;
        previous_balance_after numeric(19, 2);
      begin
        select currency into wallet_currency from wallets where id = new.wallet_id;
        if wallet_currency is distinct from new.currency then
          raise exception 'ledger entry currency % differs from wallet currency %',
            new.currency, wallet_currency using errcode = 'check_violation';
        end if;

        select wallet_id, kind, amount, currency into tx
          from wager_transactions where id = new.transaction_id;
        if tx.wallet_id is distinct from new.wallet_id then
          raise exception 'ledger entry wallet differs from its transaction wallet'
            using errcode = 'check_violation';
        end if;
        if tx.kind = 'LOSS' then
          raise exception 'LOSS transactions do not produce ledger entries'
            using errcode = 'check_violation';
        end if;
        if tx.amount <> new.amount or tx.currency <> new.currency then
          raise exception 'ledger entry amount differs from its transaction amount'
            using errcode = 'check_violation';
        end if;

        -- Cadeia: o saldo inicial deste lançamento é o saldo final do lançamento anterior.
        -- Sem anterior, só pode ser o primeiro movimento da wallet (versão 1 na abertura com
        -- saldo, ou versão 2 numa wallet aberta com saldo zero), partindo de zero.
        select balance_after into previous_balance_after
          from wallet_ledger_entries
          where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
        if found then
          if previous_balance_after <> new.balance_before then
            raise exception 'ledger chain broken: entry % starts at %, previous ended at %',
              new.wallet_version, new.balance_before, previous_balance_after
              using errcode = 'check_violation';
          end if;
        elsif not (new.wallet_version <= 2 and new.balance_before = 0) then
          raise exception 'ledger chain broken: missing entry for wallet version %',
            new.wallet_version - 1 using errcode = 'check_violation';
        end if;

        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_check_insert
        before insert on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_check_insert()
    `);

    // Ledger, conferido no commit: só existe lançamento de transação PROCESSED, e a wallet
    // chegou (pelo menos) à versão que o lançamento diz ter produzido.
    this.addSql(`
      create function wallet_ledger_entries_check_commit() returns trigger
      language plpgsql as $$
      begin
        if not exists (
          select 1 from wager_transactions where id = new.transaction_id and status = 'PROCESSED'
        ) then
          raise exception 'ledger entry % belongs to a transaction that is not PROCESSED', new.id
            using errcode = 'check_violation';
        end if;
        if not exists (
          select 1 from wallets where id = new.wallet_id and version >= new.wallet_version
        ) then
          raise exception 'ledger entry % is ahead of its wallet version', new.id
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_check_commit
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_commit()
    `);

    // ---------------------------------------------------------------------------------------
    // Wallets: colunas de identidade imutáveis; version acompanha o saldo (regra 6.2).
    this.addSql(`
      create function wallets_check_update() returns trigger
      language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at)
           is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet identity columns are immutable'
            using errcode = 'restrict_violation';
        end if;
        if new.balance <> old.balance and new.version <> old.version + 1 then
          raise exception 'wallet version must increase by exactly 1 when the balance changes'
            using errcode = 'check_violation';
        end if;
        if new.balance = old.balance and new.version <> old.version then
          raise exception 'wallet version must not change when the balance does not change'
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wallets_check_update
        before update on wallets
        for each row execute function wallets_check_update()
    `);
    this.addSql(`
      create trigger wallets_no_delete
        before delete on wallets
        for each row execute function wagering_forbid_modification()
    `);
    this.addSql(`
      create trigger wallets_no_truncate
        before truncate on wallets
        for each statement execute function wagering_forbid_modification()
    `);

    // Wallets, conferido no commit: toda mudança de saldo tem o seu lançamento no ledger
    // (mesma versão, mesmo saldo antes e depois). Uma wallet nasce na versão 1, e um saldo
    // inicial positivo exige o lançamento de abertura.
    this.addSql(`
      create function wallets_check_ledger_chain() returns trigger
      language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'wallet % must be created with version 1', new.id
              using errcode = 'check_violation';
          end if;
          if new.balance > 0 and not exists (
            select 1 from wallet_ledger_entries
            where wallet_id = new.id and wallet_version = 1
              and direction = 'CREDIT' and balance_before = 0 and balance_after = new.balance
          ) then
            raise exception 'wallet % opened with balance % but has no opening ledger entry',
              new.id, new.balance using errcode = 'check_violation';
          end if;
        elsif new.balance <> old.balance and not exists (
          select 1 from wallet_ledger_entries
          where wallet_id = new.id and wallet_version = new.version
            and balance_before = old.balance and balance_after = new.balance
        ) then
          raise exception 'wallet % balance changed from % to % without a ledger entry',
            new.id, old.balance, new.balance using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wallets_check_ledger_chain
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_check_ledger_chain()
    `);

    // ---------------------------------------------------------------------------------------
    // Transações: máquina de estados e colunas de negócio imutáveis.
    this.addSql(`
      create function wager_transactions_check_update() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transaction % is % (terminal) and cannot be modified',
            old.id, old.status using errcode = 'restrict_violation';
        end if;
        if new.status <> old.status and not (
          (old.status = 'PENDING'
            and new.status in ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'))
          or (old.status = 'PENDING_REFERENCE'
            and new.status in ('PROCESSED', 'REJECTED', 'FAILED'))
        ) then
          raise exception 'invalid transaction status transition % -> %', old.status, new.status
            using errcode = 'check_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
            new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
            new.kind, new.amount, new.currency, new.reference_external_transaction_id,
            new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
            old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
            old.kind, old.amount, old.currency, old.reference_external_transaction_id,
            old.created_at) then
          raise exception 'transaction % business columns are immutable', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$
    `);
    this.addSql(`
      create trigger wager_transactions_check_update
        before update on wager_transactions
        for each row execute function wager_transactions_check_update()
    `);
    this.addSql(`
      create trigger wager_transactions_no_delete
        before delete on wager_transactions
        for each row execute function wagering_forbid_modification()
    `);
    this.addSql(`
      create trigger wager_transactions_no_truncate
        before truncate on wager_transactions
        for each statement execute function wagering_forbid_modification()
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop trigger wager_transactions_no_truncate on wager_transactions");
    this.addSql("drop trigger wager_transactions_no_delete on wager_transactions");
    this.addSql("drop trigger wager_transactions_check_update on wager_transactions");
    this.addSql("drop function wager_transactions_check_update()");

    this.addSql("drop trigger wallets_check_ledger_chain on wallets");
    this.addSql("drop function wallets_check_ledger_chain()");
    this.addSql("drop trigger wallets_no_truncate on wallets");
    this.addSql("drop trigger wallets_no_delete on wallets");
    this.addSql("drop trigger wallets_check_update on wallets");
    this.addSql("drop function wallets_check_update()");

    this.addSql("drop trigger wallet_ledger_entries_check_commit on wallet_ledger_entries");
    this.addSql("drop function wallet_ledger_entries_check_commit()");
    this.addSql("drop trigger wallet_ledger_entries_check_insert on wallet_ledger_entries");
    this.addSql("drop function wallet_ledger_entries_check_insert()");
    this.addSql("drop trigger wallet_ledger_entries_no_truncate on wallet_ledger_entries");
    this.addSql("drop trigger wallet_ledger_entries_immutable on wallet_ledger_entries");

    this.addSql("drop function wagering_forbid_modification()");
  }
}
