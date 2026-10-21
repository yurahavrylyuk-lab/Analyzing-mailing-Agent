import { strict as assert } from "node:assert";
import { test } from "node:test";

import { auditMigrations } from "../../src/audit";
import { DoNotContactService, complianceMigrations } from "../../src/compliance";
import { SinglePageCrawlEvidenceService, crawlerMigrations } from "../../src/crawler";
import {
  CrawlRunError,
  runBoundedSinglePageCrawlWithDependencies,
  type SinglePageCrawlRunResult,
} from "../../src/crawler/run";
import type { CrawlEvidenceFailureCode } from "../../src/crawler/single-page-evidence";
import { applyMigrations, createDatabase, type Database, type Migration } from "../../src/db";
import {
  LeadPersistenceError,
  LeadService,
  leadMigrations,
  type BusinessLead,
  type WebsiteObservation,
} from "../../src/leads";

const actor = { type: "human" as const, id: "reviewer" };
const urlA = "https://example.com/a";
const urlB = "https://example.com/b";
const attemptedAt = "2026-10-21T12:00:00.000Z";
const bodyText = "<p>a</p>";

function leadMigrationsOnly(): readonly Migration[] {
  return [...leadMigrations, ...auditMigrations, ...complianceMigrations];
}

function fullMigrations(): readonly Migration[] {
  return [...leadMigrationsOnly(), ...crawlerMigrations];
}

function openDatabase(includeCrawlEvidence = true): Database {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, includeCrawlEvidence ? fullMigrations() : leadMigrationsOnly());
  return database;
}

function leadId(suffix: string): string {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}

function presentUrl(lead: BusinessLead): string {
  const observation = lead.websiteObservation;
  if (observation.presence !== "present") {
    throw new Error("Expected a present website.");
  }
  return observation.url;
}

function manualLead(
  database: Database,
  id: string,
  time: string,
  observation: WebsiteObservation,
  reference = `ref-${id}`,
): BusinessLead {
  return new LeadService(database, {
    idGenerator: () => id,
    clock: () => new Date(time),
  }).createLead(
    {
      businessName: "Example Business",
      sourceKind: "manual",
      sourceReference: reference,
      websiteObservation: observation,
    },
    actor,
  );
}

function discoveredLead(
  database: Database,
  id: string,
  time: string,
  url: string,
): BusinessLead {
  const result = new LeadService(database, {
    idGenerator: () => id,
    clock: () => new Date(time),
  }).recordDiscoveredLead(
    {
      provider: "fixture_directory",
      providerReference: `ref-${id}`,
      businessName: "Discovered Example",
      websiteObservation: { presence: "present", url },
    },
    actor,
  );
  assert.equal(result.created, true);
  return result.lead;
}

function transition(
  database: Database,
  lead: BusinessLead,
  status: "reviewing" | "archived",
  time: string,
): BusinessLead {
  return new LeadService(database, {
    clock: () => new Date(time),
  }).transitionLead(lead.id, status, lead.version, actor);
}

function seedFetched(database: Database, lead: BusinessLead, url = presentUrl(lead)): void {
  new SinglePageCrawlEvidenceService(database).persist({
    outcome: "fetched",
    leadId: lead.id,
    leadVersion: lead.version,
    requestedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: "text/html",
    bodyText,
    byteLength: Buffer.byteLength(bodyText, "utf8"),
    redirectCount: 0,
    attemptedAt,
  });
}

function seedFailed(
  database: Database,
  lead: BusinessLead,
  failure: CrawlEvidenceFailureCode,
  url = presentUrl(lead),
): void {
  new SinglePageCrawlEvidenceService(database).persist({
    outcome: "failed",
    leadId: lead.id,
    leadVersion: lead.version,
    requestedUrl: url,
    failure,
    attemptedAt,
  });
}

async function crawl(
  database: Database,
  maxAttempts = 60,
): Promise<{ leads: BusinessLead[]; result: SinglePageCrawlRunResult }> {
  const leads: BusinessLead[] = [];
  const result = await runBoundedSinglePageCrawlWithDependencies(
    database,
    { maxAttempts, signal: new AbortController().signal },
    {
      collect: async (lead) => {
        leads.push(lead);
        return {
          outcome: "failed",
          leadId: lead.id,
          leadVersion: lead.version,
          requestedUrl: presentUrl(lead),
          failure: "TIMEOUT",
          attemptedAt,
        };
      },
      persist: (evidence) => {
        if (evidence.outcome === "fetched") {
          return Object.freeze({ ...evidence, id: leads.length });
        }
        return Object.freeze({ ...evidence, id: leads.length });
      },
    },
  );
  return { leads, result };
}

