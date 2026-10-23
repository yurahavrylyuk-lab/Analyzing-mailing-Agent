import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Miniflare } from "miniflare";
import {
  persistD1WebsiteAnalysis,
  WebsiteAnalysisPersistenceError,
  type D1WebsiteAnalysisDatabase,
  type StoredWebsiteAnalysis,
  type WebsiteAnalysisPersistenceErrorCode,
} from "../../src/website-analysis";
import type {
  GeminiModel,
  GeminiWebsiteAnalysisResult,
} from "../../src/website-analysis/providers/gemini";

const LEAD_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_VERSION = 4;
const REQUESTED_URL = "https://example.com/a";
const ATTEMPTED_AT = "2026-10-23T00:00:00.000Z";
const STORED_AT = "2026-10-23T12:34:56.789Z";
const BODY_TEXT = "<p>a</p>";
const BYTE_LENGTH = Buffer.byteLength(BODY_TEXT, "utf8");

type TestStatement = {
  bind(...values: readonly unknown[]): TestStatement;
  all(): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{
    readonly meta: {
      readonly changes: number;
      readonly last_row_id: number;
    };
  }>;
};

type TestDatabase = {
  prepare(sql: string): TestStatement;
  exec(sql: string): Promise<unknown>;
};

async function withDatabase(use: (database: TestDatabase) => Promise<void>): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    script: `
      export default {
        async fetch() {
          return new Response("ok");
        }
      };
    `,
    d1Databases: {
      DB: "delta-qoralis-test",
    },
    d1Persist: false,
  });
  try {
    const database = await mf.getD1Database("DB");
    await database.exec(
      readFileSync(join(process.cwd(), "migrations/0001_delta_qoralis_crawl.sql"), "utf8"),
    );
    await database.exec(
      readFileSync(join(process.cwd(), "migrations/0002_website_analysis.sql"), "utf8"),
    );
    await use(database);
  } finally {
    await mf.dispose();
  }
}

async function expectRejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

async function insertLead(database: TestDatabase): Promise<void> {
  await database
    .prepare(
      `INSERT INTO business_leads (
        id, business_name, source_kind, source_provider, source_reference,
        status, website_presence, website_url, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      LEAD_ID,
      "Example Business",
      "manual",
      null,
      `ref-${LEAD_ID}`,
      "recorded",
      "present",
      REQUESTED_URL,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      1,
    )
    .run();
}

async function insertEvidence(
  database: TestDatabase,
  outcome: "fetched" | "failed",
): Promise<number> {
  const fetched = outcome === "fetched";
  const inserted = await database
    .prepare(
      `INSERT INTO single_page_crawl_evidence (
        lead_id, lead_version, outcome, requested_url, attempted_at,
        final_url, status_code, content_type, body_text, byte_length,
        redirect_count, failure_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      LEAD_ID,
      LEAD_VERSION,
      outcome,
      REQUESTED_URL,
      ATTEMPTED_AT,
      fetched ? REQUESTED_URL : null,
      fetched ? 200 : null,
      fetched ? "text/html" : null,
      fetched ? BODY_TEXT : null,
      fetched ? BYTE_LENGTH : null,
      fetched ? 0 : null,
      fetched ? null : "TIMEOUT",
    )
    .run();
  return inserted.meta.last_row_id;
}

async function insertAnalysis(
  database: TestDatabase,
  evidenceId: number,
  overrides: Record<string, unknown> = {},
): Promise<{ readonly changes: number; readonly last_row_id: number }> {
  const values = {
    id: undefined as number | undefined,
    evidence_id: evidenceId,
    lead_id: LEAD_ID,
    lead_version: LEAD_VERSION,
    summary: "Stored page summary",
    findings_json: "[]",
    provider: "gemini",
    model: "gemini-3.8-flash",
    attempted_models_json: '["gemini-3.8-flash"]',
    stored_at: STORED_AT,
    ...overrides,
  };
  const columns = [
    "evidence_id",
    "lead_id",
    "lead_version",
    "summary",
    "findings_json",
    "provider",
    "model",
    "attempted_models_json",
    "stored_at",
  ];
  const parameters = [
    values.evidence_id,
    values.lead_id,
    values.lead_version,
    values.summary,
    values.findings_json,
    values.provider,
    values.model,
    values.attempted_models_json,
    values.stored_at,
  ];
  if (values.id !== undefined) {
    columns.unshift("id");
    parameters.unshift(values.id);
  }
  const inserted = await database
    .prepare(
      `INSERT INTO website_analyses (${columns.join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(", ")})`,
    )
    .bind(...parameters)
    .run();
  return inserted.meta;
}

test("a second raw insert for the same evidence is allowed", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched");
    const first = await insertAnalysis(database, evidenceId);
    const second = await insertAnalysis(database, evidenceId, {
      summary: "Second stored summary",
    });
    assert.equal(typeof first.last_row_id, "number");
    assert.equal(typeof second.last_row_id, "number");
    assert.ok(first.last_row_id > 0);
    assert.ok(second.last_row_id > 0);
    assert.notEqual(first.last_row_id, second.last_row_id);

    const indexes = await database.prepare("PRAGMA index_list('website_analyses')").all();
    assert.equal(
      indexes.results.some((row) => String(row.name).includes("evidence_id")),
      false,
    );
    const objects = await database
      .prepare(
        "SELECT type, sql FROM sqlite_master WHERE tbl_name = 'website_analyses' OR name = 'website_analyses'",
      )
      .all();
    const types = objects.results.map((row) => row.type);
    assert.ok(types.includes("table"));
    assert.equal(types.filter((type) => type === "trigger").length, 2);
    assert.equal(
      objects.results.some((row) => typeof row.sql === "string" && row.sql.includes("CREATE INDEX")),
      false,
    );
  });
});

