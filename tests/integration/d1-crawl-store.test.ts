import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Miniflare } from "miniflare";
import {
  persistD1CrawlEvidence,
  selectD1CrawlCandidates,
  type D1CrawlDatabase,
} from "../../src/crawler/d1-crawl-store";
import { CrawlEvidencePersistenceError } from "../../src/crawler/evidence-domain";
import { CrawlRunError } from "../../src/crawler/run-loop";
import { LeadPersistenceError } from "../../src/leads/errors";

const urlA = "https://example.com/a";
const urlB = "https://example.com/b";
const canonicalAttemptedAt = "2026-10-22T00:00:00.000Z";
const bodyText = "<p>a</p>";
const byteLength = Buffer.byteLength(bodyText, "utf8");

function leadId(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

async function withDatabase(use: (database: D1CrawlDatabase) => Promise<void>): Promise<void> {
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
    const migrationSql = readFileSync(
      join(process.cwd(), "migrations/0001_delta_qoralis_crawl.sql"),
      "utf8",
    );
    await database.exec(migrationSql);
    await use(database);
  } finally {
    await mf.dispose();
  }
}

async function insertLead(
  database: D1CrawlDatabase,
  values: readonly unknown[],
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO business_leads (
        id, business_name, source_kind, source_provider, source_reference,
        status, website_presence, website_url, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(...values)
    .run();
}

function manualLead(
  id: string,
  createdAt: string,
  status = "recorded",
  presence = "present",
  url: string | null = urlA,
  version = 1,
): readonly unknown[] {
  return [
    id,
    "Example Business",
    "manual",
    null,
    `ref-${id}`,
    status,
    presence,
    presence === "present" ? url : null,
    createdAt,
    createdAt,
    version,
  ];
}

async function insertEvidence(
  database: D1CrawlDatabase,
  lead: string,
  outcome: "fetched" | "failed",
  requestedUrl: string,
  failure: string | null,
): Promise<void> {
  const fetched = outcome === "fetched";
  await database
    .prepare(
      `INSERT INTO single_page_crawl_evidence (
        lead_id, lead_version, outcome, requested_url, attempted_at,
        final_url, status_code, content_type, body_text, byte_length,
        redirect_count, failure_code
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      lead,
      outcome,
      requestedUrl,
      canonicalAttemptedAt,
      fetched ? requestedUrl : null,
      fetched ? 200 : null,
      fetched ? "text/html" : null,
      fetched ? bodyText : null,
      fetched ? byteLength : null,
      fetched ? 0 : null,
      failure,
    )
    .run();
}

function fetchedInput(lead: string, requestedUrl = urlA) {
  return {
    outcome: "fetched" as const,
    leadId: lead,
    leadVersion: 1,
    requestedUrl,
    finalUrl: requestedUrl,
    statusCode: 200,
    contentType: "text/html" as const,
    bodyText,
    byteLength,
    redirectCount: 0,
    attemptedAt: canonicalAttemptedAt,
  };
}

function failedInput(lead: string, failure = "TIMEOUT", requestedUrl = urlA) {
  return {
    outcome: "failed" as const,
    leadId: lead,
    leadVersion: 1,
    requestedUrl,
    failure,
    attemptedAt: canonicalAttemptedAt,
  };
}

async function expectRejected(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("expected rejection");
}

test("creates only the crawl schema", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z"));
    await insertLead(database, [
      leadId("2"),
      "Discovered Example",
      "discovery",
      "fixture_directory",
      "ref-discovered",
      "recorded",
      "present",
      urlB,
      "2026-01-02T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      1,
    ]);
    const duplicate = await expectRejected(insertLead(database, [
      leadId("3"),
      "Discovered Example",
      "discovery",
      "fixture_directory",
      "ref-discovered",
      "recorded",
      "present",
      urlA,
      "2026-01-03T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
      1,
    ]));
    assert.equal(duplicate instanceof Error, true);

    assert.ok(await expectRejected(insertLead(database, [
      leadId("4"),
      "Bad Provider",
      "discovery",
      "Bad-Provider",
      "ref-bad",
      "recorded",
      "present",
      urlA,
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:00:00.000Z",
      1,
    ])));
    assert.ok(await expectRejected(insertLead(database, manualLead(
      leadId("5"),
      "2026-01-05T00:00:00.000Z",
      "recorded",
      "present",
      null,
    ))));
    assert.ok(await expectRejected(insertLead(database, [
      leadId("6"),
      "Example Business",
      "manual",
      null,
      "ref-unknown-url",
      "recorded",
      "unknown",
      urlA,
      "2026-01-06T00:00:00.000Z",
      "2026-01-06T00:00:00.000Z",
      1,
    ])));
    assert.ok(await expectRejected(insertLead(database, [
      leadId("16"),
      "Example Business",
      "manual",
      null,
      "ref-missing-url",
      "recorded",
      "missing",
      urlA,
      "2026-01-16T00:00:00.000Z",
      "2026-01-16T00:00:00.000Z",
      1,
    ])));

    assert.ok(await expectRejected(insertEvidence(database, leadId("9"), "fetched", urlA, null)));
    await insertEvidence(database, leadId("1"), "fetched", urlA, null);
    await insertEvidence(database, leadId("2"), "failed", urlB, "TIMEOUT");
    assert.ok(await expectRejected(insertEvidence(database, leadId("1"), "fetched", urlA, "TIMEOUT")));
    assert.ok(await expectRejected(insertEvidence(database, leadId("1"), "failed", urlA, "NOT_A_CODE")));
    assert.ok(await expectRejected(database.prepare(
      `INSERT INTO single_page_crawl_evidence (
        lead_id, lead_version, outcome, requested_url, attempted_at,
        final_url, status_code, content_type, body_text, byte_length,
        redirect_count, failure_code
      ) VALUES (?, 1, 'fetched', ?, ?, ?, 200, 'text/html', ?, 3, 0, NULL)`,
    ).bind(leadId("1"), urlA, canonicalAttemptedAt, urlA, "hi").run()));
    assert.ok(await expectRejected(database.prepare(
      `INSERT INTO single_page_crawl_evidence (
        lead_id, lead_version, outcome, requested_url, attempted_at,
        final_url, status_code, content_type, body_text, byte_length,
        redirect_count, failure_code
      ) VALUES (?, 1, 'fetched', ?, ?, ?, 200, 'text/html', ?, ?, 6, NULL)`,
    ).bind(leadId("1"), urlA, canonicalAttemptedAt, urlA, bodyText, byteLength).run()));
    assert.ok(await expectRejected(database.prepare(
      "INSERT INTO single_page_crawl_evidence (lead_id, lead_version, outcome, requested_url, attempted_at, failure_code) VALUES (?, 1, 'failed', ?, 'not-a-timestamp', 'TIMEOUT')",
    ).bind(leadId("2"), urlB).run()));
    assert.ok(await expectRejected(database.prepare(
      `INSERT INTO single_page_crawl_evidence (
        lead_id, lead_version, outcome, requested_url, attempted_at,
        final_url, status_code, content_type, body_text, byte_length,
        redirect_count, failure_code
      ) VALUES (?, 1, 'fetched', ?, ?, ?, 200, 'text/html', 'x', 1048577, 0, NULL)`,
    ).bind(leadId("1"), urlA, canonicalAttemptedAt, urlA).run()));

    const updated = await expectRejected(database.prepare(
      "UPDATE single_page_crawl_evidence SET failure_code = 'TIMEOUT'",
    ).run());
    assert.equal(updated instanceof Error, true);
    assert.equal(String((updated as Error).message).includes("single_page_crawl_evidence is append-only"), true);
    const deleted = await expectRejected(database.prepare(
      "DELETE FROM single_page_crawl_evidence",
    ).run());
    assert.equal(String((deleted as Error).message).includes("single_page_crawl_evidence is append-only"), true);

    const absent = await database.prepare(
      `SELECT name FROM sqlite_master
       WHERE name IN ('audit_events', 'lead_contact_suppressions', 'schema_migrations')`,
    ).all();
    assert.deepEqual(absent.results, []);
    const evidenceIndexes = await database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'single_page_crawl_evidence' AND name NOT LIKE 'sqlite_%'`,
    ).all();
    assert.deepEqual(evidenceIndexes.results, []);
  });
});

