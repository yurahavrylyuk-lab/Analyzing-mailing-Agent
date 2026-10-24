import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Miniflare } from "miniflare";
import { CrawlEvidencePersistenceError } from "../../src/crawler/evidence-domain";
import type { GeminiWebsiteAnalysisConfig } from "../../src/config/env";
import type { WebsiteFacts } from "../../src/website-analysis/facts";
import {
  D1WebsiteAnalysisPipelineError,
  GEMINI_WEBSITE_BATCH_SIZE,
  WebsiteAnalysisError,
  WebsiteAnalysisPersistenceError,
  analyzeWebsitesWithGemini,
  runD1WebsiteAnalysisPipeline,
  type D1WebsiteAnalysisPipelineDatabase,
  type D1WebsiteAnalysisPipelineErrorCode,
  type D1WebsiteAnalysisPipelineOptions,
  type D1WebsiteAnalysisPipelineResult,
} from "../../src/website-analysis";
import {
  GeminiWebsiteAnalysisError,
  type GeminiWebsiteAnalysisResult,
  type GeminiWebsiteBatchResult,
} from "../../src/website-analysis/providers/gemini";

const LEAD_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_VERSION = 4;
const REQUESTED_URL = "https://example.com/a";
const CONFIG: GeminiWebsiteAnalysisConfig = {
  provider: "gemini",
  apiKey: "test-key",
  dailyRequestLimit: 10,
};

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
  batch(statements: readonly TestStatement[]): Promise<readonly unknown[]>;
  exec(sql: string): Promise<unknown>;
};

const TEST_INSTANT = "2026-10-24T12:00:00.000Z";
const TEST_UTC_DATE = "2026-10-24";

function testNow(): Date {
  return new Date(TEST_INSTANT);
}

const ZERO_SUMMARY = {
  selected: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  persisted: 0,
  budget: {
    utcDate: TEST_UTC_DATE,
    websitesAdmitted: 0,
    websiteLimit: 50,
    geminiRequestsUsed: 0,
    geminiRequestLimit: 10,
    stoppedReason: "no_evidence" as const,
  },
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
    await database.exec(
      readFileSync(join(process.cwd(), "migrations/0003_website_analysis_selection.sql"), "utf8"),
    );
    await database.exec(
      readFileSync(join(process.cwd(), "migrations/0004_website_analysis_daily_usage.sql"), "utf8"),
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
  attemptedAt: string,
  bodyText = "<p>a</p>",
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
      attemptedAt,
      fetched ? REQUESTED_URL : null,
      fetched ? 200 : null,
      fetched ? "text/html" : null,
      fetched ? bodyText : null,
      fetched ? Buffer.byteLength(bodyText, "utf8") : null,
      fetched ? 0 : null,
      fetched ? null : "TIMEOUT",
    )
    .run();
  return inserted.meta.last_row_id;
}

