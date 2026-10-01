import type { AppConfig } from "../config";
import type { Database } from "./database";
import { SqliteDatabase } from "./sqlite-database";

export type { Database, RunResult, SqlParameters, SqlValue } from "./database";
export { applyMigrations } from "./migrations";
export type { Migration } from "./migrations";
export { SqliteDatabase } from "./sqlite-database";

/** Opens the configured local SQLite implementation behind the database contract. */
export function createDatabase(configuration: AppConfig["database"]): Database {
  return new SqliteDatabase(configuration.url);
}