test("rejects malformed attempted_at values and accepts canonical UTC", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z"));
    await insertEvidence(database, leadId("1"), "failed", urlA, "CANCELLED");
    const cases = [
      "2026-10-22 00:00:00.000Z",
      "2026/10/22T00:00:00.000Z",
      "2026-10-22T00-00-00.000Z",
      "2026-10-22T00:00:00,000Z",
      "2026-10-22T00:00:00.000z",
      "2026-10-22T00:00:00.00Z",
      "2026-10-22T00:00:00.0000Z",
      "2026-13-22T00:00:00.000Z",
      "2026-10-22T24:01:00.000Z",
      "2026-10-22T00:60:00.000Z",
      "2026-10-22T00:00:60.000Z",
      "2026-10-22T00:00:00.000+00:00",
      "202A-10-22T00:00:00.000Z",
      "2026-02-31T00:00:00.000Z",
    ];
    for (const attemptedAt of cases) {
      const error = await expectRejected(database.prepare(
        `INSERT INTO single_page_crawl_evidence (
          lead_id, lead_version, outcome, requested_url, attempted_at, failure_code
        ) VALUES (?, 1, 'failed', ?, ?, 'TIMEOUT')`,
      ).bind(leadId("1"), urlA, attemptedAt).run());
      assert.equal(error instanceof Error, true, attemptedAt);
      assert.equal(String((error as Error).message).includes("CHECK constraint"), true, attemptedAt);
    }
  });
});