test("sql accepts non-json text and rejects empty json text", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched");
    const inserted = await insertAnalysis(database, evidenceId, {
      findings_json: "not-json",
      attempted_models_json: "not-json",
    });
    assert.ok(inserted.last_row_id > 0);
    assert.ok(await expectRejected(insertAnalysis(database, evidenceId, { findings_json: "" })));
    assert.ok(
      await expectRejected(insertAnalysis(database, evidenceId, { attempted_models_json: "" })),
    );
  });
});

test("sql rejects invalid scalars", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched");
    const rejected = [
      { id: -1 },
      { evidence_id: 0 },
      { lead_id: " " },
      { lead_version: 0 },
      { summary: "" },
      { summary: " " },
      { summary: "a".repeat(801) },
      { provider: "groq" },
      { model: "gemini-2.0-flash" },
      { stored_at: "2026-02-31T00:00:00.000Z" },
      { evidence_id: 999999 },
    ];
    for (const overrides of rejected) {
      assert.ok(await expectRejected(insertAnalysis(database, evidenceId, overrides)));
    }
    const longSummary = await insertAnalysis(database, evidenceId, { summary: "a".repeat(800) });
    assert.ok(longSummary.last_row_id > 0);
    const leapDay = await insertAnalysis(database, evidenceId, {
      stored_at: "2024-02-29T00:00:00.000Z",
      summary: "Leap day summary",
    });
    assert.ok(leapDay.last_row_id > 0);
  });
});

test("update and delete are rejected", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched");
    const inserted = await insertAnalysis(database, evidenceId);
    const updated = await expectRejected(
      database
        .prepare("UPDATE website_analyses SET summary = summary WHERE id = ?")
        .bind(inserted.last_row_id)
        .run(),
    );
    const deleted = await expectRejected(
      database
        .prepare("DELETE FROM website_analyses WHERE id = ?")
        .bind(inserted.last_row_id)
        .run(),
    );
    assert.equal(String((updated as Error).message).includes("website_analyses is append-only"), true);
    assert.equal(String((deleted as Error).message).includes("website_analyses is append-only"), true);
  });
});

const FINDING = {
  category: "design" as const,
  severity: "medium" as const,
  observation: "The heading is unclear.",
  evidence: "The page shows one heading.",
  recommendation: "State the offer in the heading.",
};

