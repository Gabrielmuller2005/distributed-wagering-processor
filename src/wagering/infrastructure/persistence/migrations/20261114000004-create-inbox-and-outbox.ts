import { Migration } from "@mikro-orm/migrations";

/** Inbox (deduplicação de mensagens consumidas) e outbox (eventos a publicar). */
export class CreateInboxAndOutbox20261114000004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pk primary key (consumer_name, message_id),
        constraint inbox_messages_payload_hash_sha256 check (payload_hash ~ '^[0-9a-f]{64}$')
      )
    `);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        published_at timestamptz,
        last_error text,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0),
        -- O payload é o envelope do próprio evento: o id da mensagem é o eventId.
        constraint outbox_messages_payload_matches_id check (payload ->> 'eventId' = id::text)
      )
    `);
    // O publisher só varre o que está pendente; mensagens publicadas saem do índice.
    this.addSql(`
      create index outbox_messages_pending_due
        on outbox_messages (next_attempt_at)
        where published_at is null
    `);
  }

  override async down(): Promise<void> {
    this.addSql("drop table outbox_messages");
    this.addSql("drop table inbox_messages");
  }
}
