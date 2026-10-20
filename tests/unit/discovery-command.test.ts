import { strict as assert } from "node:assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, test } from "node:test";

import type { DiscoveryProcessIO } from "../../src/cli/discover";
import {
  DISCOVERY_COMMAND_EXIT,
  DISCOVERY_PROVIDER_ERROR_MESSAGES,
  DiscoveryProviderError,
  formatDiscoveryRunResult,
  runDiscoveryCommand,
  type DiscoveryCommandDependencies,
  type DiscoveryCommandResult,
  type DiscoveryPage,
  type DiscoveryProvider,
  type DiscoveryRunResult,
} from "../../src/discovery";
import type { EnvironmentVariables } from "../../src/config/env";
import {
  InvalidDiscoveredLeadInputError,
  LeadPersistenceError,
  type RecordDiscoveredLeadResult,
} from "../../src/leads";
import type { AuditActor } from "../../src/audit";

const HELP_TEXT = `Usage:
  npm run discover -- --location <location> --query <query> --actor <id> [--max-results <count>]
  npm run discover -- --help
  npm run discover -- -h

Options:
  --location <location>     Required city text. Passed to discovery criteria.
  --query <query>           Required query text. Passed to discovery criteria.
  --actor <id>              Required claimed human actor id.
  --max-results <count>     Optional examined-slot budget. Integer 1-60. Default 20.
  --help, -h                Show this help and exit.

Discovery stays disabled unless DISCOVERY_PROVIDER=geoapify and GEOAPIFY_API_KEY are set in the environment. This command does not read a .env file.

© OpenStreetMap contributors
Powered by Geoapify
`;

const KEY = "sentinel-geoapify-key";
const enabledEnv: EnvironmentVariables = {
  NODE_ENV: "test",
  DISCOVERY_PROVIDER: "geoapify",
  GEOAPIFY_API_KEY: KEY,
};

function usage(line: string): string {
  return `${line}\n${HELP_TEXT}`;
}

function spies(): {
  calls: { database: number; provider: number };
  dependencies: DiscoveryCommandDependencies;
} {
  const calls = { database: 0, provider: 0 };
  return {
    calls,
    dependencies: {
      openDatabase() {
        calls.database += 1;
        throw new Error("database-sentinel");
      },
      createProvider() {
        calls.provider += 1;
        throw new Error("provider-sentinel");
      },
    },
  };
}

function assertNoSentinels(result: DiscoveryCommandResult, sentinels: readonly string[]): void {
  const text = `${result.stdout}\n${result.stderr}`;
  for (const sentinel of sentinels) {
    assert.equal(text.includes(sentinel), false, sentinel);
  }
}

async function invoke(
  argv: readonly string[],
  env: EnvironmentVariables,
  dependencies?: DiscoveryCommandDependencies,
  signal: AbortSignal = new AbortController().signal,
): Promise<DiscoveryCommandResult> {
  return runDiscoveryCommand({ argv, env, signal }, dependencies);
}