function assertSelectionFailed(error: unknown): boolean {
  assert.ok(error instanceof CrawlRunError);
  assert.equal(error.code, "SELECTION_FAILED");
  assert.equal(error.name, "CrawlRunError");
  assert.equal(error.message, "Crawl candidate selection failed.");
  assert.equal(error.cause, undefined);
  for (const hidden of [
    "select id",
    "from business_leads",
    "business_leads",
    "no such table",
    "sqlite",
    "not open",
    urlA,
  ]) {
    assert.equal(error.message.toLowerCase().includes(hidden), false, hidden);
  }
  return true;
}

test("selects recorded and reviewing leads with a present website", async () => {
  const database = openDatabase();
  try {
    const recorded = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    const reviewing = transition(
      database,
      manualLead(
        database,
        leadId("2"),
        "2026-01-02T00:00:00.000Z",
        { presence: "present", url: "https://example.com/reviewing" },
      ),
      "reviewing",
      "2026-01-03T00:00:00.000Z",
    );
    const { leads, result } = await crawl(database);
    assert.deepEqual(leads.map((lead) => lead.id), [recorded.id, reviewing.id]);
    assert.equal(reviewing.status, "reviewing");
    assert.equal(leads[1]?.status, "reviewing");
    assert.equal(result.summary.selected, 2);
    assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  } finally {
    database.close();
  }
});

test("excludes archived, unknown, and missing leads", async () => {
  const database = openDatabase();
  try {
    const eligible = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    transition(
      database,
      manualLead(
        database,
        leadId("2"),
        "2026-01-02T00:00:00.000Z",
        { presence: "present", url: "https://example.com/archived" },
      ),
      "archived",
      "2026-01-03T00:00:00.000Z",
    );
    manualLead(database, leadId("3"), "2026-01-04T00:00:00.000Z", { presence: "unknown" });
    manualLead(database, leadId("4"), "2026-01-05T00:00:00.000Z", { presence: "missing" });
    const { leads, result } = await crawl(database);
    assert.deepEqual(leads.map((lead) => lead.id), [eligible.id]);
    assert.equal(result.summary.selected, 1);
  } finally {
    database.close();
  }
});

test("selects manual and discovered present leads", async () => {
  const database = openDatabase();
  try {
    const manual = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    const discovered = discoveredLead(
      database,
      leadId("2"),
      "2026-01-02T00:00:00.000Z",
      "https://example.com/discovered",
    );
    assert.equal(manual.sourceKind, "manual");
    assert.equal(discovered.sourceKind, "discovery");
    if (discovered.sourceKind === "discovery") {
      assert.equal(discovered.sourceProvider, "fixture_directory");
    }
    const { leads } = await crawl(database);
    assert.deepEqual(leads.map((lead) => lead.id), [manual.id, discovered.id]);
    assert.deepEqual(leads.map((lead) => lead.sourceKind), ["manual", "discovery"]);
  } finally {
    database.close();
  }
});

test("selects a suppressed present lead", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    const suppression = new DoNotContactService(database, {
      clock: () => new Date("2026-02-01T00:00:00.000Z"),
    }).applySuppression(lead.id, "manual", actor);
    assert.equal(suppression.changed, true);
    const { leads, result } = await crawl(database);
    assert.deepEqual(leads.map((selected) => selected.id), [lead.id]);
    assert.equal(result.summary.selected, 1);
  } finally {
    database.close();
  }
});

test("orders candidates by created_at and then id", async () => {
  const database = openDatabase();
  try {
    const early = manualLead(
      database,
      leadId("3"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: "https://example.com/early" },
    );
    const low = manualLead(
      database,
      leadId("1"),
      "2026-01-02T00:00:00.000Z",
      { presence: "present", url: "https://example.com/low" },
    );
    const high = manualLead(
      database,
      leadId("2"),
      "2026-01-02T00:00:00.000Z",
      { presence: "present", url: "https://example.com/high" },
    );
    const { leads, result } = await crawl(database);
    assert.deepEqual(leads.map((lead) => lead.id), [early.id, low.id, high.id]);
    assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  } finally {
    database.close();
  }
});

