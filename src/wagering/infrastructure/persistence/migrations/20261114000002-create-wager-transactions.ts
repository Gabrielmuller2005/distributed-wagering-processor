import { Migration } from "@mikro-orm/migrations";

/**
 * Transações de aposta: idempotência, máquina de estados e regras por tipo garantidas no schema.
 */
export class CreateWagerTransactions20261114000002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets (id),
        player_id text not null,
        round_id text not null,
        game_id text not null,
        kind text not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions (id),
        status text not null,
        failure_code text,
        balance_after numeric(19, 2),
        processed_at timestamptz,
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,

        -- Idempotência: a chave e o par (provider, id externo) são únicos.
        constraint wager_transactions_idempotency_key_unique unique (idempotency_key),
        constraint wager_transactions_provider_external_unique
          unique (provider_id, external_transaction_id),

        constraint wager_transactions_identifiers_not_blank check (
          length(trim(provider_id)) between 1 and 128
          and length(trim(external_transaction_id)) between 1 and 128
          and length(trim(idempotency_key)) between 1 and 255
          and length(trim(player_id)) between 1 and 128
          and length(trim(round_id)) between 1 and 128
          and length(trim(game_id)) between 1 and 128
        ),
        constraint wager_transactions_payload_hash_sha256 check (payload_hash ~ '^[0-9a-f]{64}$'),
        constraint wager_transactions_currency_iso4217 check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_kind_valid
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        constraint wager_transactions_failure_code_valid check (failure_code in (
          'INSUFFICIENT_FUNDS', 'REVERSAL_WOULD_OVERDRAW', 'REFERENCE_NOT_FOUND',
          'REFERENCE_MISMATCH', 'INVALID_REFERENCE_KIND', 'REFERENCE_NOT_PROCESSED',
          'ALREADY_REVERSED', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'PLAYER_MISMATCH',
          'INFRASTRUCTURE_FAILURE'
        )),

        -- Valor: LOSS aceita zero; os demais tipos exigem valor positivo.
        constraint wager_transactions_amount_by_kind check (
          (kind = 'LOSS' and amount >= 0) or (kind <> 'LOSS' and amount > 0)
        ),

        -- Referência: obrigatória em REFUND/ROLLBACK, proibida em BET/OPENING, opcional em WIN/LOSS.
        constraint wager_transactions_reference_by_kind check (
          (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
          or (kind in ('BET', 'OPENING') and reference_external_transaction_id is null)
          or kind in ('WIN', 'LOSS')
        ),
        constraint wager_transactions_no_self_reference check (
          reference_transaction_id is distinct from id
          and reference_external_transaction_id is distinct from external_transaction_id
        ),

        -- Coerência entre status e resultado.
        constraint wager_transactions_failure_code_by_status check (
          (status in ('REJECTED', 'FAILED')) = (failure_code is not null)
        ),
        constraint wager_transactions_failed_is_infrastructure check (
          status <> 'FAILED' or failure_code = 'INFRASTRUCTURE_FAILURE'
        ),
        constraint wager_transactions_rejected_is_business check (
          status <> 'REJECTED' or failure_code <> 'INFRASTRUCTURE_FAILURE'
        ),
        constraint wager_transactions_processed_at_by_status check (
          (status in ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at is not null)
        ),
        constraint wager_transactions_processed_has_balance check (
          status <> 'PROCESSED' or balance_after is not null
        ),
        constraint wager_transactions_balance_after_non_negative check (balance_after >= 0),
        constraint wager_transactions_reference_attempts_non_negative
          check (reference_attempts >= 0)
      )
    `);

    // Reversão única no total: no máximo um REFUND ou ROLLBACK PROCESSED por referência.
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED'
    `);
    this.addSql(
      "create index wager_transactions_wallet_created on wager_transactions (wallet_id, created_at)",
    );
    // Fila do worker de PENDING_REFERENCE: só as linhas pendentes entram no índice.
    this.addSql(`
      create index wager_transactions_pending_reference_due
        on wager_transactions (next_reference_attempt_at)
        where status = 'PENDING_REFERENCE'
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop table wager_transactions");
  }
}