function analysisResult(
  evidenceId: number,
  overrides: {
    readonly summary?: string;
    readonly findings?: GeminiWebsiteAnalysisResult["analysis"]["findings"];
    readonly leadId?: string;
    readonly leadVersion?: number;
    readonly model?: GeminiModel;
    readonly attemptedModels?: readonly GeminiModel[];
  } = {},
): GeminiWebsiteAnalysisResult {
  return {
    analysis: {
      evidenceId,
      leadId: overrides.leadId ?? LEAD_ID,
      leadVersion: overrides.leadVersion ?? LEAD_VERSION,
      summary: overrides.summary ?? "Stored page summary",
      findings: overrides.findings ?? [FINDING],
    },
    provider: "gemini",
    model: overrides.model ?? "gemini-3.8-flash",
    attemptedModels: overrides.attemptedModels ?? ["gemini-3.8-flash"],
  };
}

function evidenceRow(
  evidenceId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: evidenceId,
    lead_id: LEAD_ID,
    lead_version: LEAD_VERSION,
    outcome: "fetched",
    ...overrides,
  };
}

function storedRow(
  evidenceId: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: evidenceId,
    evidence_id: evidenceId,
    lead_id: LEAD_ID,
    lead_version: LEAD_VERSION,
    summary: "Stored page summary",
    findings_json: JSON.stringify([FINDING]),
    provider: "gemini",
    model: "gemini-3.8-flash",
    attempted_models_json: JSON.stringify(["gemini-3.8-flash"]),
    stored_at: STORED_AT,
    ...overrides,
  };
}

function assertPersistence(
  error: unknown,
  code: "EVIDENCE_NOT_FOUND" | "EVIDENCE_NOT_ANALYZABLE" | "ANALYSIS_IDENTITY_MISMATCH" | "PERSISTENCE_FAILED",
  message: string,
): void {
  assert.ok(error instanceof WebsiteAnalysisPersistenceError);
  if (!(error instanceof WebsiteAnalysisPersistenceError)) {
    return;
  }
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.equal(error.cause, undefined);
}

function stubDatabase(options: {
  readonly evidence?: Record<string, unknown> | null;
  readonly analysis?: Record<string, unknown> | null;
  readonly evidenceError?: Error;
  readonly runError?: Error;
  readonly runMeta?: { readonly changes: number; readonly last_row_id: number };
}): {
  readonly database: D1WebsiteAnalysisDatabase;
  prepares: () => number;
  runs: () => number;
} {
  let prepares = 0;
  let runs = 0;
  let firsts = 0;
  const statement = {
    bind(..._values: readonly unknown[]) {
      return statement;
    },
    all: async () => ({ results: [] as readonly Record<string, unknown>[] }),
    first: async () => {
      firsts += 1;
      if (firsts === 1) {
        if (options.evidenceError !== undefined) {
          throw options.evidenceError;
        }
        return options.evidence === undefined ? evidenceRow(7) : options.evidence;
      }
      return options.analysis === undefined ? null : options.analysis;
    },
    run: async () => {
      runs += 1;
      if (options.runError !== undefined) {
        throw options.runError;
      }
      return { meta: options.runMeta ?? { changes: 1, last_row_id: 7 } };
    },
  };
  return {
    database: {
      prepare() {
        prepares += 1;
        return statement;
      },
    },
    prepares: () => prepares,
    runs: () => runs,
  };
}

test("invalid storedAt is PERSISTENCE_FAILED", async () => {
  const invalid = [
    "",
    "2026-02-31T00:00:00.000Z",
    "2023-02-29T00:00:00.000Z",
    "1900-02-29T00:00:00.000Z",
    "2026-10-23T12:34:56.789+00:00",
    "2026-10-23t12:34:56.789Z",
  ];
  for (const storedAt of invalid) {
    const stub = stubDatabase({});
    const error = await expectRejected(persistD1WebsiteAnalysis(stub.database, analysisResult(7), storedAt));
    assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
    assert.equal(stub.prepares(), 0);
  }
});

test("a real leap day is a valid storedAt", async () => {
  const storedAt = "2024-02-29T00:00:00.000Z";
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, { stored_at: storedAt }),
  });
  const stored = await persistD1WebsiteAnalysis(stub.database, analysisResult(7), storedAt);
  assert.equal(stored.storedAt, storedAt);
});