test("returns only the bounded prefix of eligible leads", async () => {
  const database = openDatabase();
  try {
    const early = manualLead(
      database,
      leadId("3"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: "https://example.com/early" },
    );
    const low = manualLead(
      database,
      leadId("1"),
      "2026-01-02T00:00:00.000Z",
      { presence: "present", url: "https://example.com/low" },
    );
    manualLead(
      database,
      leadId("2"),
      "2026-01-02T00:00:00.000Z",
      { presence: "present", url: "https://example.com/high" },
    );
    const { leads, result } = await crawl(database, 2);
    assert.deepEqual(leads.map((lead) => lead.id), [early.id, low.id]);
    assert.equal(result.summary.selected, 2);
    assert.equal(result.summary.attempted, 2);
    assert.equal(result.summary.persisted, 2);
    assert.deepEqual(result.stop, { status: "completed", reason: "budget_exhausted" });
  } finally {
    database.close();
  }
});

test("blocks a fetched attempt for the same website url", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    seedFetched(database, lead);
    const { leads, result } = await crawl(database);
    assert.deepEqual(leads, []);
    assert.equal(result.summary.selected, 0);
    assert.deepEqual(result.stop, { status: "completed", reason: "candidates_exhausted" });
  } finally {
    database.close();
  }
});

test("blocks a timeout for the same website url", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    seedFailed(database, lead, "TIMEOUT");
    const { leads } = await crawl(database);
    assert.deepEqual(leads, []);
  } finally {
    database.close();
  }
});

test("blocks another non-cancelled failure for the same website url", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    seedFailed(database, lead, "HTTP_FAILURE");
    const { leads } = await crawl(database);
    assert.deepEqual(leads, []);
  } finally {
    database.close();
  }
});

test("does not block a lead whose only attempt is cancelled", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    seedFailed(database, lead, "CANCELLED");
    seedFailed(database, lead, "CANCELLED");
    const { leads } = await crawl(database);
    assert.deepEqual(leads.map((selected) => selected.id), [lead.id]);
    assert.equal(presentUrl(leads[0] as BusinessLead), urlA);
  } finally {
    database.close();
  }
});

test("selects a lead again when the current website url has no finished attempt", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    seedFetched(database, lead, urlA);
    const updated = new LeadService(database, {
      clock: () => new Date("2026-08-01T00:00:00.000Z"),
    }).setWebsiteObservation(
      lead.id,
      { presence: "present", url: urlB },
      lead.version,
      actor,
    );
    const { leads } = await crawl(database);
    assert.equal(updated.version, lead.version + 1);
    assert.deepEqual(leads.map((selected) => selected.id), [lead.id]);
    assert.equal(leads[0]?.version, updated.version);
    assert.equal(presentUrl(leads[0] as BusinessLead), urlB);
  } finally {
    database.close();
  }
});

test("keeps the same website url blocked after a status and version change", async () => {
  const database = openDatabase();
  try {
    const lead = manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    seedFetched(database, lead);
    const updated = transition(database, lead, "reviewing", "2026-03-01T00:00:00.000Z");
    assert.equal(updated.status, "reviewing");
    assert.equal(updated.version, lead.version + 1);
    assert.equal(presentUrl(updated), urlA);
    const { leads } = await crawl(database);
    assert.deepEqual(leads, []);
  } finally {
    database.close();
  }
});

test("maps a closed database to a fixed selection failure", async () => {
  const database = openDatabase();
  manualLead(
    database,
    leadId("1"),
    "2026-01-01T00:00:00.000Z",
    { presence: "present", url: urlA },
  );
  database.close();
  await assert.rejects(() => crawl(database), assertSelectionFailed);
});

test("maps a missing evidence table to a fixed selection failure", async () => {
  const database = openDatabase(false);
  try {
    manualLead(
      database,
      leadId("1"),
      "2026-01-01T00:00:00.000Z",
      { presence: "present", url: urlA },
    );
    await assert.rejects(() => crawl(database), assertSelectionFailed);
  } finally {
    database.close();
  }
});

test("propagates a corrupted lead mapping without hiding it as selection failure", async () => {
  const database = openDatabase();
  try {
    database.run(
      `INSERT INTO business_leads (
        id, business_name, source_kind, source_provider, source_reference,
        status, website_presence, website_url, created_at, updated_at, version
      ) VALUES (?, ?, 'manual', NULL, ?, 'recorded', 'present', ?, ?, ?, 1)`,
      [
        leadId("9"),
        "Example Business",
        "corrupt-ref",
        "https://user:pass@example.com/a",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );
    await assert.rejects(
      () => crawl(database),
      (error: unknown) => {
        assert.ok(error instanceof LeadPersistenceError);
        assert.equal(error instanceof CrawlRunError, false);
        assert.equal(error.message, "Lead persistence operation failed.");
        assert.equal(error.message.includes("user:pass"), false);
        assert.equal(error.message.includes("example.com"), false);
        return true;
      },
    );
  } finally {
    database.close();
  }
});
