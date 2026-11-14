import { Migration } from "@mikro-orm/migrations";

/**
 * Fecha o "vice-versa" da invariante 6.2 no banco: toda transação PROCESSED que move saldo
 * (todas menos LOSS) tem exatamente o seu lançamento no ledger, e LOSS nunca tem.
 *
 * A outra direção (lançamento só de transação PROCESSED) já é garantida pela migration de
 * integridade. Conferido no commit, porque transação e lançamento são gravados em sequência
 * dentro da mesma transação SQL.
 */
export class RequireLedgerEntryForProcessedTransactions20261114000006 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function wager_transactions_check_ledger_entry() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'PROCESSED' and new.kind <> 'LOSS' and not exists (
          select 1 from wallet_ledger_entries where transaction_id = new.id
        ) then
          raise exception 'transaction % is PROCESSED but has no ledger entry', new.id
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$
    `);
    this.addSql(`
      create constraint trigger wager_transactions_check_ledger_entry
        after insert or update on wager_transactions
        deferrable initially deferred
        for each row execute function wager_transactions_check_ledger_entry()
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop trigger wager_transactions_check_ledger_entry on wager_transactions");
    this.addSql("drop function wager_transactions_check_ledger_entry()");
  }
}