test("missing evidence is EVIDENCE_NOT_FOUND", async () => {
  const stub = stubDatabase({ evidence: null });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "EVIDENCE_NOT_FOUND", "Crawl evidence was not found.");
  assert.equal(stub.runs(), 0);
});

test("failed evidence is EVIDENCE_NOT_ANALYZABLE", async () => {
  for (const outcome of ["failed", "other"]) {
    const stub = stubDatabase({ evidence: evidenceRow(7, { outcome }) });
    const error = await expectRejected(
      persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
    );
    assertPersistence(error, "EVIDENCE_NOT_ANALYZABLE", "Crawl evidence is not analyzable.");
    assert.equal(stub.runs(), 0);
  }
});

test("evidence lead and version mismatches are ANALYSIS_IDENTITY_MISMATCH", async () => {
  const cases = [
    evidenceRow(8),
    evidenceRow(7, { lead_id: "00000000-0000-4000-8000-000000000002" }),
    evidenceRow(7, { lead_version: 5 }),
    evidenceRow(7, { lead_version: "4" }),
  ];
  for (const evidence of cases) {
    const stub = stubDatabase({ evidence });
    const error = await expectRejected(
      persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
    );
    assertPersistence(
      error,
      "ANALYSIS_IDENTITY_MISMATCH",
      "Website analysis identity does not match the crawl evidence.",
    );
    assert.equal(stub.runs(), 0);
  }
});

test("evidence read failure is PERSISTENCE_FAILED", async () => {
  const stub = stubDatabase({ evidenceError: new Error("secret-driver") });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  assert.equal(String((error as Error).message).includes("secret-driver"), false);
});

test("insert failure is PERSISTENCE_FAILED", async () => {
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    runError: new Error("secret-insert"),
  });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  assert.equal(String((error as Error).message).includes("secret-insert"), false);
});

test("insert metadata failures are PERSISTENCE_FAILED", async () => {
  const metas = [
    { changes: 0, last_row_id: 7 },
    { changes: 1, last_row_id: 0 },
    { changes: 1, last_row_id: -1 },
    { changes: 1, last_row_id: 1.5 },
    { changes: 1, last_row_id: 1n as unknown as number },
  ];
  for (const runMeta of metas) {
    const stub = stubDatabase({ evidence: evidenceRow(7), runMeta });
    const error = await expectRejected(
      persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
    );
    assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  }
});

test("missing read-back row is PERSISTENCE_FAILED", async () => {
  const stub = stubDatabase({ evidence: evidenceRow(7), analysis: null });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
});

test("read-back returns the stored row", async () => {
  const inputFinding = {
    category: "design" as const,
    severity: "medium" as const,
    observation: "The heading is unclear.",
    evidence: "The page shows one heading.",
    recommendation: "State the offer in the heading.",
  };
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, { summary: "Stored summary" }),
  });
  const stored = await persistD1WebsiteAnalysis(
    stub.database,
    analysisResult(7, { summary: "Input summary", findings: [inputFinding] }),
    STORED_AT,
  );
  assert.equal(stored.summary, "Stored summary");
  assert.equal(Object.isFrozen(inputFinding), false);
  assert.equal(Object.isFrozen(stored), true);
  assert.equal(Object.isFrozen(stored.findings), true);
  assert.equal(Object.isFrozen(stored.findings[0]), true);
  assert.equal(Object.isFrozen(stored.attemptedModels), true);
  assert.notEqual(stored.findings[0], inputFinding);
});

test("read-back id mismatch is PERSISTENCE_FAILED", async () => {
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, { id: 8 }),
    runMeta: { changes: 1, last_row_id: 7 },
  });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
});

