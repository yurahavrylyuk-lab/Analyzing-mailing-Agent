import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import BetterSqlite3 from "better-sqlite3";

import type { SQLiteDatabaseUrl } from "../config";
import type { Database, RunResult, SqlParameters, SqlValue } from "./database";

function isWithinDirectory(directory: string, target: string): boolean {
  const relativePath = relative(directory, target);

  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function isPositionalParameters(
  parameters: SqlParameters,
): parameters is readonly SqlValue[] {
  return Array.isArray(parameters);
}

function filenameFromUrl(databaseUrl: SQLiteDatabaseUrl): string {
  const filename = databaseUrl.slice("file:".length);

  if (filename === ":memory:") {
    return filename;
  }

  const absoluteFilename = resolve(filename);
  const sourceDirectory = resolve(process.cwd(), "src");

  if (isWithinDirectory(sourceDirectory, absoluteFilename)) {
    throw new Error("DATABASE_URL must not create a database inside the source directory.");
  }

  mkdirSync(dirname(absoluteFilename), { recursive: true });
  return absoluteFilename;
}

export class SqliteDatabase implements Database {
  private readonly sqlite: BetterSqlite3.Database;
  private closed = false;

  constructor(databaseUrl: SQLiteDatabaseUrl) {
    this.sqlite = new BetterSqlite3(filenameFromUrl(databaseUrl));
    this.sqlite.pragma("foreign_keys = ON");
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  run(sql: string, parameters?: SqlParameters): RunResult {
    if (parameters === undefined) {
      return this.sqlite.prepare(sql).run();
    }

    if (isPositionalParameters(parameters)) {
      return this.sqlite.prepare<SqlValue[]>(sql).run(...parameters);
    }

    return this.sqlite.prepare<Record<string, SqlValue>>(sql).run({ ...parameters });
  }

  get<T>(sql: string, parameters?: SqlParameters): T | undefined {
    if (parameters === undefined) {
      return this.sqlite.prepare<SqlValue[], T>(sql).get();
    }

    if (isPositionalParameters(parameters)) {
      return this.sqlite.prepare<SqlValue[], T>(sql).get(...parameters);
    }

    return this.sqlite.prepare<Record<string, SqlValue>, T>(sql).get({ ...parameters });
  }

  all<T>(sql: string, parameters?: SqlParameters): T[] {
    if (parameters === undefined) {
      return this.sqlite.prepare<SqlValue[], T>(sql).all();
    }

    if (isPositionalParameters(parameters)) {
      return this.sqlite.prepare<SqlValue[], T>(sql).all(...parameters);
    }

    return this.sqlite.prepare<Record<string, SqlValue>, T>(sql).all({ ...parameters });
  }

  transaction<T>(operation: () => T): T {
    return this.sqlite.transaction(operation)();
  }

  close(): void {
    if (!this.closed) {
      this.sqlite.close();
      this.closed = true;
    }
  }
}