function acceptedPage(
  businessName: string,
  websiteUrl: string,
  nextCursor?: string,
): DiscoveryPage {
  return {
    outcomes: [
      {
        status: "accepted",
        candidate: {
          provider: "geoapify",
          providerReference: "osm:n:42",
          businessName,
          websiteObservation: { presence: "present", url: websiteUrl },
        },
        warnings: [],
      },
    ],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function fakeDatabase(options?: {
  onRecord?: (actor: AuditActor) => RecordDiscoveredLeadResult | never;
  onClose?: () => void;
}): {
  actors: AuditActor[];
  closed: number;
  recorded: number;
  dependencies: Pick<DiscoveryCommandDependencies, "openDatabase">;
} {
  const actors: AuditActor[] = [];
  let closed = 0;
  let recorded = 0;
  return {
    actors,
    get closed() {
      return closed;
    },
    get recorded() {
      return recorded;
    },
    dependencies: {
      openDatabase() {
        return {
          leads: {
            recordDiscoveredLead(_input, actor) {
              recorded += 1;
              actors.push(actor);
              if (options?.onRecord) {
                return options.onRecord(actor);
              }
              return { created: true } as RecordDiscoveredLeadResult;
            },
          },
          close() {
            closed += 1;
            options?.onClose?.();
          },
        };
      },
    },
  };
}

function providerOf(
  searchPage: DiscoveryProvider["searchPage"],
  id = "geoapify",
): DiscoveryProvider & { calls: number } {
  let calls = 0;
  return {
    id,
    get calls() {
      return calls;
    },
    async searchPage(request) {
      calls += 1;
      return searchPage(request);
    },
  };
}

describe("DQ-015 discovery command", { concurrency: false }, () => {
test("discovery command exit map uses the approved codes", () => {
  assert.deepEqual(DISCOVERY_COMMAND_EXIT, {
    completed: 0,
    unexpected: 1,
    usage: 2,
    configuration: 3,
    database: 4,
    failed: 5,
    cancelled: 130,
  });
});

test("command sources stay inside the approved imports", () => {
  const command = readFileSync("src/discovery/command.ts", "utf8");
  const cli = readFileSync("src/cli/discover.ts", "utf8");
  const launcher = readFileSync("scripts/run-discovery.cjs", "utf8");
  for (const source of [command, cli, launcher]) {
    assert.equal(source.includes("config/index"), false);
    assert.equal(source.includes("better-sqlite3"), false);
    assert.equal(source.includes("dotenv"), false);
    assert.equal(source.includes("DoNotContactService"), false);
    assert.equal(source.includes("network-safety"), false);
  }
  assert.match(command, /from "\.\.\/config\/env"/);
  assert.equal(cli.includes("process.exit("), false);
  assert.equal(cli.includes("process.exitCode"), true);
  assert.match(cli, /if \(require\.main === module\) \{\n {2}main\(\)\n/);
  assert.equal(launcher.includes("require.main"), false);
  assert.equal(launcher.includes(".main("), false);
});

test("importing the cli module does not run main", async () => {
  const exitCodeBefore = process.exitCode;
  const writes: string[] = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(`stdout:${String(chunk)}`);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(`stderr:${String(chunk)}`);
    return true;
  }) as typeof process.stderr.write;

  try {
    const loaded = await import("../../src/cli/discover");
    assert.equal(writes.length, 0);
    assert.equal(process.exitCode, exitCodeBefore);
    assert.equal(typeof loaded.main, "function");

    const helpOut: string[] = [];
    const helpErr: string[] = [];
    let unregistered = 0;
    const helpCode = await loaded.main({
      argv: ["--help"],
      env: { NODE_ENV: "test", GEOAPIFY_API_KEY: KEY, DISCOVERY_PROVIDER: "disabled" },
      stdout: { write: (text) => helpOut.push(text) },
      stderr: { write: (text) => helpErr.push(text) },
      registerSigint: () => () => {
        unregistered += 1;
      },
    } satisfies DiscoveryProcessIO);
    assert.equal(helpCode, 0);
    assert.equal(helpOut.join(""), HELP_TEXT);
    assert.equal(helpErr.join(""), "");
    assert.equal(unregistered, 1);
    assert.equal(process.exitCode, exitCodeBefore);
    assert.equal(`${helpOut.join("")}${helpErr.join("")}`.includes(KEY), false);

    const databasePath = "data/delta-qoralis.sqlite";
    const before = existsSync(databasePath) ? statSync(databasePath).mtimeMs : undefined;
    let aborted = 0;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("live-network-sentinel");
    }) as typeof fetch;
    const cancelOut: string[] = [];
    const cancelErr: string[] = [];
    let cancelUnregistered = 0;
    try {
      const cancelCode = await loaded.main({
        argv: ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
        env: enabledEnv,
        stdout: { write: (text) => cancelOut.push(text) },
        stderr: { write: (text) => cancelErr.push(text) },
        registerSigint: (handler) => {
          handler();
          aborted += 1;
          return () => {
            cancelUnregistered += 1;
          };
        },
      });
      assert.equal(aborted, 1);
      assert.equal(cancelCode, 130);
      assert.equal(cancelUnregistered, 1);
      assert.match(cancelOut.join(""), /status: cancelled/);
      assert.match(cancelOut.join(""), /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
      assert.match(cancelErr.join(""), /Discovery run was cancelled\./);
      assert.equal(fetchCalls, 0);
      assertNoSentinels(
        { exitCode: cancelCode, stdout: cancelOut.join(""), stderr: cancelErr.join("") },
        [KEY, "live-network-sentinel"],
      );
      assert.equal(process.exitCode, exitCodeBefore);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const after = existsSync(databasePath) ? statSync(databasePath).mtimeMs : undefined;
    assert.equal(after, before);

    let writeUnregistered = 0;
    await assert.rejects(
      loaded.main({
        argv: ["--help"],
        env: { NODE_ENV: "test" },
        stdout: {
          write() {
            throw new Error("stdout-sentinel");
          },
        },
        stderr: { write() {} },
        registerSigint: () => () => {
          writeUnregistered += 1;
        },
      }),
    );
    assert.equal(writeUnregistered, 1);
    assert.equal(process.exitCode, exitCodeBefore);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
});

test("help exits before config, database, and provider work", async () => {
  for (const argv of [
    ["--help"],
    ["-h"],
    ["--help", "--help"],
    ["-h", "--help"],
    ["--help", "--location", "Kyiv", "--query", "cafe", "--actor", "ada", "--max-results", "5"],
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada", "--help"],
  ]) {
    const probe = spies();
    const result = await invoke(argv, { ...enabledEnv, GEOAPIFY_API_KEY: KEY }, probe.dependencies);
    assert.equal(result.exitCode, 0, argv.join(" "));
    assert.equal(result.stdout, HELP_TEXT, argv.join(" "));
    assert.equal(result.stderr, "");
    assert.deepEqual(probe.calls, { database: 0, provider: 0 });
    assertNoSentinels(result, [KEY, "Kyiv"]);
  }
});

test("usage failures stay on stderr and do not echo rejected tokens", async () => {
  const cases: ReadonlyArray<{ argv: readonly string[]; stderr: string }> = [
    {
      argv: ["--query", "secret-token", "--actor", "ada"],
      stderr: usage("Missing required option --location."),
    },
    {
      argv: ["--location", "secret-token", "--actor", "ada"],
      stderr: usage("Missing required option --query."),
    },
    {
      argv: ["--location", "secret-token", "--query", "cafe"],
      stderr: usage("Missing required option --actor."),
    },
    {
      argv: [],
      stderr: usage(
        [
          "Missing required option --location.",
          "Missing required option --query.",
          "Missing required option --actor.",
        ].join("\n"),
      ),
    },
    {
      argv: ["--secret-token"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["--location", "Kyiv", "--query", "cafe", "--actor", "ada", "--secret-token"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["secret-token"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["--location"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["--location", "--help"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["--help", "--location"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["--location", "Kyiv", "--query", "cafe", "--actor", "ada", "--max-results"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["-x"],
      stderr: usage("Discovery command usage is invalid."),
    },
    {
      argv: ["--location", "secret-token", "--location", "secret-token", "--query", "cafe", "--actor", "ada"],
      stderr: usage("Duplicate option --location."),
    },
    {
      argv: ["--location", "Kyiv", "--query", "cafe", "--actor", "ada", "--max-results", "2", "--max-results", "2"],
      stderr: usage("Duplicate option --max-results."),
    },
  ];

  for (const entry of cases) {
    const probe = spies();
    const result = await invoke(entry.argv, enabledEnv, probe.dependencies);
    assert.equal(result.exitCode, 2, entry.argv.join(" "));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, entry.stderr, entry.argv.join(" "));
    assert.deepEqual(probe.calls, { database: 0, provider: 0 });
    assert.equal(result.stderr.includes("secret-token"), false);
    assert.equal(result.stderr.includes("Unknown option"), false);
    assert.equal(result.stderr.includes("ambiguous"), false);
    assert.equal(result.stderr.includes("positional"), false);
  }
});

test("invalid criteria and actors exit 2 before config or database access", async () => {
  const criteria: readonly (readonly string[])[] = [
    ["--location", "", "--query", "cafe", "--actor", "ada"],
    ["--location", "   ", "--query", "cafe", "--actor", "ada"],
    ["--location", "secret-token", "--query", "cafe\n", "--actor", "ada"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "0"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "01"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "20.0"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "+20"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "1e1"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", ""],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results="],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "20abc"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "61"],
    ["--location", "secret-token", "--query", "cafe", "--actor", "ada", "--max-results", "100"],
  ];
  for (const argv of criteria) {
    const probe = spies();
    const result = await invoke(argv, enabledEnv, probe.dependencies);
    assert.equal(result.exitCode, 2, argv.join("|"));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, usage("Discovery criteria are invalid."));
    assert.deepEqual(probe.calls, { database: 0, provider: 0 });
    assert.equal(result.stderr.includes("secret-token"), false);
  }

  const actors = ["", "   ", "ada\nbad", "x".repeat(129)];
  for (const actor of actors) {
    const probe = spies();
    const result = await invoke(
      ["--location", "secret-token", "--query", "cafe", "--actor", actor],
      enabledEnv,
      probe.dependencies,
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stderr, usage("Audit actor is invalid."));
    assert.deepEqual(probe.calls, { database: 0, provider: 0 });
    assert.equal(result.stderr.includes("secret-token"), false);
    assert.equal(result.stderr.includes("x".repeat(40)), false);
  }
});

test("configuration failures use fixed messages and do not open storage", async () => {
  const cases: ReadonlyArray<{ env: EnvironmentVariables; stderr: string; hidden: string }> = [
    {
      env: { NODE_ENV: "test", DISCOVERY_PROVIDER: "disabled", GEOAPIFY_API_KEY: "disabled-key-sentinel" },
      stderr: "Discovery is disabled.\n",
      hidden: "disabled-key-sentinel",
    },
    {
      env: { NODE_ENV: "test", GEOAPIFY_API_KEY: "disabled-key-sentinel" },
      stderr: "Discovery is disabled.\n",
      hidden: "disabled-key-sentinel",
    },
    {
      env: { NODE_ENV: "test", DISCOVERY_PROVIDER: "geoapify" },
      stderr: "GEOAPIFY_API_KEY is required when discovery provider is geoapify.\n",
      hidden: "GOOGLE",
    },
    {
      env: {
        NODE_ENV: "test",
        DISCOVERY_PROVIDER: "geoapify",
        GOOGLE_PLACES_API_KEY: "google-places-sentinel",
      },
      stderr: "GEOAPIFY_API_KEY is required when discovery provider is geoapify.\n",
      hidden: "google-places-sentinel",
    },
    {
      env: { NODE_ENV: "test", DISCOVERY_PROVIDER: "geoapify", GEOAPIFY_API_KEY: "leak-me-token " },
      stderr: "GEOAPIFY_API_KEY is invalid.\n",
      hidden: "leak-me-token",
    },
    {
      env: { NODE_ENV: "test", DISCOVERY_PROVIDER: "sentinel-provider", GEOAPIFY_API_KEY: KEY },
      stderr: "Invalid DISCOVERY_PROVIDER. Expected disabled or geoapify.\n",
      hidden: "sentinel-provider",
    },
    {
      env: { NODE_ENV: "bad-env-sentinel" },
      stderr: "Invalid NODE_ENV. Expected one of: development, test, production.\n",
      hidden: "bad-env-sentinel",
    },
    {
      env: { NODE_ENV: "test", DATABASE_URL: "file://secret-database-path" },
      stderr: "Invalid DATABASE_URL. Expected a local SQLite file: URL.\n",
      hidden: "secret-database-path",
    },
  ];

  for (const entry of cases) {
    const probe = spies();
    const result = await invoke(
      ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
      entry.env,
      probe.dependencies,
    );
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, entry.stderr);
    assert.deepEqual(probe.calls, { database: 0, provider: 0 });
    assert.equal(result.stderr.includes(entry.hidden), false);
    assert.equal(result.stderr.includes("©"), false);
  }
});

test("provider factory failure closes the database and does not run discovery", async () => {
  const database = fakeDatabase();
  let providerCalls = 0;
  const result = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...database.dependencies,
      createProvider() {
        providerCalls += 1;
        throw new TypeError("Geoapify provider configuration is invalid. factory-sentinel-text");
      },
    },
  );
  assert.equal(providerCalls, 1);
  assert.equal(database.closed, 1);
  assert.equal(database.recorded, 0);
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Discovery provider configuration is invalid.\n");
  assertNoSentinels(result, ["factory-sentinel-text", KEY, "Geoapify provider configuration is invalid."]);
});

test("database open failure does not create a provider", async () => {
  let providerCalls = 0;
  const result = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      openDatabase() {
        throw new Error("SQLITE_CANTOPEN secret-db-path");
      },
      createProvider() {
        providerCalls += 1;
        throw new Error("provider should not be created");
      },
    },
  );
  assert.equal(providerCalls, 0);
  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Discovery database is unavailable.\n");
  assertNoSentinels(result, ["SQLITE_CANTOPEN", "secret-db-path", KEY]);
});

test("completed runs format counters, attribution, and no private fields", async () => {
  const database = fakeDatabase();
  let defaultMax = 0;
  const provider = providerOf(async (request) => {
    defaultMax = request.criteria.maxResults;
    return { outcomes: [] };
  });
  const omitted = await invoke(
    ["--location=Kyiv", "--query=cafe", "--actor=ada"],
    enabledEnv,
    { ...database.dependencies, createProvider: () => provider },
  );
  assert.equal(omitted.exitCode, 0);
  assert.equal(omitted.stderr, "");
  assert.equal(
    omitted.stdout,
    `Discovery run
providerId: geoapify
status: completed
reason: results_exhausted
slotsExamined: 0
slotsAccepted: 0
slotsRejected: 0
acceptedPersisted: 0
leadsCreated: 0
leadsDuplicate: 0
pagesFetched: 1

© OpenStreetMap contributors
Powered by Geoapify
`,
  );
  assert.equal(provider.calls, 1);
  assert.equal(defaultMax, 20);

  const bounded = fakeDatabase();
  let seenMax = 0;
  const pageProvider = providerOf(async (request) => {
    seenMax = request.criteria.maxResults;
    return acceptedPage(
      "Sentinel Bakery Name",
      "https://sentinel-website.example/path",
      "cursor-sentinel-value",
    );
  });
  const budget = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "  actor-sentinel-id  ", "--max-results", "1"],
    enabledEnv,
    { ...bounded.dependencies, createProvider: () => pageProvider },
  );
  assert.equal(seenMax, 1);
  assert.equal(budget.exitCode, 0);
  assert.equal(budget.stderr, "");
  assert.match(budget.stdout, /status: completed\nreason: budget_exhausted\nslotsExamined: 1/);
  assert.match(budget.stdout, /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
  assert.deepEqual(bounded.actors, [{ type: "human", id: "actor-sentinel-id" }]);
  assertNoSentinels(budget, [
    KEY,
    "Sentinel Bakery Name",
    "sentinel-website.example",
    "cursor-sentinel-value",
    "actor-sentinel-id",
  ]);

  const sixty = fakeDatabase();
  let sixtyMax = 0;
  await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada", "--max-results", "60"],
    enabledEnv,
    {
      ...sixty.dependencies,
      createProvider: () =>
        providerOf(async (request) => {
          sixtyMax = request.criteria.maxResults;
          return { outcomes: [] };
        }),
    },
  );
  assert.equal(sixtyMax, 60);
});

test("an already aborted signal cancels before search", async () => {
  const controller = new AbortController();
  controller.abort();
  const database = fakeDatabase();
  const provider = providerOf(async () => ({ outcomes: [] }));
  const result = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    { ...database.dependencies, createProvider: () => provider },
    controller.signal,
  );
  assert.equal(provider.calls, 0);
  assert.equal(database.closed, 1);
  assert.equal(result.exitCode, 130);
  assert.equal(result.stderr, "Discovery run was cancelled.\n");
  assert.match(result.stdout, /status: cancelled\nreason: cancelled\n/);
  assert.equal(result.stdout.includes("code:"), false);
  assert.match(result.stdout, /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
  assertNoSentinels(result, [KEY]);
});

test("each failed stop code stays exit 5 with fixed stderr and attribution", async () => {
  const providerCodes = (
    Object.keys(DISCOVERY_PROVIDER_ERROR_MESSAGES) as Array<keyof typeof DISCOVERY_PROVIDER_ERROR_MESSAGES>
  ).filter((code) => code !== "CANCELLED");

  for (const code of providerCodes) {
    const database = fakeDatabase();
    const result = await invoke(
      ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
      enabledEnv,
      {
        ...database.dependencies,
        createProvider: () =>
          providerOf(async () => {
            throw new DiscoveryProviderError(code);
          }),
      },
    );
    assert.equal(result.exitCode, 5, code);
    assert.equal(result.stderr, `${DISCOVERY_PROVIDER_ERROR_MESSAGES[code]}\n`);
    assert.match(result.stdout, new RegExp(`status: failed\\nreason: provider_error\\ncode: ${code}\\n`));
    assert.match(result.stdout, /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
    assert.equal(database.closed, 1);
    assertNoSentinels(result, [KEY]);
  }

  const database = fakeDatabase();
  const unexpected = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...database.dependencies,
      createProvider: () =>
        providerOf(async () => {
          throw new Error("socket-sentinel-body");
        }),
    },
  );
  assert.equal(unexpected.exitCode, 5);
  assert.equal(unexpected.stderr, "Discovery provider request failed.\n");
  assert.match(unexpected.stdout, /code: UNEXPECTED\n/);
  assertNoSentinels(unexpected, ["socket-sentinel-body", KEY]);

  const malformed = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...fakeDatabase().dependencies,
      createProvider: () => providerOf(async () => ({ outcomes: [], extra: true } as DiscoveryPage)),
    },
  );
  assert.equal(malformed.exitCode, 5);
  assert.equal(malformed.stderr, "Discovery provider response is invalid.\n");
  assert.match(malformed.stdout, /reason: malformed_page\ncode: MALFORMED_PAGE\n/);

  const emptyCursor = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...fakeDatabase().dependencies,
      createProvider: () =>
        providerOf(async () => ({ outcomes: [], nextCursor: "cursor-sentinel-value" })),
    },
  );
  assert.equal(emptyCursor.exitCode, 5);
  assert.equal(emptyCursor.stderr, "Discovery pagination stopped.\n");
  assert.match(emptyCursor.stdout, /code: EMPTY_PAGE_WITH_CURSOR\n/);
  assertNoSentinels(emptyCursor, ["cursor-sentinel-value"]);

  const repeated = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...fakeDatabase().dependencies,
      createProvider: () => {
        const pages = [
          acceptedPage("Sentinel Bakery Name", "https://sentinel-website.example/path", "cursor-sentinel-value"),
          acceptedPage("Sentinel Bakery Name", "https://sentinel-website.example/path", "cursor-sentinel-value"),
        ];
        let index = 0;
        return providerOf(async () => {
          const page = pages[index];
          index += 1;
          return page ?? { outcomes: [] };
        });
      },
    },
  );
  assert.equal(repeated.exitCode, 5);
  assert.equal(repeated.stderr, "Discovery pagination stopped.\n");
  assert.match(repeated.stdout, /code: REPEATED_CURSOR\n/);
  assertNoSentinels(repeated, ["cursor-sentinel-value", "Sentinel Bakery Name", "sentinel-website.example"]);

  const persistenceCases: ReadonlyArray<{
    error: () => Error;
    code: string;
    hidden: string;
  }> = [
    {
      error: () => new LeadPersistenceError(),
      code: "PERSISTENCE_FAILED",
      hidden: "Lead persistence operation failed.",
    },
    {
      error: () => new InvalidDiscoveredLeadInputError(),
      code: "INVALID_DISCOVERED_LEAD",
      hidden: "Discovered lead input is invalid.",
    },
    {
      error: () => new Error("sqlite-sentinel-near-secret.sql"),
      code: "UNEXPECTED",
      hidden: "sqlite-sentinel-near-secret.sql",
    },
  ];
  for (const entry of persistenceCases) {
    const store = fakeDatabase({
      onRecord: () => {
        throw entry.error();
      },
    });
    const result = await invoke(
      ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
      enabledEnv,
      {
        ...store.dependencies,
        createProvider: () =>
          providerOf(async () => acceptedPage("Sentinel Bakery Name", "https://sentinel-website.example/path")),
      },
    );
    assert.equal(result.exitCode, 5, entry.code);
    assert.equal(result.stderr, "Discovery persistence failed.\n");
    assert.match(result.stdout, new RegExp(`reason: persistence_error\\ncode: ${entry.code}\\n`));
    assert.match(result.stdout, /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
    assertNoSentinels(result, [entry.hidden, "Sentinel Bakery Name", KEY]);
    assert.equal(store.closed, 1);
  }

  const iteration = formatDiscoveryRunResult({
    providerId: "geoapify",
    summary: {
      slotsExamined: 0,
      slotsAccepted: 0,
      slotsRejected: 0,
      acceptedPersisted: 0,
      leadsCreated: 0,
      leadsDuplicate: 0,
      pagesFetched: 0,
    },
    stop: { status: "failed", reason: "pagination_blocked", code: "PAGE_ITERATION_CAP" },
  });
  assert.match(iteration, /code: PAGE_ITERATION_CAP\n/);
  assert.match(iteration, /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
});