test("corrupt findings_json is PERSISTENCE_FAILED", async () => {
  const extra = JSON.stringify([{ ...FINDING, extra: "no" }]);
  const fourDesign = JSON.stringify(
    Array.from({ length: 4 }, () => FINDING),
  );
  const nine = JSON.stringify([
    { ...FINDING, category: "design" },
    { ...FINDING, category: "design" },
    { ...FINDING, category: "usability" },
    { ...FINDING, category: "usability" },
    { ...FINDING, category: "seo" },
    { ...FINDING, category: "seo" },
    { ...FINDING, category: "accessibility" },
    { ...FINDING, category: "accessibility" },
    { ...FINDING, category: "conversion" },
  ]);
  const payloads = [
    "{",
    '{"category":"design"}',
    extra,
    fourDesign,
    nine,
    JSON.stringify([{ ...FINDING, observation: " " }]),
    JSON.stringify([{ ...FINDING, observation: "a".repeat(501) }]),
    JSON.stringify([{ ...FINDING, evidence: "a".repeat(801) }]),
    JSON.stringify([{ ...FINDING, recommendation: "a".repeat(501) }]),
  ];
  for (const findings_json of payloads) {
    const stub = stubDatabase({
      evidence: evidenceRow(7),
      analysis: storedRow(7, { findings_json }),
    });
    const error = await expectRejected(
      persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
    );
    assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  }
});

test("corrupt attempted_models_json is PERSISTENCE_FAILED", async () => {
  const payloads = ["{", "[]", '["gemini-2.0-flash"]', '["gemini-3.8-flash","gemini-3.6-flash"]'];
  for (const attempted_models_json of payloads) {
    const stub = stubDatabase({
      evidence: evidenceRow(7),
      analysis: storedRow(7, { attempted_models_json, model: "gemini-3.8-flash" }),
    });
    const error = await expectRejected(
      persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
    );
    assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  }
});

test("invalid stored provider is PERSISTENCE_FAILED", async () => {
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, { provider: "groq" }),
  });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
});

test("invalid stored model is PERSISTENCE_FAILED", async () => {
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, { model: "gemini-2.0-flash" }),
  });
  const error = await expectRejected(
    persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
});

test("malformed read-back scalars are PERSISTENCE_FAILED", async () => {
  const rows = [
    storedRow(7, { summary: "a".repeat(801) }),
    storedRow(7, { lead_id: " " }),
    storedRow(7, { lead_version: "4" }),
    storedRow(7, { stored_at: "2026-02-31T00:00:00.000Z" }),
  ];
  for (const analysis of rows) {
    const stub = stubDatabase({ evidence: evidenceRow(7), analysis });
    const error = await expectRejected(
      persistD1WebsiteAnalysis(stub.database, analysisResult(7), STORED_AT),
    );
    assertPersistence(error, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  }
});

test("successful model must be the final attempted model", async () => {
  const input = stubDatabase({ evidence: evidenceRow(7) });
  const inputError = await expectRejected(
    persistD1WebsiteAnalysis(
      input.database,
      analysisResult(7, {
        model: "gemini-3.8-flash",
        attemptedModels: ["gemini-3.8-flash", "gemini-3.6-flash"],
      }),
      STORED_AT,
    ),
  );
  assertPersistence(inputError, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  assert.equal(input.runs(), 0);

  const empty = stubDatabase({ evidence: evidenceRow(7) });
  const emptyError = await expectRejected(
    persistD1WebsiteAnalysis(
      empty.database,
      analysisResult(7, { attemptedModels: [] as GeminiModel[] }),
      STORED_AT,
    ),
  );
  assertPersistence(emptyError, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
  assert.equal(empty.runs(), 0);

  const readBack = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, {
      model: "gemini-3.8-flash",
      attempted_models_json: JSON.stringify(["gemini-3.8-flash", "gemini-3.6-flash"]),
    }),
  });
  const readBackError = await expectRejected(
    persistD1WebsiteAnalysis(readBack.database, analysisResult(7), STORED_AT),
  );
  assertPersistence(readBackError, "PERSISTENCE_FAILED", "Website analysis persistence failed.");
});

test("empty findings round-trip through read-back", async () => {
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, { findings_json: "[]" }),
  });
  const stored = await persistD1WebsiteAnalysis(
    stub.database,
    analysisResult(7, { findings: [] }),
    STORED_AT,
  );
  assert.deepEqual(stored.findings, []);
  assert.equal(Object.isFrozen(stored.findings), true);
});