async function insertAnalysis(database: TestDatabase, evidenceId: number): Promise<number> {
  const inserted = await database
    .prepare(
      `INSERT INTO website_analyses (
        evidence_id, lead_id, lead_version, summary, findings_json,
        provider, model, attempted_models_json, stored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      evidenceId,
      LEAD_ID,
      LEAD_VERSION,
      "Stored page summary",
      "[]",
      "gemini",
      "gemini-3.8-flash",
      '["gemini-3.8-flash"]',
      "2026-10-23T12:34:56.789Z",
    )
    .run();
  return inserted.meta.last_row_id;
}

function throwingDatabase(): { readonly database: TestDatabase; prepared(): number } {
  let prepared = 0;
  return {
    prepared: () => prepared,
    database: {
      prepare() {
        prepared += 1;
        throw new Error("prepare called");
      },
      batch() {
        return Promise.reject(new Error("unused"));
      },
      exec() {
        return Promise.resolve();
      },
    },
  };
}

function fetchedRow(id: number): Record<string, unknown> {
  const bodyText = "<p>a</p>";
  return {
    id,
    lead_id: LEAD_ID,
    lead_version: LEAD_VERSION,
    outcome: "fetched",
    requested_url: REQUESTED_URL,
    attempted_at: "2026-10-23T00:00:00.000Z",
    final_url: REQUESTED_URL,
    status_code: 200,
    content_type: "text/html",
    body_text: bodyText,
    byte_length: Buffer.byteLength(bodyText, "utf8"),
    redirect_count: 0,
    failure_code: null,
  };
}

function resultFor(facts: WebsiteFacts, summary = "Stored page summary"): GeminiWebsiteAnalysisResult {
  return {
    analysis: {
      evidenceId: facts.evidenceId,
      leadId: facts.leadId,
      leadVersion: facts.leadVersion,
      summary,
      findings: [],
    },
    provider: "gemini",
    model: "gemini-3.8-flash",
    attemptedModels: ["gemini-3.8-flash"],
  };
}

function successBatch(
  websites: readonly WebsiteFacts[],
  summary?: string,
): GeminiWebsiteBatchResult {
  return {
    requestExhausted: false,
    items: websites.map((facts) => ({
      ok: true as const,
      facts,
      result: resultFor(facts, summary),
    })),
    model: "gemini-3.8-flash",
    attemptedModels: ["gemini-3.8-flash"],
  };
}

const offlineAnalyzeBatch = (websites: readonly WebsiteFacts[]) =>
  Promise.resolve(successBatch(websites));

async function usageFor(database: TestDatabase, utcDate: string) {
  return database
    .prepare(
      `SELECT websites_admitted, gemini_requests_used
       FROM website_analysis_daily_usage
       WHERE utc_date = ?`,
    )
    .bind(utcDate)
    .first();
}

async function admissionCount(database: TestDatabase, utcDate: string): Promise<number> {
  const rows = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM website_analysis_daily_admissions WHERE utc_date = ?",
    )
    .bind(utcDate)
    .all();
  return Number(rows.results[0]?.count);
}

function stubDatabase(
  all: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>,
): TestDatabase {
  const statement: TestStatement = {
    bind() {
      return statement;
    },
    all,
    first: () => Promise.resolve(null),
    run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
  };
  return {
    prepare() {
      return statement;
    },
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve(),
  };
}

test("the evidence index is non-unique and allows a second analysis", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertEvidence(database, "fetched", "2026-10-23T00:00:00.000Z");
    const first = await insertAnalysis(database, evidenceId);
    const second = await insertAnalysis(database, evidenceId);
    assert.ok(first > 0);
    assert.ok(second > 0);
    assert.notEqual(first, second);

    const indexes = await database.prepare("PRAGMA index_list('website_analyses')").all();
    assert.equal(indexes.results.length, 1);
    const index = indexes.results[0];
    assert.equal(index?.name, "website_analyses_evidence_id_idx");
    assert.equal(Number(index?.unique), 0);

    const objects = await database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'website_analyses_evidence_id_idx'",
      )
      .all();
    const sql = String(objects.results[0]?.sql);
    assert.equal(sql.includes("CREATE INDEX"), true);
    assert.equal(sql.includes("UNIQUE"), false);
  });
});

test("invalid maxItems does not prepare a D1 statement", async () => {
  const invalid = [-1, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number];
  for (const maxItems of invalid) {
    const recorder = throwingDatabase();
    const error = await expectRejected(
      runD1WebsiteAnalysisPipeline(recorder.database, CONFIG, maxItems),
    );
    assert.equal(error instanceof D1WebsiteAnalysisPipelineError, true);
    assert.equal((error as D1WebsiteAnalysisPipelineError).code, "INVALID_REQUEST");
    assert.equal((error as Error).message, "D1 website analysis pipeline request is invalid.");
    assert.equal(recorder.prepared(), 0);
  }
});

async function admitIds(
  database: TestDatabase,
  utcDate: string,
  evidenceIds: readonly number[],
): Promise<void> {
  for (const evidenceId of evidenceIds) {
    await database
      .prepare(
        "INSERT INTO website_analysis_daily_admissions (utc_date, evidence_id) VALUES (?, ?)",
      )
      .bind(utcDate, evidenceId)
      .run();
  }
}

async function setRequestCount(
  database: TestDatabase,
  utcDate: string,
  used: number,
): Promise<void> {
  await database
    .prepare(
      "UPDATE website_analysis_daily_usage SET gemini_requests_used = ? WHERE utc_date = ?",
    )
    .bind(used, utcDate)
    .run();
}

function dummyIds(start: number, count: number): number[] {
  return Array.from({ length: count }, (_value, index) => start + index);
}

test("maxItems 0 reads the ledger and writes nothing", async () => {
  await withDatabase(async (database) => {
    await admitIds(database, TEST_UTC_DATE, dummyIds(2000, 4));
    await setRequestCount(database, TEST_UTC_DATE, 2);
    const before = await admissionCount(database, TEST_UTC_DATE);
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 0, {
      now: testNow,
      analyzeBatch: () => {
        calls += 1;
        return Promise.reject(new Error("analyze called"));
      },
    });
    assert.equal(calls, 0);
    assert.deepEqual(
      [summary.selected, summary.succeeded, summary.failed, summary.retried, summary.persisted],
      [0, 0, 0, 0, 0],
    );
    assert.equal(summary.budget.utcDate, TEST_UTC_DATE);
    assert.equal(summary.budget.websitesAdmitted, 4);
    assert.equal(summary.budget.geminiRequestsUsed, 2);
    assert.equal(summary.budget.websiteLimit, 50);
    assert.equal(summary.budget.stoppedReason, "max_items");
    assert.equal(await admissionCount(database, TEST_UTC_DATE), before);
    const analyses = await database.prepare("SELECT COUNT(*) AS count FROM website_analyses").all();
    assert.equal(Number(analyses.results[0]?.count), 0);
    assert.equal(Object.isFrozen(summary), true);
  });
});

test("maxItems 1 and 50 select only that many eligible rows", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    for (let index = 0; index < 3; index += 1) {
      await insertEvidence(database, "fetched", `2026-10-23T00:00:0${index}.000Z`);
    }
    const one = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      analyzeBatch: offlineAnalyzeBatch,
    });
    assert.equal(one.selected, 1);
  });

  await withDatabase(async (database) => {
    await insertLead(database);
    for (let index = 0; index < 50; index += 1) {
      const seconds = String(index).padStart(2, "0");
      await insertEvidence(database, "fetched", `2026-10-23T00:00:${seconds}.000Z`);
    }
    const fifty = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      analyzeBatch: offlineAnalyzeBatch,
    });
    assert.equal(fifty.selected, 50);
  });
});

test("only fetched evidence without an analysis is selected", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", "2026-10-23T00:00:01.000Z");
    await insertEvidence(database, "failed", "2026-10-23T00:00:02.000Z");
    const analyzed = await insertEvidence(database, "fetched", "2026-10-23T00:00:03.000Z");
    await insertAnalysis(database, analyzed);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      analyzeBatch: offlineAnalyzeBatch,
    });
    assert.equal(summary.selected, 1);
  });
});

test("a D1 selection failure is SELECTION_FAILED", async () => {
  const exploding = stubDatabase(() => Promise.reject(new Error("d1 exploded: secret sql")));
  const exploded = await expectRejected(runD1WebsiteAnalysisPipeline(exploding, CONFIG, 1));
  assert.equal(exploded instanceof D1WebsiteAnalysisPipelineError, true);
  assert.equal((exploded as D1WebsiteAnalysisPipelineError).code, "SELECTION_FAILED");
  assert.equal((exploded as Error).message, "D1 website analysis selection failed.");
  assert.equal("cause" in (exploded as object), false);
  assert.equal((exploded as Error).message.includes("secret"), false);
  assert.equal((exploded as Error).message.includes("exploded"), false);

  const oversized = stubDatabase(() =>
    Promise.resolve({ results: [fetchedRow(1), fetchedRow(2)] }),
  );
  const tooMany = await expectRejected(runD1WebsiteAnalysisPipeline(oversized, CONFIG, 1));
  assert.equal(tooMany instanceof D1WebsiteAnalysisPipelineError, true);
  assert.equal((tooMany as D1WebsiteAnalysisPipelineError).code, "SELECTION_FAILED");
});

test("a corrupt selected row fails before analysis", async () => {
  const database = stubDatabase(() =>
    Promise.resolve({
      results: [
        {
          id: 1,
          lead_id: LEAD_ID,
          lead_version: LEAD_VERSION,
          outcome: "fetched",
          requested_url: REQUESTED_URL,
          attempted_at: "2026-10-23T00:00:00.000Z",
          final_url: null,
          status_code: null,
          content_type: null,
          body_text: null,
          byte_length: null,
          redirect_count: null,
          failure_code: null,
        },
      ],
    }),
  );
  const error = await expectRejected(runD1WebsiteAnalysisPipeline(database, CONFIG, 1));
  assert.equal(error instanceof CrawlEvidencePersistenceError, true);
  assert.equal(error instanceof D1WebsiteAnalysisPipelineError, false);
});

test("an empty eligible set returns a frozen zero summary", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, { now: testNow });
    assert.deepEqual(summary, ZERO_SUMMARY);
    assert.equal(Object.isFrozen(summary), true);
  });
});

const OLDER_AT = "2026-10-23T01:00:00.000Z";
const NEWER_AT = "2026-10-23T03:00:00.000Z";
const OLDER_BODY = "<title>Older</title><p>Older page</p>";
const NEWER_BODY = "<title>Newer</title><p>Newer page</p>";

async function insertOrderedPair(database: TestDatabase): Promise<{ olderId: number; newerId: number }> {
  await insertLead(database);
  const newerId = await insertEvidence(database, "fetched", NEWER_AT, NEWER_BODY);
  const olderId = await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
  return { olderId, newerId };
}

test("analyzeWebsitesWithGemini receives facts in selected order", async () => {
  await withDatabase(async (database) => {
    const { olderId, newerId } = await insertOrderedPair(database);
    const calls: WebsiteFacts[][] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      now: testNow,
      analyzeBatch: (websites, config) => {
        calls.push([...websites]);
        assert.equal(config, CONFIG);
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0]?.map((facts) => facts.evidenceId),
      [olderId, newerId],
    );
    assert.equal(calls[0]?.[0]?.title, "Older");
    assert.equal(calls[0]?.[0]?.visibleText.includes("Older page"), true);
    assert.equal(calls[0]?.[1]?.title, "Newer");
    assert.equal(calls[0]?.[1]?.visibleText.includes("Newer page"), true);
    assert.equal(summary.selected, 2);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.retried, 0);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
  });
});

test("maxItems 1 keeps the oldest eligible evidence", async () => {
  await withDatabase(async (database) => {
    const { olderId } = await insertOrderedPair(database);
    const calls: WebsiteFacts[][] = [];
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: testNow,
      analyzeBatch: (websites) => {
        calls.push([...websites]);
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0]?.evidenceId, olderId);
  });
});

test("sleep and now are the only run seams the batch path uses", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    const sleeps: number[] = [];
    let attempts = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: testNow,
      analysisRunOptions: {
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      },
      analyzeBatch: (websites) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE"));
        }
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.equal(summary.retried, 1);
    assert.equal(summary.succeeded, 1);
    assert.deepEqual(sleeps, [90_000]);
    assert.equal(attempts, 2);
    const dates = await database.prepare(
      "SELECT utc_date FROM website_analysis_daily_usage",
    ).all();
    assert.equal(String(dates.results[0]?.utc_date), TEST_UTC_DATE);
  });
});

test("one selected website produces one batch call", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", "2026-10-23T00:00:00.000Z");
    let calls = 0;
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      now: testNow,
      analyzeBatch: (websites) => {
        calls += 1;
        assert.equal(websites.length, 1);
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.equal(calls, 1);
  });
});

test("an empty selection does not analyze or persist", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: () => {
        calls += 1;
        return Promise.reject(new Error("analyze called"));
      },
    });
    const rows = await database.prepare("SELECT COUNT(*) AS count FROM website_analyses").all();
    assert.equal(calls, 0);
    assert.equal(Number(rows.results[0]?.count), 0);
    assert.deepEqual(summary, ZERO_SUMMARY);
    assert.equal(Object.isFrozen(summary), true);
  });
});

test("a known Gemini failure stays on that website", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: testNow,
      analyzeBatch: (websites) => Promise.resolve({
        requestExhausted: false,
        model: null,
        attemptedModels: [],
        items: websites.map((facts) => ({
          ok: false as const,
          facts,
          error: new WebsiteAnalysisError("INVALID_ANALYSIS"),
        })),
      }),
    });
    assert.equal(summary.selected, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.retried, 0);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
  });
});

test("an unexpected analyzer error escapes", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    const boom = new Error("boom");
    const error = await expectRejected(
      runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
        now: testNow,
        analyzeBatch: () => Promise.reject(boom),
      }),
    );
    assert.equal(error, boom);
    assert.equal(error instanceof D1WebsiteAnalysisPipelineError, false);
  });
});

test("the completed summary is frozen", async () => {
  await withDatabase(async (database) => {
    await insertOrderedPair(database);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      analyzeBatch: offlineAnalyzeBatch,
    });
    assert.equal(Object.isFrozen(summary), true);
    assert.equal(summary.succeeded, 2);
  });
});

const FIRST_STORED_AT = "2026-10-23T01:02:03.004Z";
const SECOND_STORED_AT = "2026-10-23T05:06:07.008Z";
const THIRD_STORED_AT = "2026-10-23T06:07:08.009Z";

async function analysisRows(
  database: TestDatabase,
): Promise<readonly Record<string, unknown>[]> {
  const rows = await database
    .prepare(
      "SELECT evidence_id, stored_at, summary FROM website_analyses ORDER BY id ASC",
    )
    .all();
  return rows.results;
}

async function insertTimedEvidence(
  database: TestDatabase,
  attemptedAt: string,
): Promise<number> {
  return insertEvidence(database, "fetched", attemptedAt, OLDER_BODY);
}

test("successful items persist and failed items do not", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const olderId = await insertTimedEvidence(database, OLDER_AT);
    const newerId = await insertTimedEvidence(database, NEWER_AT);
    let storedAtCalls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      storedAt: () => {
        storedAtCalls += 1;
        return FIRST_STORED_AT;
      },
      analyzeBatch: (websites) => Promise.resolve({
        requestExhausted: false,
        model: "gemini-3.8-flash",
        attemptedModels: ["gemini-3.8-flash"],
        items: websites.map((facts) => (
          facts.evidenceId === newerId
            ? {
                ok: false as const,
                facts,
                error: new WebsiteAnalysisError("INVALID_ANALYSIS"),
              }
            : {
                ok: true as const,
                facts,
                result: resultFor(facts, "Older summary"),
              }
        )),
      }),
    });
    assert.equal(summary.selected, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.persisted, 1);
    assert.equal(summary.succeeded + summary.failed, summary.selected);
    assert.equal(storedAtCalls, 1);
    const rows = await analysisRows(database);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]?.evidence_id), olderId);
    assert.equal(rows[0]?.stored_at, FIRST_STORED_AT);
    assert.equal(rows[0]?.summary, "Older summary");
    assert.equal(
      rows.some((row) => Number(row.evidence_id) === newerId),
      false,
    );
  });
});

test("successful items persist in original result order", async () => {
  await withDatabase(async (database) => {
    const { olderId, newerId } = await insertOrderedPair(database);
    const timestamps = [FIRST_STORED_AT, SECOND_STORED_AT];
    let storedAtCalls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      storedAt: () => {
        const timestamp = timestamps[storedAtCalls];
        storedAtCalls += 1;
        if (timestamp === undefined) {
          throw new Error("storedAt exhausted");
        }
        return timestamp;
      },
      analyzeBatch: offlineAnalyzeBatch,
    });
    const rows = await analysisRows(database);
    assert.equal(summary.persisted, 2);
    assert.equal(storedAtCalls, 2);
    assert.deepEqual(
      rows.map((row) => [Number(row.evidence_id), row.stored_at]),
      [
        [olderId, FIRST_STORED_AT],
        [newerId, SECOND_STORED_AT],
      ],
    );
  });
});

test("the default storedAt is a canonical timestamp", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertTimedEvidence(database, OLDER_AT);
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      analyzeBatch: offlineAnalyzeBatch,
    });
    const rows = await analysisRows(database);
    assert.match(String(rows[0]?.stored_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

test("a storedAt callback failure leaves earlier rows durable", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertTimedEvidence(database, "2026-10-23T01:00:00.000Z");
    await insertTimedEvidence(database, "2026-10-23T02:00:00.000Z");
    await insertTimedEvidence(database, "2026-10-23T03:00:00.000Z");
    const clockError = new Error("clock failed");
    let calls = 0;
    const error = await expectRejected(
      runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
        storedAt: () => {
          calls += 1;
          if (calls === 1) {
            return FIRST_STORED_AT;
          }
          if (calls === 2) {
            return SECOND_STORED_AT;
          }
          throw clockError;
        },
        analyzeBatch: offlineAnalyzeBatch,
      }),
    );
    assert.equal(error, clockError);
    assert.equal(error instanceof D1WebsiteAnalysisPipelineError, false);
    assert.equal((await analysisRows(database)).length, 2);
  });
});

test("a persistence failure propagates and keeps earlier rows", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertTimedEvidence(database, "2026-10-23T01:00:00.000Z");
    await insertTimedEvidence(database, "2026-10-23T02:00:00.000Z");
    await insertTimedEvidence(database, "2026-10-23T03:00:00.000Z");
    const timestamps = [FIRST_STORED_AT, SECOND_STORED_AT, "not-a-timestamp"];
    let calls = 0;
    const error = await expectRejected(
      runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
        storedAt: () => {
          const timestamp = timestamps[calls];
          calls += 1;
          if (timestamp === undefined) {
            throw new Error("storedAt exhausted");
          }
          return timestamp;
        },
        analyzeBatch: offlineAnalyzeBatch,
      }),
    );
    assert.equal(error instanceof WebsiteAnalysisPersistenceError, true);
    assert.equal((error as WebsiteAnalysisPersistenceError).code, "PERSISTENCE_FAILED");
    assert.equal((await analysisRows(database)).length, 2);
  });
});

test("the next run excludes evidence persisted before a persistence failure", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const firstId = await insertTimedEvidence(database, "2026-10-23T01:00:00.000Z");
    const secondId = await insertTimedEvidence(database, "2026-10-23T02:00:00.000Z");
    const thirdId = await insertTimedEvidence(database, "2026-10-23T03:00:00.000Z");
    const timestamps = [FIRST_STORED_AT, SECOND_STORED_AT, "not-a-timestamp"];
    let calls = 0;
    const error = await expectRejected(
      runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
        storedAt: () => {
          const timestamp = timestamps[calls];
          calls += 1;
          if (timestamp === undefined) {
            throw new Error("storedAt exhausted");
          }
          return timestamp;
        },
        analyzeBatch: offlineAnalyzeBatch,
      }),
    );
    assert.equal(error instanceof WebsiteAnalysisPersistenceError, true);
    const seen: number[] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      storedAt: () => THIRD_STORED_AT,
      now: testNow,
      analyzeBatch: (websites) => {
        for (const facts of websites) seen.push(facts.evidenceId);
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, [thirdId]);
    assert.equal(summary.selected, 1);
    assert.equal(summary.persisted, 1);
    assert.equal(firstId === secondId, false);
  });
});

test("a failed analysis remains eligible later", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const evidenceId = await insertTimedEvidence(database, OLDER_AT);
    const first = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: testNow,
      analyzeBatch: () => Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR")),
    });
    assert.equal(first.failed, 1);
    assert.equal((await analysisRows(database)).length, 0);
    const seen: number[] = [];
    const second = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      storedAt: () => FIRST_STORED_AT,
      now: testNow,
      analyzeBatch: (websites) => {
        for (const facts of websites) seen.push(facts.evidenceId);
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, [evidenceId]);
    assert.equal(second.persisted, 1);
    assert.equal((await analysisRows(database)).length, 1);
  });
});

test("the summary object is frozen after persistence", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertTimedEvidence(database, OLDER_AT);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      storedAt: () => FIRST_STORED_AT,
      analyzeBatch: offlineAnalyzeBatch,
    });
    assert.equal(Object.isFrozen(summary), true);
    assert.equal(summary.persisted, 1);
  });
});

test("a batch of five uses one first-request reservation", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await insertEvidence(database, "fetched", `2026-10-24T00:00:0${index}.000Z`));
    }
    let calls = 0;
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: async (websites) => {
        calls += 1;
        const usage = await usageFor(database, TEST_UTC_DATE);
        assert.equal(usage?.websites_admitted, 5);
        assert.equal(usage?.gemini_requests_used, 1);
        assert.deepEqual(websites.map((facts) => facts.evidenceId), ids);
        return successBatch(websites);
      },
    });
    assert.equal(calls, 1);
  });
});

test("four valid items persist and the invalid sibling does not", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    for (let index = 0; index < 5; index += 1) {
      await insertEvidence(database, "fetched", `2026-10-24T00:00:0${index}.000Z`);
    }
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      storedAt: () => FIRST_STORED_AT,
      analyzeBatch: (websites) => {
        calls += 1;
        return Promise.resolve({
          requestExhausted: false,
          model: "gemini-3.8-flash",
          attemptedModels: ["gemini-3.8-flash"],
          items: websites.map((facts, index) => (
            index === 4
              ? {
                  ok: false as const,
                  facts,
                  error: new WebsiteAnalysisError("INVALID_ANALYSIS"),
                }
              : { ok: true as const, facts, result: resultFor(facts) }
          )),
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(summary.selected, 5);
    assert.equal(summary.succeeded, 4);
    assert.equal(summary.failed, 1);
    assert.equal(summary.persisted, 4);
    assert.equal(summary.retried, 0);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
    assert.equal((await analysisRows(database)).length, 4);
  });
});

test("transport failure defers the same batch once", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await insertEvidence(database, "fetched", `2026-10-24T00:00:0${index}.000Z`));
    }
    const sleeps: number[] = [];
    const seen: number[][] = [];
    let attempts = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analysisRunOptions: {
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      },
      analyzeBatch: (websites) => {
        attempts += 1;
        seen.push(websites.map((facts) => facts.evidenceId));
        if (attempts === 1) {
          return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE"));
        }
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(sleeps, [90_000]);
    assert.deepEqual(seen, [ids, ids]);
    assert.equal(summary.retried, 5);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
    const usage = await usageFor(database, TEST_UTC_DATE);
    assert.equal(usage?.websites_admitted, 5);
    assert.equal(usage?.gemini_requests_used, 2);
  });
});

test("HTTP and validation failures are not deferred", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    const sleeps: number[] = [];
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: testNow,
      analysisRunOptions: {
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
      },
      analyzeBatch: () => {
        calls += 1;
        return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR"));
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(summary.retried, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
    assert.equal(await admissionCount(database, TEST_UTC_DATE), 1);
  });
});

test("a same-batch retry does not insert another admission", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    for (let index = 0; index < 2; index += 1) {
      await insertEvidence(database, "fetched", `2026-10-24T00:00:0${index}.000Z`);
    }
    let attempts = 0;
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 2, {
      now: testNow,
      analysisRunOptions: {
        sleep: () => Promise.resolve(),
      },
      analyzeBatch: (websites) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE"));
        }
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.equal(attempts, 2);
    assert.equal(await admissionCount(database, TEST_UTC_DATE), 2);
  });
});

test("an in-flight retry after midnight charges only the new day's request", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", "2026-10-24T23:00:00.000Z");
    let thrown = false;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: () => new Date(thrown ? "2026-10-25T00:00:20.000Z" : "2026-10-24T23:59:50.000Z"),
      analysisRunOptions: {
        sleep: () => Promise.resolve(),
      },
      analyzeBatch: (websites) => {
        if (!thrown) {
          thrown = true;
          return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE"));
        }
        return Promise.resolve(successBatch(websites));
      },
    });
    const yesterday = await usageFor(database, "2026-10-24");
    const today = await usageFor(database, "2026-10-25");
    assert.equal(yesterday?.websites_admitted, 1);
    assert.equal(yesterday?.gemini_requests_used, 1);
    assert.equal(today?.websites_admitted, 0);
    assert.equal(today?.gemini_requests_used, 1);
    assert.equal(await admissionCount(database, "2026-10-25"), 0);
    assert.equal(summary.retried, 1);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
  });
});

test("a retry that cannot reserve does not fetch and is not retried", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, { ...CONFIG, dailyRequestLimit: 1 }, 1, {
      now: testNow,
      analysisRunOptions: {
        sleep: () => Promise.resolve(),
      },
      analyzeBatch: () => {
        calls += 1;
        return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE"));
      },
    });
    assert.equal(calls, 1);
    assert.equal(summary.retried, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.selected, 1);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
    assert.equal(await admissionCount(database, TEST_UTC_DATE), 1);
  });
});

async function insertOrderedEvidence(database: TestDatabase, count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const seconds = String(index).padStart(2, "0");
    ids.push(await insertEvidence(database, "fetched", `2026-10-24T00:00:${seconds}.000Z`));
  }
  return ids;
}

test("usage 49 of 50 admits only the first of five new candidates", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await admitIds(database, TEST_UTC_DATE, dummyIds(3000, 49));
    const ids = await insertOrderedEvidence(database, 5);
    const seen: number[][] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: (websites) => {
        seen.push(websites.map((facts) => facts.evidenceId));
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, [[ids[0]]]);
    const usage = await usageFor(database, TEST_UTC_DATE);
    assert.equal(usage?.websites_admitted, 50);
    assert.equal(usage?.gemini_requests_used, 1);
    assert.equal(summary.selected, 1);
    assert.equal(summary.budget.stoppedReason, "website_cap");
    assert.equal(summary.selected, summary.succeeded + summary.failed);
    for (const evidenceId of ids.slice(1)) {
      const admission = await database
        .prepare(
          "SELECT COUNT(*) AS count FROM website_analysis_daily_admissions WHERE utc_date = ? AND evidence_id = ?",
        )
        .bind(TEST_UTC_DATE, evidenceId)
        .all();
      assert.equal(Number(admission.results[0]?.count), 0);
      const analysis = await database
        .prepare("SELECT COUNT(*) AS count FROM website_analyses WHERE evidence_id = ?")
        .bind(evidenceId)
        .all();
      assert.equal(Number(analysis.results[0]?.count), 0);
    }
  });
});

test("usage 49 of 50 keeps admitted A and B and the next new candidate only", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 5);
    await admitIds(database, TEST_UTC_DATE, [ids[0]!, ids[1]!, ...dummyIds(3100, 47)]);
    const limits: unknown[] = [];
    const wrapped: TestDatabase = {
      prepare(sql: string) {
        return {
          bind(...values: readonly unknown[]) {
            if (sql.includes("LIMIT ?")) limits.push(values[values.length - 1]);
            return database.prepare(sql).bind(...values);
          },
          all: () => Promise.reject(new Error("unbound")),
          first: () => Promise.reject(new Error("unbound")),
          run: () => Promise.reject(new Error("unbound")),
        };
      },
      batch: (statements) => database.batch(statements),
      exec: (sql) => database.exec(sql),
    };
    const seen: number[][] = [];
    const summary = await runD1WebsiteAnalysisPipeline(wrapped, CONFIG, 5, {
      now: testNow,
      analyzeBatch: (websites) => {
        seen.push(websites.map((facts) => facts.evidenceId));
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, [ids.slice(0, 3)]);
    assert.deepEqual(limits, [5]);
    const usage = await usageFor(database, TEST_UTC_DATE);
    assert.equal(usage?.websites_admitted, 50);
    assert.equal(summary.selected, 3);
    assert.equal(summary.budget.stoppedReason, "website_cap");
    for (const evidenceId of ids.slice(3)) {
      assert.equal(await admissionCountFor(database, evidenceId), 0);
    }
  });
});

async function admissionCountFor(database: TestDatabase, evidenceId: number): Promise<number> {
  const rows = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM website_analysis_daily_admissions WHERE utc_date = ? AND evidence_id = ?",
    )
    .bind(TEST_UTC_DATE, evidenceId)
    .all();
  return Number(rows.results[0]?.count);
}

test("usage 50 of 50 reanalyzes an admitted candidate when a request remains", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 2);
    await admitIds(database, TEST_UTC_DATE, [ids[0]!, ...dummyIds(3200, 49)]);
    const seen: number[][] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: (websites) => {
        seen.push(websites.map((facts) => facts.evidenceId));
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, [[ids[0]]]);
    const usage = await usageFor(database, TEST_UTC_DATE);
    assert.equal(usage?.websites_admitted, 50);
    assert.equal(usage?.gemini_requests_used, 1);
    assert.equal(summary.selected, 1);
    assert.equal(summary.budget.stoppedReason, "website_cap");
    assert.equal(await admissionCountFor(database, ids[1]!), 0);
  });
});

test("usage 50 of 50 does not select a new candidate", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 1);
    await admitIds(database, TEST_UTC_DATE, dummyIds(3300, 50));
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: () => {
        calls += 1;
        return Promise.reject(new Error("analyze called"));
      },
    });
    assert.equal(calls, 0);
    assert.equal(summary.selected, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.budget.stoppedReason, "website_cap");
    assert.equal(await admissionCount(database, TEST_UTC_DATE), 50);
    assert.equal(await admissionCountFor(database, ids[0]!), 0);
  });
});

test("request exhaustion stops before fetch even for an admitted website", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 1);
    await admitIds(database, TEST_UTC_DATE, [ids[0]!]);
    await setRequestCount(database, TEST_UTC_DATE, CONFIG.dailyRequestLimit);
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: () => {
        calls += 1;
        return Promise.reject(new Error("analyze called"));
      },
    });
    assert.equal(calls, 0);
    assert.equal(summary.selected, 0);
    assert.equal(summary.budget.stoppedReason, "request_cap");
    assert.equal((await usageFor(database, TEST_UTC_DATE))?.websites_admitted, 1);
  });
});

test("two already admitted and three new with three slots sends all five", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 5);
    await admitIds(database, TEST_UTC_DATE, [ids[0]!, ids[1]!, ...dummyIds(3400, 45)]);
    const before = new Set<number>();
    const existing = await database
      .prepare("SELECT evidence_id FROM website_analysis_daily_admissions WHERE utc_date = ?")
      .bind(TEST_UTC_DATE)
      .all();
    for (const row of existing.results) before.add(Number(row.evidence_id));
    const seen: number[][] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      now: testNow,
      analyzeBatch: (websites) => {
        seen.push(websites.map((facts) => facts.evidenceId));
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, [ids]);
    const usage = await usageFor(database, TEST_UTC_DATE);
    assert.equal(usage?.websites_admitted, 50);
    assert.equal(usage?.gemini_requests_used, 1);
    assert.equal(summary.selected, 5);
    const after = await database
      .prepare("SELECT evidence_id FROM website_analysis_daily_admissions WHERE utc_date = ?")
      .bind(TEST_UTC_DATE)
      .all();
    const added = after.results
      .map((row) => Number(row.evidence_id))
      .filter((evidenceId) => !before.has(evidenceId))
      .sort((left, right) => left - right);
    assert.deepEqual(added, [ids[2], ids[3], ids[4]].sort((left, right) => left - right));
  });
});

test("an invalid daily request limit throws before D1", async () => {
  const recorder = throwingDatabase();
  const error = await expectRejected(
    runD1WebsiteAnalysisPipeline(recorder.database, { ...CONFIG, dailyRequestLimit: 0 }, 1),
  );
  assert.equal(error instanceof D1WebsiteAnalysisPipelineError, true);
  assert.equal((error as D1WebsiteAnalysisPipelineError).code, "INVALID_CONFIGURATION");
  assert.equal((error as Error).message, "D1 website analysis configuration is invalid.");
  assert.equal(recorder.prepared(), 0);
});

test("a same-day reattempt adds no website slot and counts as selected", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 1);
    await admitIds(database, TEST_UTC_DATE, [ids[0]!]);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: testNow,
      analyzeBatch: async (websites) => {
        const usage = await usageFor(database, TEST_UTC_DATE);
        assert.equal(usage?.websites_admitted, 1);
        assert.equal(usage?.gemini_requests_used, 1);
        assert.deepEqual(websites.map((facts) => facts.evidenceId), ids);
        return successBatch(websites);
      },
    });
    assert.equal(summary.selected, 1);
    assert.equal((await usageFor(database, TEST_UTC_DATE))?.websites_admitted, 1);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
  });
});

test("a new invocation after midnight admits the same evidence once", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 1);
    await admitIds(database, "2026-10-24", [ids[0]!]);
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      now: () => new Date("2026-10-25T00:00:01.000Z"),
      analyzeBatch: (websites) => Promise.resolve(successBatch(websites)),
    });
    const today = await usageFor(database, "2026-10-25");
    const yesterday = await usageFor(database, "2026-10-24");
    assert.equal(today?.websites_admitted, 1);
    assert.equal(today?.gemini_requests_used, 1);
    assert.equal(yesterday?.websites_admitted, 1);
    assert.equal(summary.selected, 1);
    assert.equal(await admissionCount(database, "2026-10-25"), 1);
  });
});

test("selected equals succeeded plus failed when a later batch is not entered", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const ids = await insertOrderedEvidence(database, 6);
    const seen: number[] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, { ...CONFIG, dailyRequestLimit: 1 }, 6, {
      now: testNow,
      analyzeBatch: (websites) => {
        for (const facts of websites) seen.push(facts.evidenceId);
        return Promise.resolve(successBatch(websites));
      },
    });
    assert.deepEqual(seen, ids.slice(0, 5));
    assert.equal(seen.includes(ids[5]!), false);
    assert.equal(summary.selected, 5);
    assert.equal(summary.failed, 0);
    assert.equal(summary.selected, summary.succeeded + summary.failed);
    assert.equal((await usageFor(database, TEST_UTC_DATE))?.gemini_requests_used, 1);
    assert.equal(await admissionCountFor(database, ids[5]!), 0);
  });
});

test("a lost admission race recomposes the evidence as already admitted", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    const bodyText = "<p>a</p>";
    await database
      .prepare(
        `INSERT INTO single_page_crawl_evidence (
          id, lead_id, lead_version, outcome, requested_url, attempted_at,
          final_url, status_code, content_type, body_text, byte_length,
          redirect_count, failure_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        123,
        LEAD_ID,
        LEAD_VERSION,
        "fetched",
        REQUESTED_URL,
        "2026-10-24T00:00:00.000Z",
        REQUESTED_URL,
        200,
        "text/html",
        bodyText,
        Buffer.byteLength(bodyText, "utf8"),
        0,
        null,
      )
      .run();
    let batches = 0;
    const wrapped: TestDatabase = {
      prepare(sql: string) {
        return {
          bind(...values: readonly unknown[]) {
            return {
              sql,
              args: values,
              bind() {
                throw new Error("rebind");
              },
              all: () => database.prepare(sql).bind(...values).all(),
              first: () => database.prepare(sql).bind(...values).first(),
              run: () => database.prepare(sql).bind(...values).run(),
            };
          },
          all: () => Promise.reject(new Error("unbound")),
          first: () => Promise.reject(new Error("unbound")),
          run: () => Promise.reject(new Error("unbound")),
        };
      },
      async batch(statements) {
        batches += 1;
        if (batches > 2) throw new Error("third reservation");
        const tracked = statements as unknown as readonly { sql: string; args: readonly unknown[] }[];
        const admits123 = tracked.some((statement) =>
          statement.sql.includes("INSERT INTO website_analysis_daily_admissions")
          && statement.args[1] === 123
        );
        if (admits123) {
          await database
            .prepare(
              "INSERT INTO website_analysis_daily_admissions (utc_date, evidence_id) VALUES (?, ?)",
            )
            .bind(TEST_UTC_DATE, 123)
            .run();
          throw new Error("UNIQUE constraint failed");
        }
        return database.batch(tracked.map((statement) =>
          database.prepare(statement.sql).bind(...statement.args)
        ));
      },
      exec: (sql) => database.exec(sql),
    };
    const seen: number[][] = [];
    const summary = await runD1WebsiteAnalysisPipeline(
      wrapped,
      { ...CONFIG, dailyRequestLimit: 2 },
      1,
      {
        now: testNow,
        analyzeBatch: (websites) => {
          seen.push(websites.map((facts) => facts.evidenceId));
          return Promise.resolve(successBatch(websites));
        },
      },
    );
    assert.deepEqual(seen, [[123]]);
    assert.equal(summary.selected, 1);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.persisted, 1);
    assert.equal(await admissionCountFor(database, 123), 1);
    const usage = await usageFor(database, TEST_UTC_DATE);
    assert.equal(usage?.websites_admitted, 1);
    assert.equal(usage?.gemini_requests_used, 1);
    assert.equal(batches, 2);
  });
});