test("selects eligible crawl candidates in order", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("2"), "2026-01-02T00:00:00.000Z"));
    await insertLead(database, manualLead(leadId("3"), "2026-01-02T00:00:00.000Z", "reviewing", "present", "https://example.com/reviewing"));
    await insertLead(database, manualLead(leadId("1"), "2026-01-03T00:00:00.000Z", "recorded", "present", "https://example.com/later"));
    await insertLead(database, manualLead(leadId("4"), "2026-01-04T00:00:00.000Z", "archived"));
    await insertLead(database, manualLead(leadId("5"), "2026-01-05T00:00:00.000Z", "recorded", "unknown"));
    await insertLead(database, manualLead(leadId("6"), "2026-01-06T00:00:00.000Z", "recorded", "missing"));
    await insertLead(database, [
      leadId("7"),
      "Discovered Example",
      "discovery",
      "fixture_directory",
      "ref-discovery",
      "recorded",
      "present",
      "https://example.com/discovered",
      "2026-01-07T00:00:00.000Z",
      "2026-01-07T00:00:00.000Z",
      4,
    ]);
    await insertLead(database, manualLead(leadId("8"), "2026-01-08T00:00:00.000Z", "recorded", "present", "https://example.com/version", 7));

    const selected = await selectD1CrawlCandidates(database, 60);
    assert.deepEqual(selected.map((lead) => lead.id), [
      leadId("2"),
      leadId("3"),
      leadId("1"),
      leadId("7"),
      leadId("8"),
    ]);
    assert.equal(selected[1]?.status, "reviewing");
    assert.equal(selected[3]?.sourceKind, "discovery");
    assert.equal(selected[4]?.version, 7);
    assert.equal(Object.isFrozen(selected), true);

    const bounded = await selectD1CrawlCandidates(database, 2);
    assert.deepEqual(bounded.map((lead) => lead.id), [leadId("2"), leadId("3")]);

    await insertEvidence(database, leadId("2"), "fetched", urlA, null);
    await insertLead(database, manualLead(leadId("9"), "2026-01-09T00:00:00.000Z", "recorded", "present", "https://example.com/timeout"));
    await insertEvidence(database, leadId("9"), "failed", "https://example.com/timeout", "TIMEOUT");
    await insertLead(database, manualLead(leadId("10"), "2026-01-10T00:00:00.000Z", "recorded", "present", "https://example.com/http"));
    await insertEvidence(database, leadId("10"), "failed", "https://example.com/http", "HTTP_FAILURE");
    await insertLead(database, manualLead(leadId("11"), "2026-01-11T00:00:00.000Z", "recorded", "present", "https://example.com/cancelled"));
    await insertEvidence(database, leadId("11"), "failed", "https://example.com/cancelled", "CANCELLED");
    await insertLead(database, manualLead(leadId("12"), "2026-01-12T00:00:00.000Z", "recorded", "present", urlB));
    await insertEvidence(database, leadId("12"), "fetched", urlA, null);

    const afterEvidence = await selectD1CrawlCandidates(database, 60);
    assert.deepEqual(afterEvidence.map((lead) => lead.id), [
      leadId("3"),
      leadId("1"),
      leadId("7"),
      leadId("8"),
      leadId("11"),
      leadId("12"),
    ]);

    await database.prepare(
      "UPDATE business_leads SET website_url = ?, updated_at = ?, version = version + 1 WHERE id = ?",
    ).bind(urlB, "2026-02-01T00:00:00.000Z", leadId("2")).run();
    const changedUrl = await selectD1CrawlCandidates(database, 60);
    assert.equal(changedUrl.some((lead) => lead.id === leadId("2")), true);

    await insertEvidence(database, leadId("3"), "fetched", "https://example.com/reviewing", null);
    await database.prepare(
      "UPDATE business_leads SET status = 'reviewing', updated_at = ?, version = version + 1 WHERE id = ?",
    ).bind("2026-02-02T00:00:00.000Z", leadId("3")).run();
    const changedStatus = await selectD1CrawlCandidates(database, 60);
    assert.equal(changedStatus.some((lead) => lead.id === leadId("3")), false);
  });
});