test("read-back preserves attempted model order", async () => {
  const attemptedModels = ["gemini-3.6-flash", "gemini-3.8-flash"] as const;
  const stub = stubDatabase({
    evidence: evidenceRow(7),
    analysis: storedRow(7, {
      model: "gemini-3.8-flash",
      attempted_models_json: JSON.stringify(attemptedModels),
    }),
  });
  const stored = await persistD1WebsiteAnalysis(
    stub.database,
    analysisResult(7, { model: "gemini-3.8-flash", attemptedModels }),
    STORED_AT,
  );
  assert.deepEqual(stored.attemptedModels, ["gemini-3.6-flash", "gemini-3.8-flash"]);
});

test("public persistence contract is exported", () => {
  const code: WebsiteAnalysisPersistenceErrorCode = "PERSISTENCE_FAILED";
  const error = new WebsiteAnalysisPersistenceError("EVIDENCE_NOT_FOUND");
  const unused: D1WebsiteAnalysisDatabase | null = null;
  const stored: StoredWebsiteAnalysis | null = null;
  assert.equal(code, "PERSISTENCE_FAILED");
  assert.equal(error.message, "Crawl evidence was not found.");
  assert.equal(unused, null);
  assert.equal(stored, null);
});

test("successful analysis persists and round-trips", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched");
    const inputFinding = {
      category: "design" as const,
      severity: "medium" as const,
      observation: "The heading is unclear.",
      evidence: "The page shows one heading.",
      recommendation: "State the offer in the heading.",
    };
    const attemptedModels = ["gemini-3.6-flash", "gemini-3.8-flash"] as const;
    const stored = await persistD1WebsiteAnalysis(
      database,
      analysisResult(evidenceId, {
        findings: [inputFinding],
        model: "gemini-3.8-flash",
        attemptedModels,
      }),
      STORED_AT,
    );
    assert.equal(typeof stored.id, "number");
    assert.ok(Number.isSafeInteger(stored.id) && stored.id > 0);
    assert.equal(stored.evidenceId, evidenceId);
    assert.equal(stored.leadId, LEAD_ID);
    assert.equal(stored.leadVersion, LEAD_VERSION);
    assert.equal(stored.summary, "Stored page summary");
    assert.deepEqual(stored.findings, [inputFinding]);
    assert.equal(stored.provider, "gemini");
    assert.equal(stored.model, "gemini-3.8-flash");
    assert.deepEqual(stored.attemptedModels, ["gemini-3.6-flash", "gemini-3.8-flash"]);
    assert.equal(stored.storedAt, STORED_AT);
    assert.equal(Object.isFrozen(stored), true);
    assert.equal(Object.isFrozen(stored.findings), true);
    assert.equal(Object.isFrozen(stored.findings[0]), true);
    assert.equal(Object.isFrozen(stored.attemptedModels), true);
    assert.equal(Object.isFrozen(inputFinding), false);
    const row = await database
      .prepare(
        "SELECT findings_json, attempted_models_json FROM website_analyses WHERE id = ?",
      )
      .bind(stored.id)
      .first();
    assert.ok(row !== null);
    assert.equal(row.findings_json, JSON.stringify([inputFinding]));
    assert.equal(row.attempted_models_json, JSON.stringify(attemptedModels));
  });
});

test("a second persistence creates a different id", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched");
    const first = await persistD1WebsiteAnalysis(
      database,
      analysisResult(evidenceId, { summary: "First stored summary" }),
      STORED_AT,
    );
    const second = await persistD1WebsiteAnalysis(
      database,
      analysisResult(evidenceId, { summary: "Second stored summary" }),
      STORED_AT,
    );
    assert.notEqual(first.id, second.id);
    const rows = await database
      .prepare("SELECT id, summary FROM website_analyses ORDER BY id")
      .all();
    assert.equal(rows.results.length, 2);
    assert.equal(rows.results[0]?.summary, "First stored summary");
    assert.equal(rows.results[1]?.summary, "Second stored summary");
    assert.equal(rows.results[0]?.id, first.id);
    assert.equal(rows.results[1]?.id, second.id);
  });
});
