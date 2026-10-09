import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DiscoveryConfigurationError,
  loadConfig,
} from "../../src/config";

test("uses development defaults for an empty environment", () => {
  const config = loadConfig({});

  assert.deepEqual(config, {
    environment: "development",
    logLevel: "debug",
    database: { url: "file:./data/delta-qoralis.sqlite" },
    discovery: { provider: "disabled" },
  });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.database));
  assert.ok(Object.isFrozen(config.discovery));
});

test("parses valid environment and log level values", () => {
  const config = loadConfig({ NODE_ENV: "test", LOG_LEVEL: "error" });

  assert.deepEqual(config, {
    environment: "test",
    logLevel: "error",
    database: { url: "file::memory:" },
    discovery: { provider: "disabled" },
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

test("keeps discovery disabled when explicitly disabled without a key", () => {
  assert.deepEqual(loadConfig({ DISCOVERY_PROVIDER: "disabled" }).discovery, {
    provider: "disabled",
  });
});

test("disabled discovery ignores unused malformed Geoapify keys", () => {
  for (const apiKey of ["", "   ", "bad key", "bad\u0000key"]) {
    const discovery = loadConfig({
      DISCOVERY_PROVIDER: "disabled",
      GEOAPIFY_API_KEY: apiKey,
    }).discovery;

    assert.deepEqual(discovery, { provider: "disabled" });
    assert.equal("apiKey" in discovery, false);
  }
});

test("provider keys alone never activate discovery", () => {
  assert.deepEqual(loadConfig({ GEOAPIFY_API_KEY: "synthetic-key" }).discovery, {
    provider: "disabled",
  });
  assert.deepEqual(
    loadConfig({ GOOGLE_PLACES_API_KEY: "unused-google-sentinel" }).discovery,
    { provider: "disabled" },
  );
});

test("explicit Geoapify selection preserves a valid opaque synthetic key", () => {
  const apiKey = "synthetic.Geoapify_key-42";
  const config = loadConfig({
    DISCOVERY_PROVIDER: "geoapify",
    GEOAPIFY_API_KEY: apiKey,
  });

  assert.deepEqual(config.discovery, { provider: "geoapify", apiKey });
  assert.equal(config.discovery.provider === "geoapify" && config.discovery.apiKey, apiKey);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.discovery));
});

test("Geoapify selection requires its own key", () => {
  assert.throws(
    () => loadConfig({ DISCOVERY_PROVIDER: "geoapify" }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryConfigurationError);
      assert.equal(error.code, "MISSING_GEOAPIFY_API_KEY");
      assert.equal(
        error.message,
        "GEOAPIFY_API_KEY is required when discovery provider is geoapify.",
      );
      return true;
    },
  );
});

test("Google key cannot satisfy Geoapify configuration", () => {
  const googleSentinel = "google-key-must-remain-unused";

  assert.throws(
    () =>
      loadConfig({
        DISCOVERY_PROVIDER: "geoapify",
        GOOGLE_PLACES_API_KEY: googleSentinel,
      }),
    (error: unknown) => {
      assert.ok(error instanceof DiscoveryConfigurationError);
      assert.equal(error.code, "MISSING_GEOAPIFY_API_KEY");
      assert.doesNotMatch(error.message, new RegExp(googleSentinel));
      return true;
    },
  );
});

test("rejects empty, whitespace, controlled, or whitespace-containing Geoapify keys", () => {
  const invalidKeys = [
    "",
    "   ",
    " padded",
    "padded ",
    "two words",
    "line\nbreak",
    "tab\tkey",
    "nul\u0000key",
    "delete\u007fkey",
  ];

  for (const apiKey of invalidKeys) {
    assert.throws(
      () =>
        loadConfig({
          DISCOVERY_PROVIDER: "geoapify",
          GEOAPIFY_API_KEY: apiKey,
        }),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryConfigurationError);
        assert.equal(error.code, "INVALID_GEOAPIFY_API_KEY");
        assert.equal(error.message, "GEOAPIFY_API_KEY is invalid.");
        assert.doesNotMatch(error.message, /padded|two words|line|tab|nul|delete/u);
        return true;
      },
    );
  }
});

test("rejects every unsupported or non-canonical discovery provider", () => {
  const invalidProviders = [
    "",
    "   ",
    " geoapify",
    "geoapify ",
    "GEOAPIFY",
    "Geoapify",
    "google_places",
    "google",
    "unknown-provider-sentinel",
  ];

  for (const provider of invalidProviders) {
    assert.throws(
      () => loadConfig({ DISCOVERY_PROVIDER: provider }),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryConfigurationError);
        assert.equal(error.code, "INVALID_PROVIDER");
        assert.equal(
          error.message,
          "Invalid DISCOVERY_PROVIDER. Expected disabled or geoapify.",
        );
        assert.doesNotMatch(error.message, /unknown-provider-sentinel/u);
        return true;
      },
    );
  }
});

test("does not mutate or retain the input environment object", () => {
  const environment: Record<string, string | undefined> = {
    NODE_ENV: "test",
    DISCOVERY_PROVIDER: "geoapify",
    GEOAPIFY_API_KEY: "synthetic-original-key",
    UNRELATED_SENTINEL: "must-not-be-exposed",
  };
  const before = { ...environment };
  const config = loadConfig(environment);

  assert.deepEqual(environment, before);
  environment.GEOAPIFY_API_KEY = "changed-after-parse";
  assert.deepEqual(config.discovery, {
    provider: "geoapify",
    apiKey: "synthetic-original-key",
  });
  assert.equal("UNRELATED_SENTINEL" in config, false);
  assert.equal(JSON.stringify(config).includes("must-not-be-exposed"), false);
});

test("configuration parsing performs no provider or network operation", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network access is forbidden during configuration parsing");
  }) as typeof fetch;

  try {
    assert.deepEqual(
      loadConfig({
        DISCOVERY_PROVIDER: "geoapify",
        GEOAPIFY_API_KEY: "synthetic-offline-key",
      }).discovery,
      { provider: "geoapify", apiKey: "synthetic-offline-key" },
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