test("cancellation from the provider is not a provider failure", async () => {
  const result = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...fakeDatabase().dependencies,
      createProvider: () =>
        providerOf(async () => {
          throw new DiscoveryProviderError("CANCELLED");
        }),
    },
  );
  assert.equal(result.exitCode, 130);
  assert.equal(result.stderr, "Discovery run was cancelled.\n");
  assert.match(result.stdout, /status: cancelled\nreason: cancelled\n/);
  assert.equal(result.stdout.includes("CANCELLED"), false);
  assert.match(result.stdout, /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
});

test("unexpected composition failures do not print the thrown message", async () => {
  const database = fakeDatabase();
  const result = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...database.dependencies,
      createProvider: () => providerOf(async () => ({ outcomes: [] }), "Bad Provider"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Discovery command failed.\n");
  assert.equal(database.closed, 1);
  assertNoSentinels(result, ["Bad Provider", "Discovery provider response is invalid.", KEY]);
});

test("close failure rewrites only a successful exit", async () => {
  const completed = fakeDatabase({
    onClose() {
      throw new Error("close-sentinel-path");
    },
  });
  const success = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...completed.dependencies,
      createProvider: () => providerOf(async () => ({ outcomes: [] })),
    },
  );
  assert.equal(success.exitCode, 4);
  assert.match(success.stdout, /status: completed/);
  assert.equal(success.stderr, "Discovery database is unavailable.\n");
  assertNoSentinels(success, ["close-sentinel-path"]);

  const failed = fakeDatabase({
    onClose() {
      throw new Error("close-sentinel-path");
    },
  });
  const failure = await invoke(
    ["--location", "Kyiv", "--query", "cafe", "--actor", "ada"],
    enabledEnv,
    {
      ...failed.dependencies,
      createProvider: () =>
        providerOf(async () => {
          throw new DiscoveryProviderError("UNSUPPORTED_QUERY");
        }),
    },
  );
  assert.equal(failure.exitCode, 5);
  assert.equal(
    failure.stderr,
    "Discovery query is not supported.\nDiscovery database is unavailable.\n",
  );
  assertNoSentinels(failure, ["close-sentinel-path"]);
});

test("formatDiscoveryRunResult prints only run fields", () => {
  const result = {
    providerId: "geoapify",
    summary: {
      slotsExamined: 2,
      slotsAccepted: 1,
      slotsRejected: 1,
      acceptedPersisted: 1,
      leadsCreated: 0,
      leadsDuplicate: 1,
      pagesFetched: 1,
    },
    stop: { status: "completed", reason: "results_exhausted" },
    apiKey: "extra-secret-field",
    cursor: "hidden-cursor",
  } as DiscoveryRunResult;
  const text = formatDiscoveryRunResult(result);
  assert.equal(text.includes("extra-secret-field"), false);
  assert.equal(text.includes("apiKey"), false);
  assert.equal(text.includes("hidden-cursor"), false);
  assert.equal(text.includes("cursor"), false);
  assert.match(text, /^Discovery run\nproviderId: geoapify\nstatus: completed\nreason: results_exhausted\nslotsExamined: 2\n/);
  assert.match(text, /leadsDuplicate: 1\npagesFetched: 1\n\n© OpenStreetMap contributors\nPowered by Geoapify\n$/);
});
});
