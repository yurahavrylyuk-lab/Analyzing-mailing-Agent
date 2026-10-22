import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Miniflare } from "miniflare";
import { handleCrawlGatewayRequest } from "../../src/crawl-gateway/worker";
import type { D1CrawlDatabase } from "../../src/crawler/d1-crawl-store";

const TOKEN = "gateway-token-do-not-reflect";
const urlA = "https://example.com/a";
const urlB = "https://example.com/b";
const canonicalAttemptedAt = "2026-10-22T00:00:00.000Z";
const bodyText = "<p>html-sentinel</p>";
const byteLength = Buffer.byteLength(bodyText, "utf8");

type CrawlDatabase = D1CrawlDatabase & {
  exec(sql: string): Promise<unknown>;
};

function leadId(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

async function withDatabase(use: (database: CrawlDatabase) => Promise<void>): Promise<void> {
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
  url: string,
  version = 1,
): readonly unknown[] {
  return [
    id,
    "Example Business",
    "manual",
    null,
    `ref-${id}`,
    "recorded",
    "present",
    url,
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

function fetchedInput(lead: string, requestedUrl: string) {
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

function failedInput(lead: string, requestedUrl: string) {
  return {
    outcome: "failed" as const,
    leadId: lead,
    leadVersion: 1,
    requestedUrl,
    failure: "TIMEOUT" as const,
    attemptedAt: canonicalAttemptedAt,
  };
}

async function post(
  database: D1CrawlDatabase,
  path: string,
  body: unknown,
): Promise<Response> {
  return handleCrawlGatewayRequest(
    new Request(`https://gateway.example${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    }),
    { DB: database, CRAWL_GATEWAY_TOKEN: TOKEN },
  );
}

async function selectCandidates(
  database: D1CrawlDatabase,
  maxAttempts: number,
): Promise<readonly Record<string, unknown>[]> {
  const response = await post(database, "/internal/crawl/select", { maxAttempts });
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    assert.fail("expected candidate object");
  }
  const candidates = Reflect.get(payload, "candidates");
  if (!Array.isArray(candidates)) {
    assert.fail("expected candidate array");
  }
  return candidates as readonly Record<string, unknown>[];
}

function observationUrl(candidate: Record<string, unknown>): unknown {
  const observation = candidate.websiteObservation;
  if (typeof observation !== "object" || observation === null) {
    return undefined;
  }
  return Reflect.get(observation, "url");
}

test("migration applies through the handler", async () => {
  await withDatabase(async (database) => {
    const response = await post(database, "/internal/crawl/select", { maxAttempts: 10 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { candidates: [] });
  });
});

test("select returns eligible leads in created_at id order", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", urlA));
    await insertLead(database, manualLead(leadId("2"), "2026-01-02T00:00:00.000Z", urlB));

    const candidates = await selectCandidates(database, 10);
    assert.deepEqual(
      candidates.map((candidate) => candidate.id),
      [leadId("1"), leadId("2")],
    );
    assert.equal(candidates[0]?.businessName, "Example Business");
    assert.equal(candidates[0]?.sourceReference, `ref-${leadId("1")}`);
    assert.equal(observationUrl(candidates[0] ?? {}), urlA);
    assert.equal(candidates[0]?.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(candidates[0]?.version, 1);
    assert.equal(candidates[1]?.businessName, "Example Business");
    assert.equal(candidates[1]?.sourceReference, `ref-${leadId("2")}`);
    assert.equal(observationUrl(candidates[1] ?? {}), urlB);
    assert.equal(candidates[1]?.createdAt, "2026-01-02T00:00:00.000Z");
    assert.equal(candidates[1]?.version, 1);
  });
});

test("select respects maxAttempts", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", urlA));
    await insertLead(database, manualLead(leadId("2"), "2026-01-02T00:00:00.000Z", urlB));
    await insertLead(
      database,
      manualLead(leadId("3"), "2026-01-03T00:00:00.000Z", "https://example.com/c"),
    );

    const candidates = await selectCandidates(database, 2);
    assert.deepEqual(
      candidates.map((candidate) => candidate.id),
      [leadId("1"), leadId("2")],
    );
  });
});

test("fetched evidence blocks the same URL", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", urlA));
    await insertLead(database, manualLead(leadId("2"), "2026-01-02T00:00:00.000Z", urlB));
    await insertEvidence(database, leadId("1"), "fetched", urlA, null);

    const candidates = await selectCandidates(database, 10);
    assert.equal(candidates.some((candidate) => candidate.id === leadId("1")), false);
  });
});

test("non-CANCELLED failure blocks the same URL", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", urlA));
    await insertEvidence(database, leadId("1"), "failed", urlA, "TIMEOUT");

    const candidates = await selectCandidates(database, 10);
    assert.equal(candidates.some((candidate) => candidate.id === leadId("1")), false);
  });
});

test("CANCELLED-only evidence stays eligible and a changed URL is eligible", async () => {
  await withDatabase(async (database) => {
    const cancelledUrl = "https://example.com/cancelled";
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", cancelledUrl));
    await insertLead(database, manualLead(leadId("2"), "2026-01-02T00:00:00.000Z", urlA));
    await insertEvidence(database, leadId("1"), "failed", cancelledUrl, "CANCELLED");
    await insertEvidence(database, leadId("2"), "fetched", urlA, null);

    const before = await selectCandidates(database, 10);
    assert.equal(before.some((candidate) => candidate.id === leadId("1")), true);
    assert.equal(before.some((candidate) => candidate.id === leadId("2")), false);

    await database
      .prepare('UPDATE business_leads SET website_url = "https://example.com/changed" WHERE id = ?')
      .bind(leadId("2"))
      .run();

    const after = await selectCandidates(database, 10);
    const changed = after.find((candidate) => candidate.id === leadId("2"));
    assert.ok(changed);
    assert.equal(observationUrl(changed), "https://example.com/changed");
  });
});

test("evidence route writes fetched and failed rows", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", urlA));
    await insertLead(database, manualLead(leadId("2"), "2026-01-02T00:00:00.000Z", urlB));

    const fetched = await post(database, "/internal/crawl/evidence", fetchedInput(leadId("1"), urlA));
    const failed = await post(database, "/internal/crawl/evidence", failedInput(leadId("2"), urlB));
    const fetchedText = await fetched.text();
    const failedText = await failed.text();

    assert.equal(fetched.status, 200);
    assert.equal(fetchedText, '{"persisted":true}');
    assert.equal(failed.status, 200);
    assert.equal(failedText, '{"persisted":true}');
    assert.equal(fetchedText.includes("body_text"), false);
    assert.equal(failedText.includes("body_text"), false);
    assert.equal(fetchedText.includes(bodyText), false);

    const stored = await database
      .prepare("SELECT outcome, failure_code, body_text FROM single_page_crawl_evidence")
      .all();
    const outcomes = stored.results.map((row) => row.outcome);
    assert.deepEqual(outcomes.sort(), ["failed", "fetched"]);
  });
});

test("append-only triggers still reject update and delete", async () => {
  await withDatabase(async (database) => {
    await insertLead(database, manualLead(leadId("1"), "2026-01-01T00:00:00.000Z", urlA));
    const written = await post(database, "/internal/crawl/evidence", fetchedInput(leadId("1"), urlA));
    assert.equal(await written.text(), '{"persisted":true}');

    await assert.rejects(
      database.prepare("UPDATE single_page_crawl_evidence SET outcome = outcome").run(),
    );
    await assert.rejects(database.prepare("DELETE FROM single_page_crawl_evidence").run());
  });
});
