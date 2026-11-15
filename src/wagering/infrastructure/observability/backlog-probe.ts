import type { MikroORM } from "@mikro-orm/postgresql";
import type { BacklogProbe, BacklogSnapshot } from "./wagering-metrics";

interface BacklogRow {
  outbox_pending: unknown;
  outbox_oldest_age_seconds: unknown;
  pending_references: unknown;
}

/**
 * Lê, numa consulta só, o tamanho e a idade da outbox pendente e quantas transações esperam
 * referência. Os dois filtros (`published_at is null`, `status = 'PENDING_REFERENCE'`) são os
 * predicados dos índices parciais, então a consulta só percorre o que está pendente.
 */
export function databaseBacklogProbe(orm: MikroORM): BacklogProbe {
  return async (): Promise<BacklogSnapshot> => {
    const rows = await orm.em.fork().execute<BacklogRow[]>(`
      select
        (select count(*) from outbox_messages where published_at is null)::int as outbox_pending,
        coalesce(extract(epoch from now() - (
          select min(occurred_at) from outbox_messages where published_at is null
        )), 0)::float8 as outbox_oldest_age_seconds,
        (select count(*) from wager_transactions where status = 'PENDING_REFERENCE')::int
          as pending_references
    `);
    const row = rows[0];
    return {
      outboxPending: numeric(row?.outbox_pending),
      outboxOldestAgeSeconds: Math.max(0, numeric(row?.outbox_oldest_age_seconds)),
      pendingReferences: numeric(row?.pending_references),
    };
  };
}

/**
 * Contagens e idades (nunca dinheiro). Os casts `::int` e `::float8` da consulta fazem o driver
 * devolver number; qualquer outra coisa vira 0 em vez de quebrar o scrape.
 */
function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
