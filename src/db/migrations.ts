import type { Database } from "./database";

export interface Migration {
  readonly id: string;
  up(database: Database): void;
}

interface AppliedMigration {
  readonly id: string;
}

function validatedMigrations(migrations: readonly Migration[]): Migration[] {
  const ids = new Set<string>();

  for (const migration of migrations) {
    if (migration.id.length === 0) {
      throw new Error("Migration IDs must not be empty.");
    }

    if (ids.has(migration.id)) {
      throw new Error(`Duplicate migration ID: ${migration.id}.`);
    }

    ids.add(migration.id);
  }

  return [...migrations].sort((first, second) => first.id.localeCompare(second.id));
}

function ensureMigrationTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/** Applies each pending, uniquely identified migration in deterministic order. */
export function applyMigrations(
  database: Database,
  migrations: readonly Migration[],
): string[] {
  const orderedMigrations = validatedMigrations(migrations);
  ensureMigrationTable(database);

  const appliedIds = new Set(
    database
      .all<AppliedMigration>("SELECT id FROM schema_migrations")
      .map((migration) => migration.id),
  );
  const newlyApplied: string[] = [];

  for (const migration of orderedMigrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    database.transaction(() => {
      migration.up(database);
      database.run("INSERT INTO schema_migrations (id) VALUES (?)", [migration.id]);
    });
    newlyApplied.push(migration.id);
  }

  return newlyApplied;
}