test("maps candidate driver failures and leaves lead mapping visible", async () => {
  const driverText = "secret-driver SQLITE business_leads";
  const rejecting = stubDatabase({
    all: async () => {
      throw new Error(driverText);
    },
  });
  const selected = await expectRejected(selectD1CrawlCandidates(rejecting, 1));
  assert.ok(selected instanceof CrawlRunError);
  assert.equal(selected.code, "SELECTION_FAILED");
  assert.equal(selected.message, "Crawl candidate selection failed.");
  assert.equal(selected.cause, undefined);
  assert.equal(selected.message.includes("secret-driver"), false);
  assert.equal(selected.message.includes(driverText), false);

  const tooMany = stubDatabase({
    all: async () => ({ results: [{}, {}, {}] }),
  });
  const lengthError = await expectRejected(selectD1CrawlCandidates(tooMany, 1));
  assert.ok(lengthError instanceof CrawlRunError);
  assert.equal(lengthError.code, "SELECTION_FAILED");

  await withDatabase(async (database) => {
    await insertLead(database, [
      "not-a-uuid",
      "Example Business",
      "manual",
      null,
      "ref-bad-id",
      "recorded",
      "present",
      urlA,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      1,
    ]);
    const mapped = await expectRejected(selectD1CrawlCandidates(database, 1));
    assert.ok(mapped instanceof LeadPersistenceError);
    assert.equal(mapped instanceof CrawlRunError, false);
    assert.equal(mapped.message, "Lead persistence operation failed.");
  });
});

test("persists fetched and failed evidence and rejects unsafe writes", async () => {
  await withDatabase(async (database) => {
    const id = leadId("1");
    await insertLead(database, manualLead(id, "2026-01-01T00:00:00.000Z"));
    const fetched = await persistD1CrawlEvidence(database, fetchedInput(id));
    const failed = await persistD1CrawlEvidence(database, failedInput(id));
    assert.equal(fetched.id === failed.id, false);
    assert.equal(fetched.outcome, "fetched");
    assert.equal(failed.outcome, "failed");
    if (failed.outcome === "failed") {
      assert.equal(failed.failure, "TIMEOUT");
    }
    const fetchedRow = await database.prepare(
      "SELECT id FROM single_page_crawl_evidence WHERE id = ?",
    ).bind(fetched.id).first();
    const failedRow = await database.prepare(
      "SELECT id FROM single_page_crawl_evidence WHERE id = ?",
    ).bind(failed.id).first();
    assert.equal(fetchedRow?.id, fetched.id);
    assert.equal(failedRow?.id, failed.id);
    assert.equal(Object.isFrozen(fetched), true);
    assert.equal(Object.isFrozen(failed), true);

    const missing = await expectRejected(persistD1CrawlEvidence(database, fetchedInput(leadId("9"))));
    assert.ok(missing instanceof CrawlEvidencePersistenceError);
    assert.equal(missing.code, "LEAD_NOT_FOUND");
    assert.equal(missing.message, "Business lead was not found.");
    const count = await database.prepare(
      "SELECT COUNT(*) AS total FROM single_page_crawl_evidence",
    ).first();
    assert.equal(count?.total, 2);

    const updated = await expectRejected(database.prepare(
      "UPDATE single_page_crawl_evidence SET body_text = 'changed'",
    ).run());
    assert.equal(String((updated as Error).message).includes("single_page_crawl_evidence is append-only"), true);
    const deleted = await expectRejected(database.prepare(
      "DELETE FROM single_page_crawl_evidence",
    ).run());
    assert.equal(String((deleted as Error).message).includes("single_page_crawl_evidence is append-only"), true);
  });
});

