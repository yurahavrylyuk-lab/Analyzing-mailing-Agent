import { strict as assert } from "node:assert";
import { test } from "node:test";

import { loadConfig } from "../../src/config/env";

test("uses development defaults for an empty environment", () => {
  const config = loadConfig({});

  assert.deepEqual(config, {
    environment: "development",
    logLevel: "debug",
    database: { url: "file:./data/delta-qoralis.sqlite" },
  });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.database));
});

test("parses valid environment and log level values", () => {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" });

  assert.deepEqual(config, {
    environment: "test",
    logLevel: "error",
    database: { url: "file::memory:" },
  });
});

test("uses context-sensitive log level defaults", () => {
  assert.equal(loadConfig({ NODE_ENV: "test" }).logLevel, "warn");
  assert.equal(
    loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "file:./production.sqlite",
    }).logLevel,
    "info",
  );
});

test("uses context-sensitive database URL defaults", () => {
  assert.equal(
    loadConfig({ NODE_ENV: "test" }).database.url,
    "file::memory:",
  );
});

test("accepts an explicit SQLite database URL", () => {
  assert.equal(
    loadConfig({ DATABASE_URL: "file:./custom.sqlite" }).database.url,
    "file:./custom.sqlite",
  );
});

test("requires a database URL in production", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /DATABASE_URL must be explicitly configured in production/,
  );
});

test("rejects unsupported database URLs without revealing their contents", () => {
  const secretUrl = "postgres://user:do-not-expose-this-secret@example.test/db";

  assert.throws(
    () => loadConfig({ DATABASE_URL: secretUrl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid DATABASE_URL/);
      assert.doesNotMatch(error.message, /do-not-expose-this-secret/);
      return true;
    },
  );
});

test("rejects an invalid NODE_ENV without revealing unrelated secrets", () => {
  const secret = "do-not-expose-this-secret";

  assert.throws(
    () => loadConfig({ NODE_ENV: "banana", OPENAI_API_KEY: secret }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid NODE_ENV/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("rejects an invalid LOG_LEVEL", () => {
  assert.throws(() => loadConfig({ LOG_LEVEL: "verbose" }), /Invalid LOG_LEVEL/);
});

test("allows future provider variables to remain unset", () => {
  assert.doesNotThrow(() =>
    loadConfig({
      DATABASE_URL: undefined,
      GOOGLE_PLACES_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      GMAIL_CLIENT_SECRET: undefined,
      PAYPAL_CLIENT_SECRET: undefined,
    }),
  );
});
