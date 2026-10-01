import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createDatabase } from "../../src/db";
import { applyMigrations, type Migration } from "../../src/db/migrations";

function inMemoryDatabase() {
  return createDatabase({ url: "file::memory:" });
}

test("opens an in-memory database and binds query values", () => {
  const database = inMemoryDatabase();

  try {
    database.exec("CREATE TABLE test_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    const value = "value containing ' SQL punctuation";
    database.run("INSERT INTO test_records (value) VALUES (?)", [value]);

    assert.deepEqual(
      database.get<{ id: number; value: string }>(
        "SELECT id, value FROM test_records WHERE value = ?",
        [value],
      ),
      { id: 1, value },
    );
    assert.deepEqual(
      database.all<{ value: string }>("SELECT value FROM test_records"),
      [{ value }],
    );
  } finally {
    database.close();
  }
});

test("creates parent directories and persists a file-backed database", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-db-"));
  const url = `file:${join(directory, "nested", "persistence.sqlite")}` as const;

  try {
    const firstDatabase = createDatabase({ url });
    firstDatabase.exec("CREATE TABLE persisted_records (value TEXT NOT NULL)");
    firstDatabase.run("INSERT INTO persisted_records (value) VALUES (?)", ["saved"]);
    firstDatabase.close();

    const reopenedDatabase = createDatabase({ url });
    try {
      assert.deepEqual(
        reopenedDatabase.get<{ value: string }>("SELECT value FROM persisted_records"),
        { value: "saved" },
      );
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("commits successful transactions and rolls back failed transactions", () => {
  const database = inMemoryDatabase();

  try {
    database.exec("CREATE TABLE transaction_records (value TEXT NOT NULL)");
    database.transaction(() => {
      database.run("INSERT INTO transaction_records (value) VALUES (?)", ["committed"]);
    });

    assert.throws(() =>
      database.transaction(() => {
        database.run("INSERT INTO transaction_records (value) VALUES (?)", ["rolled back"]);
        throw new Error("rollback test");
      }),
    );

    assert.deepEqual(
      database.all<{ value: string }>("SELECT value FROM transaction_records"),
      [{ value: "committed" }],
    );
  } finally {
    database.close();
  }
});

test("applies migrations once in deterministic order and persists their state", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-migrations-"));
  const url = `file:${join(directory, "migrations.sqlite")}` as const;
  const calls: string[] = [];
  const migrations: readonly Migration[] = [
    { id: "002-second", up: () => calls.push("second") },
    { id: "001-first", up: () => calls.push("first") },
  ];

  try {
    const firstDatabase = createDatabase({ url });
    assert.deepEqual(applyMigrations(firstDatabase, migrations), ["001-first", "002-second"]);
    firstDatabase.close();

    const reopenedDatabase = createDatabase({ url });
    try {
      assert.deepEqual(applyMigrations(reopenedDatabase, migrations), []);
      assert.deepEqual(calls, ["first", "second"]);
      assert.deepEqual(
        reopenedDatabase.all<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id"),
        [{ id: "001-first" }, { id: "002-second" }],
      );
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects duplicate migration IDs", () => {
  const database = inMemoryDatabase();

  try {
    assert.throws(
      () =>
        applyMigrations(database, [
          { id: "001-duplicate", up: () => undefined },
          { id: "001-duplicate", up: () => undefined },
        ]),
      /Duplicate migration ID/,
    );
  } finally {
    database.close();
  }
});

test("does not record or retain a failed migration", () => {
  const database = inMemoryDatabase();

  try {
    assert.throws(
      () =>
        applyMigrations(database, [
          {
            id: "001-fails",
            up: (migrationDatabase) => {
              migrationDatabase.exec("CREATE TABLE migration_failure_probe (value TEXT)");
              throw new Error("migration failure");
            },
          },
        ]),
      /migration failure/,
    );

    assert.equal(
      database.get<{ id: string }>(
        "SELECT id FROM schema_migrations WHERE id = ?",
        ["001-fails"],
      ),
      undefined,
    );
    assert.equal(
      database.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["migration_failure_probe"],
      ),
      undefined,
    );
  } finally {
    database.close();
  }
});
