import type { MigrationObject } from "@mikro-orm/core";
import { CreateWallets20261114000001 } from "./20261114000001-create-wallets";
import { CreateWagerTransactions20261114000002 } from "./20261114000002-create-wager-transactions";
import { CreateWalletLedgerEntries20261114000003 } from "./20261114000003-create-wallet-ledger-entries";
import { CreateInboxAndOutbox20261114000004 } from "./20261114000004-create-inbox-and-outbox";
import { AddIntegrityTriggers20261114000005 } from "./20261114000005-add-integrity-triggers";

/**
 * Lista explícita e ordenada das migrations. Sem glob nem descoberta por diretório: a ordem
 * é revisável no código, e o mesmo conjunto roda igual no Bun, nos testes e no container.
 * O nome registrado é o que fica gravado na tabela mikro_orm_migrations: nunca renomeie.
 */
export const MIGRATIONS: MigrationObject[] = [
  { name: "20261114000001-create-wallets", class: CreateWallets20261114000001 },
  {
    name: "20261114000002-create-wager-transactions",
    class: CreateWagerTransactions20261114000002,
  },
  {
    name: "20261114000003-create-wallet-ledger-entries",
    class: CreateWalletLedgerEntries20261114000003,
  },
  { name: "20261114000004-create-inbox-and-outbox", class: CreateInboxAndOutbox20261114000004 },
  { name: "20261114000005-add-integrity-triggers", class: AddIntegrityTriggers20261114000005 },
];
