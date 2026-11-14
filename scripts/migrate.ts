// Executa as migrations do banco.
//   bun run db:migrate          aplica todas as pendentes
//   bun run db:migrate:down     desfaz a última aplicada
//   bun run db:migrate:down -- --all   desfaz todas
//   bun run db:migrate:status   lista aplicadas e pendentes
import { loadConfig } from "../src/config/app-config";
import { createOrm } from "../src/wagering/infrastructure/persistence/mikro-orm";

const [command = "up", ...flags] = process.argv.slice(2);
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const orm = await createOrm(loadConfig(process.env).database);

try {
  const migrator = orm.migrator;

  switch (command) {
    case "up": {
      const applied = await migrator.up();
      for (const migration of applied) log(`  [applied] ${migration.name}`);
      log(applied.length === 0 ? "Nothing to migrate." : `Applied ${applied.length} migration(s).`);
      break;
    }
    case "down": {
      const reverted = flags.includes("--all")
        ? await migrator.down({ to: 0 })
        : await migrator.down();
      for (const migration of reverted) log(`  [reverted] ${migration.name}`);
      log(`Reverted ${reverted.length} migration(s).`);
      break;
    }
    case "status": {
      const executed = await migrator.getExecuted();
      const pending = await migrator.getPending();
      for (const migration of executed) log(`  [applied] ${migration.name}`);
      for (const migration of pending) log(`  [pending] ${migration.name}`);
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use: up | down [--all] | status`);
  }
} catch (error: unknown) {
  process.stderr.write(
    `Migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  await orm.close(true);
}