test("keeps evidence validation and driver failures on their own errors", async () => {
  let prepares = 0;
  const closed: D1CrawlDatabase = {
    prepare() {
      prepares += 1;
      throw new Error("prepared");
    },
  };
  const invalid = await expectRejected(persistD1CrawlEvidence(closed, { outcome: "fetched" }));
  assert.ok(invalid instanceof CrawlEvidencePersistenceError);
  assert.equal(invalid.code, "INVALID_EVIDENCE");
  assert.equal(invalid.message, "Crawl evidence is invalid.");
  assert.equal(prepares, 0);

  const driverText = "secret-driver FOREIGN KEY constraint failed";
  const firstRejected = stubDatabase({
    first: async () => {
      throw new Error(driverText);
    },
  });
  const firstError = await expectRejected(persistD1CrawlEvidence(firstRejected, failedInput(leadId("1"))));
  assert.ok(firstError instanceof CrawlEvidencePersistenceError);
  assert.equal(firstError.code, "PERSISTENCE_FAILED");
  assert.equal(firstError.message, "Crawl evidence persistence failed.");
  assert.equal(firstError.cause, undefined);
  assert.equal(firstError.message.includes("secret-driver"), false);
  assert.equal(firstError.message.includes("FOREIGN KEY"), false);

  const runRejected = stubDatabase({
    first: async () => ({ present: 1 }),
    run: async () => {
      throw new Error(driverText);
    },
  });
  const runError = await expectRejected(persistD1CrawlEvidence(runRejected, failedInput(leadId("1"))));
  assert.ok(runError instanceof CrawlEvidencePersistenceError);
  assert.equal(runError.code, "PERSISTENCE_FAILED");
  assert.equal(runError.message.includes(driverText), false);

  const badChanges = stubDatabase({
    first: async () => ({ present: 1 }),
    run: async () => ({ meta: { changes: 0, last_row_id: 1 } }),
  });
  const changesError = await expectRejected(persistD1CrawlEvidence(badChanges, failedInput(leadId("1"))));
  assert.ok(changesError instanceof CrawlEvidencePersistenceError);
  assert.equal(changesError.code, "PERSISTENCE_FAILED");

  const badRowId = stubDatabase({
    first: async () => ({ present: 1 }),
    run: async () => ({ meta: { changes: 1, last_row_id: 1n as unknown as number } }),
  });
  const rowIdError = await expectRejected(persistD1CrawlEvidence(badRowId, failedInput(leadId("1"))));
  assert.ok(rowIdError instanceof CrawlEvidencePersistenceError);
  assert.equal(rowIdError.code, "PERSISTENCE_FAILED");

  await withDatabase(async (database) => {
    const lying: D1CrawlDatabase = {
      prepare(sql: string) {
        const statement = database.prepare(sql);
        const wrapped = {
          bind(...values: readonly unknown[]) {
            const bound = statement.bind(...values);
            return {
              bind: wrapped.bind,
              all: () => bound.all(),
              first: async () => sql.startsWith("SELECT 1 AS present") ? { present: 1 } : bound.first(),
              run: () => bound.run(),
            };
          },
          all: () => statement.all(),
          first: () => statement.first(),
          run: () => statement.run(),
        };
        return wrapped;
      },
    };
    const foreignKey = await expectRejected(persistD1CrawlEvidence(lying, failedInput(leadId("404"))));
    assert.ok(foreignKey instanceof CrawlEvidencePersistenceError);
    assert.equal(foreignKey.code, "PERSISTENCE_FAILED");
    assert.equal(foreignKey.message, "Crawl evidence persistence failed.");
    assert.equal(foreignKey.message.includes("FOREIGN KEY"), false);
    assert.equal(foreignKey.message.includes(leadId("404")), false);
  });
});

function stubDatabase(methods: {
  readonly all?: () => Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  readonly first?: () => Promise<Record<string, unknown> | null>;
  readonly run?: () => Promise<{ readonly meta: { readonly changes: number; readonly last_row_id: number } }>;
}): D1CrawlDatabase {
  const statement = {
    bind() {
      return statement;
    },
    all: methods.all ?? (async () => ({ results: [] })),
    first: methods.first ?? (async () => null),
    run: methods.run ?? (async () => ({ meta: { changes: 1, last_row_id: 1 } })),
  };
  return {
    prepare() {
      return statement;
    },
  };
}
