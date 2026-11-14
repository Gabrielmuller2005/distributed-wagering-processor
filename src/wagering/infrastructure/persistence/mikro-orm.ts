import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, MikroORM } from "@mikro-orm/postgresql";
import type { AppConfig } from "../../../config/app-config";
import { MIGRATIONS } from "./migrations";
import { PERSISTENCE_ENTITIES } from "./records";

export type DatabaseConfig = AppConfig["database"];

export function mikroOrmConfig(database: DatabaseConfig) {
  return defineConfig({
    clientUrl: database.url,
    entities: PERSISTENCE_ENTITIES,
    extensions: [Migrator],
    pool: { min: 0, max: database.poolMax },
    debug: false,
    migrations: {
      migrationsList: MIGRATIONS,
      tableName: "mikro_orm_migrations",
      // O script de migrations imprime o próprio resumo; o log interno do migrator só polui.
      silent: true,
      // As migrations são escritas à mão; o snapshot do gerador automático não é usado.
      snapshot: false,
      // Cada execução roda numa transação: ou todas as migrations pendentes aplicam, ou nenhuma.
      transactional: true,
      allOrNothing: true,
    },
  });
}

export function createOrm(database: DatabaseConfig): Promise<MikroORM> {
  return MikroORM.init(mikroOrmConfig(database));
}