test("public pipeline exports are the barrel contract", () => {
  const sample: D1WebsiteAnalysisPipelineResult = {
    selected: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    persisted: 0,
    budget: {
      utcDate: TEST_UTC_DATE,
      websitesAdmitted: 0,
      websiteLimit: 50,
      geminiRequestsUsed: 0,
      geminiRequestLimit: 10,
      stoppedReason: "no_evidence",
    },
  };
  const options: D1WebsiteAnalysisPipelineOptions = {};
  const code: D1WebsiteAnalysisPipelineErrorCode = "INVALID_REQUEST";
  const database: D1WebsiteAnalysisPipelineDatabase = {
    prepare() {
      throw new Error("unused");
    },
    batch() {
      return Promise.reject(new Error("unused"));
    },
  };
  assert.equal(typeof runD1WebsiteAnalysisPipeline, "function");
  assert.equal(typeof analyzeWebsitesWithGemini, "function");
  assert.equal(GEMINI_WEBSITE_BATCH_SIZE, 5);
  assert.equal(new D1WebsiteAnalysisPipelineError(code).code, "INVALID_REQUEST");
  assert.equal(sample.persisted, 0);
  assert.deepEqual(Object.keys(sample), [
    "selected",
    "succeeded",
    "failed",
    "retried",
    "persisted",
    "budget",
  ]);
  assert.deepEqual(options, {});
  assert.equal(typeof database.prepare, "function");
});
