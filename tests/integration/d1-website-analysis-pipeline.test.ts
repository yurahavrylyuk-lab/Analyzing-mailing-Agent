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
  WebsiteAnalysisPersistenceError,
  runD1WebsiteAnalysisPipeline,
  type D1WebsiteAnalysisPipelineDatabase,
  type D1WebsiteAnalysisPipelineErrorCode,
  type D1WebsiteAnalysisPipelineOptions,
  type D1WebsiteAnalysisPipelineResult,
} from "../../src/website-analysis";
import {
  GeminiWebsiteAnalysisError,
  type GeminiWebsiteAnalysisResult,
} from "../../src/website-analysis/providers/gemini";

const LEAD_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_VERSION = 4;
const REQUESTED_URL = "https://example.com/a";
const CONFIG: GeminiWebsiteAnalysisConfig = {
  provider: "gemini",
  apiKey: "test-key",
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
  exec(sql: string): Promise<unknown>;
};

const ZERO_SUMMARY = {
  selected: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  persisted: 0,
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

const offlineAnalyze = (facts: WebsiteFacts, _config: GeminiWebsiteAnalysisConfig) =>
  Promise.resolve(resultFor(facts));

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

test("maxItems 0 returns a frozen zero summary without D1 work", async () => {
  const recorder = throwingDatabase();
  const summary = await runD1WebsiteAnalysisPipeline(recorder.database, CONFIG, 0);
  assert.deepEqual(summary, ZERO_SUMMARY);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(recorder.prepared(), 0);
});

test("maxItems 1 and 50 select only that many eligible rows", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    for (let index = 0; index < 3; index += 1) {
      await insertEvidence(database, "fetched", `2026-10-23T00:00:0${index}.000Z`);
    }
    const one = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      analysisRunOptions: { analyze: offlineAnalyze },
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
      analysisRunOptions: { analyze: offlineAnalyze },
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
      analysisRunOptions: { analyze: offlineAnalyze },
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
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5);
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

test("runWebsiteAnalysis receives facts in selected order", async () => {
  await withDatabase(async (database) => {
    const { olderId, newerId } = await insertOrderedPair(database);
    const calls: Array<{ facts: WebsiteFacts; config: GeminiWebsiteAnalysisConfig }> = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      analysisRunOptions: {
        analyze: (facts, config) => {
          calls.push({ facts, config });
          return Promise.resolve(resultFor(facts));
        },
      },
    });
    assert.deepEqual(
      calls.map((call) => call.facts.evidenceId),
      [olderId, newerId],
    );
    assert.equal(calls[0]?.facts.title, "Older");
    assert.equal(calls[0]?.facts.visibleText.includes("Older page"), true);
    assert.equal(calls[1]?.facts.title, "Newer");
    assert.equal(calls[1]?.facts.visibleText.includes("Newer page"), true);
    assert.equal(calls[0]?.config, CONFIG);
    assert.equal(calls[1]?.config, CONFIG);
    assert.equal(calls.length, 2);
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
    const calls: WebsiteFacts[] = [];
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      analysisRunOptions: {
        analyze: (facts, _config) => {
          calls.push(facts);
          return Promise.resolve(resultFor(facts));
        },
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.evidenceId, olderId);
  });
});

test("analysisRunOptions are forwarded to runWebsiteAnalysis", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    const sleeps: number[] = [];
    let attempts = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      analysisRunOptions: {
        now: () => 1_000,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
        analyze: (facts, _config) => {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE"));
          }
          return Promise.resolve(resultFor(facts));
        },
      },
    });
    assert.equal(summary.retried, 1);
    assert.equal(summary.succeeded, 1);
    assert.deepEqual(sleeps, [90_000]);
    assert.equal(attempts, 2);
  });
});

test("runWebsiteAnalysis is invoked once", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    for (let index = 0; index < 3; index += 1) {
      await insertEvidence(database, "fetched", `2026-10-23T00:00:0${index}.000Z`);
    }
    let calls = 0;
    await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      analysisRunOptions: {
        analyze: (facts, _config) => {
          calls += 1;
          return Promise.resolve(resultFor(facts));
        },
      },
    });
    assert.equal(calls, 3);
  });
});

test("an empty selection does not analyze or persist", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    let calls = 0;
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 5, {
      analysisRunOptions: {
        analyze: () => {
          calls += 1;
          return Promise.reject(new Error("analyze called"));
        },
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
      analysisRunOptions: {
        analyze: () => Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR")),
      },
    });
    assert.equal(summary.selected, 1);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.retried, 0);
  });
});

test("an unexpected analyzer error escapes", async () => {
  await withDatabase(async (database) => {
    await insertLead(database);
    await insertEvidence(database, "fetched", OLDER_AT, OLDER_BODY);
    const boom = new Error("boom");
    const error = await expectRejected(
      runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
        analysisRunOptions: {
          analyze: () => Promise.reject(boom),
        },
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
      analysisRunOptions: { analyze: offlineAnalyze },
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
      analysisRunOptions: {
        analyze: (facts, _config) => {
          if (facts.evidenceId === newerId) {
            return Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR"));
          }
          return Promise.resolve(resultFor(facts, "Older summary"));
        },
      },
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
      analysisRunOptions: { analyze: offlineAnalyze },
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
      analysisRunOptions: { analyze: offlineAnalyze },
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
        analysisRunOptions: { analyze: offlineAnalyze },
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
        analysisRunOptions: { analyze: offlineAnalyze },
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
        analysisRunOptions: { analyze: offlineAnalyze },
      }),
    );
    assert.equal(error instanceof WebsiteAnalysisPersistenceError, true);
    const seen: number[] = [];
    const summary = await runD1WebsiteAnalysisPipeline(database, CONFIG, 50, {
      storedAt: () => THIRD_STORED_AT,
      analysisRunOptions: {
        analyze: (facts, _config) => {
          seen.push(facts.evidenceId);
          return Promise.resolve(resultFor(facts));
        },
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
      analysisRunOptions: {
        analyze: () => Promise.reject(new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR")),
      },
    });
    assert.equal(first.failed, 1);
    assert.equal((await analysisRows(database)).length, 0);
    const seen: number[] = [];
    const second = await runD1WebsiteAnalysisPipeline(database, CONFIG, 1, {
      storedAt: () => FIRST_STORED_AT,
      analysisRunOptions: {
        analyze: (facts, _config) => {
          seen.push(facts.evidenceId);
          return Promise.resolve(resultFor(facts));
        },
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
      analysisRunOptions: { analyze: offlineAnalyze },
    });
    assert.equal(Object.isFrozen(summary), true);
    assert.equal(summary.persisted, 1);
  });
});

test("public pipeline exports are the barrel contract", () => {
  const sample: D1WebsiteAnalysisPipelineResult = {
    selected: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    persisted: 0,
  };
  const options: D1WebsiteAnalysisPipelineOptions = {};
  const code: D1WebsiteAnalysisPipelineErrorCode = "INVALID_REQUEST";
  const database: D1WebsiteAnalysisPipelineDatabase = {
    prepare() {
      throw new Error("unused");
    },
  };
  assert.equal(typeof runD1WebsiteAnalysisPipeline, "function");
  assert.equal(new D1WebsiteAnalysisPipelineError(code).code, "INVALID_REQUEST");
  assert.equal(sample.persisted, 0);
  assert.deepEqual(options, {});
  assert.equal(typeof database.prepare, "function");
});
