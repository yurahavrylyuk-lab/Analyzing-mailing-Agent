import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { auditMigrations } from "../../src/audit";
import { DoNotContactService, complianceMigrations } from "../../src/compliance";
import {
  CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES,
  CrawlEvidencePersistenceError,
  SinglePageCrawlEvidenceService,
  crawlerMigrations,
  singlePageCrawlEvidenceMigration,
} from "../../src/crawler";
import { MAX_CRAWL_BODY_BYTES } from "../../src/crawler/domain";
import { applyMigrations, createDatabase, type Database, type Migration, type RunResult } from "../../src/db";
import { LeadService, businessLeadsMigration, leadMigrations, type CreateLeadInput } from "../../src/leads";

const leadId = "00000000-0000-4000-8000-000000000001";
const missingLeadId = "00000000-0000-4000-8000-000000000099";
const attemptedAt = "2026-10-21T12:00:00.000Z";
const urlA = "https://example.com/a";
const urlB = "https://example.com/b";
const actor = { type: "human" as const, id: "reviewer" };
const prerequisitesMessage = "Single-page crawl evidence migration prerequisites are unavailable.";
const foreignKeyMessage = "Single-page crawl evidence migration foreign-key validation failed.";
const migrationId = "022-single-page-crawl-evidence";

const evidenceColumns = [
  "id",
  "lead_id",
  "lead_version",
  "outcome",
  "requested_url",
  "attempted_at",
  "final_url",
  "status_code",
  "content_type",
  "body_text",
  "byte_length",
  "redirect_count",
  "failure_code",
];

const baseLead: CreateLeadInput = {
  businessName: "Example Business",
  sourceKind: "manual",
  sourceReference: "manual-entry",
  websiteObservation: { presence: "present", url: urlA },
};

function currentLeadMigrations(): readonly Migration[] {
  return [...leadMigrations, ...auditMigrations, ...complianceMigrations];
}

function openDatabase(): Database {
  return createDatabase({ url: "file::memory:" });
}

function applyCurrentLeadSchema(database: Database): void {
  applyMigrations(database, currentLeadMigrations());
}

function applyEvidenceSchema(database: Database): string[] {
  return applyMigrations(database, [...currentLeadMigrations(), ...crawlerMigrations]);
}

function assertNotMigrated(database: Database): void {
  assert.equal(
    database.get("SELECT id FROM schema_migrations WHERE id = ?", [migrationId]),
    undefined,
  );
  assert.equal(
    database.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'single_page_crawl_evidence'",
    ),
    undefined,
  );
}

function assertFixedError(error: unknown, message: string): boolean {
  return (
    error instanceof Error &&
    !(error instanceof CrawlEvidencePersistenceError) &&
    error.message === message
  );
}

function evidenceCount(database: Database): number {
  return database.get<{ count: number }>(
    "SELECT count(*) AS count FROM single_page_crawl_evidence",
  )?.count ?? 0;
}

function auditCount(database: Database): number {
  return database.get<{ count: number }>("SELECT count(*) AS count FROM audit_events")?.count ?? 0;
}

function leadRow(database: Database, id: string): unknown {
  return database.get(
    `SELECT id, business_name, source_kind, source_provider, source_reference, status,
            website_presence, website_url, created_at, updated_at, version
     FROM business_leads WHERE id = ?`,
    [id],
  );
}

function userObjects(database: Database): unknown[] {
  return database.all(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  );
}

function openServices(): {
  database: Database;
  leads: LeadService;
  evidence: SinglePageCrawlEvidenceService;
} {
  const database = openDatabase();
  applyEvidenceSchema(database);
  return {
    database,
    leads: new LeadService(database, {
      idGenerator: () => leadId,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    }),
    evidence: new SinglePageCrawlEvidenceService(database),
  };
}

function fetched(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const bodyText = "<p>héllo</p>";
  return {
    outcome: "fetched",
    leadId,
    leadVersion: 1,
    requestedUrl: urlA,
    finalUrl: "https://example.com/final",
    statusCode: 200,
    contentType: "text/html",
    bodyText,
    byteLength: Buffer.byteLength(bodyText, "utf8"),
    redirectCount: 0,
    attemptedAt,
    ...overrides,
  };
}

function failed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: "failed",
    leadId,
    leadVersion: 1,
    requestedUrl: "http://127.0.0.1/historical",
    failure: "BLOCKED_ADDRESS",
    attemptedAt,
    ...overrides,
  };
}

function assertPersistence(
  error: unknown,
  code: "INVALID_EVIDENCE" | "LEAD_NOT_FOUND" | "PERSISTENCE_FAILED",
  absent: readonly string[] = [],
): boolean {
  if (!(error instanceof CrawlEvidencePersistenceError) || error.code !== code) {
    return false;
  }
  const messages = {
    INVALID_EVIDENCE: "Crawl evidence is invalid.",
    LEAD_NOT_FOUND: "Business lead was not found.",
    PERSISTENCE_FAILED: "Crawl evidence persistence failed.",
  } as const;
  return error.message === messages[code] && absent.every((value) => !error.message.includes(value));
}

class ProgrammingErrorDatabase implements Database {
  exec(): void {
    throw new TypeError("programming-marker");
  }

  run(): RunResult {
    throw new TypeError("programming-marker");
  }

  get<T>(): T | undefined {
    throw new TypeError("programming-marker");
  }

  all<T>(): T[] {
    throw new TypeError("programming-marker");
  }

  transaction<T>(operation: () => T): T {
    return operation();
  }

  close(): void {}
}

class TouchDatabase implements Database {
  exec(): void {
    throw new Error("database touched");
  }

  run(): RunResult {
    throw new Error("database touched");
  }

  get<T>(): T | undefined {
    throw new Error("database touched");
  }

  all<T>(): T[] {
    throw new Error("database touched");
  }

  transaction<T>(_operation: () => T): T {
    throw new Error("database touched");
  }

  close(): void {}
}

test("crawlerMigrations is frozen and contains only the evidence migration", () => {
  assert.equal(Object.isFrozen(crawlerMigrations), true);
  assert.deepEqual([...crawlerMigrations], [singlePageCrawlEvidenceMigration]);
  assert.equal(singlePageCrawlEvidenceMigration.id, migrationId);
  assert.throws(() => {
    (crawlerMigrations as unknown as string[]).push("extra");
  });
});

test("discovery composition does not apply crawler migrations", () => {
  const root = process.cwd();
  const command = readFileSync(join(root, "src/discovery/command.ts"), "utf8");
  const runner = readFileSync(join(root, "scripts/run-discovery.cjs"), "utf8");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: {
      "crawl:cloud": string;
      discover: string;
      test: string;
      typecheck: string;
    };
  };
  assert.equal(command.includes("crawlerMigrations"), false);
  assert.equal(command.includes("singlePageCrawlEvidenceMigration"), false);
  assert.equal(command.includes("022-single-page-crawl-evidence"), false);
  assert.equal(runner.includes("crawlerMigrations"), false);
  assert.equal(manifest.scripts.discover.includes("crawl"), false);
  assert.equal(manifest.scripts["crawl:cloud"], "node scripts/run-crawl-cloud.cjs");
  assert.deepEqual(Object.keys(manifest.scripts).sort(), [
    "crawl:cloud",
    "discover",
    "test",
    "typecheck",
  ]);

  const index = readFileSync(join(root, "src/crawler/index.ts"), "utf8");
  assert.equal(index.includes("normalizeSinglePageCrawlEvidence"), false);
  assert.equal(index.includes("DatabaseCrawlEvidenceRepository"), false);
  assert.equal(index.includes("CrawlEvidenceRepository"), false);
  const service = readFileSync(join(root, "src/crawler/evidence-service.ts"), "utf8");
  const repository = readFileSync(join(root, "src/crawler/database-evidence-repository.ts"), "utf8");
  const migration = readFileSync(join(root, "src/crawler/migration.ts"), "utf8");
  for (const source of [service, repository, migration]) {
    assert.equal(source.includes("collectSinglePageCrawlEvidence"), false);
    assert.equal(source.includes("fetchCrawlPage"), false);
    assert.equal(source.includes("better-sqlite3"), false);
  }
  assert.equal(migration.includes("applyMigrations"), false);
  assert.equal(migration.includes("leadMigrations"), false);
});

test("migration 022 accepts the current lead schema once and creates append-only storage", () => {
  const database = openDatabase();
  try {
    applyCurrentLeadSchema(database);
    const before = userObjects(database);
    assert.deepEqual(applyMigrations(database, crawlerMigrations), [migrationId]);
    assert.deepEqual(applyMigrations(database, crawlerMigrations), []);
    const after = userObjects(database);
    const added = after.filter((row) => !before.some((existing) => JSON.stringify(existing) === JSON.stringify(row)));
    assert.deepEqual(
      before.filter((row) => !after.some((existing) => JSON.stringify(existing) === JSON.stringify(row))),
      [],
    );
    assert.deepEqual(
      (added as Array<{ type: string; name: string }>).map((row) => `${row.type}:${row.name}`).sort(),
      [
        "table:single_page_crawl_evidence",
        "trigger:single_page_crawl_evidence_prevent_delete",
        "trigger:single_page_crawl_evidence_prevent_update",
      ],
    );
    assert.deepEqual(
      database.all<{ name: string; pk: number }>("PRAGMA table_info(single_page_crawl_evidence)").map((column) => column.name),
      evidenceColumns,
    );
    assert.equal(
      database.get<{ pk: number }>("PRAGMA table_info(single_page_crawl_evidence)")?.pk,
      1,
    );
    const indexes = database.all<{ sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'single_page_crawl_evidence'",
    );
    assert.deepEqual(indexes.filter((index) => index.sql !== null), []);
    const foreignKeys = database.all<{
      table: string;
      from: string;
      on_update: string;
      on_delete: string;
    }>("PRAGMA foreign_key_list(single_page_crawl_evidence)");
    assert.deepEqual(
      foreignKeys.map(({ table, from, on_update, on_delete }) => ({
        table,
        from,
        on_update,
        on_delete,
      })),
      [{ table: "business_leads", from: "lead_id", on_update: "RESTRICT", on_delete: "RESTRICT" }],
    );
    assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("migration 022 rejects a missing or old business_leads shape without recording itself", () => {
  const missing = openDatabase();
  try {
    assert.throws(
      () => applyMigrations(missing, [singlePageCrawlEvidenceMigration]),
      (error: unknown) => assertFixedError(error, prerequisitesMessage),
    );
    assertNotMigrated(missing);
  } finally {
    missing.close();
  }

  const oldShape = openDatabase();
  try {
    applyMigrations(oldShape, [businessLeadsMigration]);
    assert.throws(
      () => applyMigrations(oldShape, [singlePageCrawlEvidenceMigration]),
      (error: unknown) => assertFixedError(error, prerequisitesMessage),
    );
    assertNotMigrated(oldShape);
  } finally {
    oldShape.close();
  }

  const wrongOrder = openDatabase();
  try {
    wrongOrder.exec(`
      CREATE TABLE business_leads (
        id TEXT PRIMARY KEY,
        business_name TEXT,
        source_kind TEXT,
        source_reference TEXT,
        source_provider TEXT,
        status TEXT,
        website_presence TEXT,
        website_url TEXT,
        created_at TEXT,
        updated_at TEXT,
        version INTEGER
      )
    `);
    assert.throws(
      () => applyMigrations(wrongOrder, [singlePageCrawlEvidenceMigration]),
      (error: unknown) => assertFixedError(error, prerequisitesMessage),
    );
    assertNotMigrated(wrongOrder);
  } finally {
    wrongOrder.close();
  }
});

test("migration 022 rejects disabled foreign keys and an existing foreign-key violation", () => {
  const disabled = openDatabase();
  try {
    applyCurrentLeadSchema(disabled);
    disabled.exec("PRAGMA foreign_keys = OFF");
    assert.throws(
      () => applyMigrations(disabled, [singlePageCrawlEvidenceMigration]),
      (error: unknown) => assertFixedError(error, foreignKeyMessage),
    );
    assertNotMigrated(disabled);
  } finally {
    disabled.close();
  }

  const violated = openDatabase();
  try {
    violated.exec("PRAGMA foreign_keys = OFF");
    violated.exec(`
      CREATE TABLE business_leads (
        id TEXT PRIMARY KEY,
        business_name TEXT,
        source_kind TEXT,
        source_provider TEXT,
        source_reference TEXT,
        status TEXT,
        website_presence TEXT,
        website_url TEXT,
        created_at TEXT,
        updated_at TEXT,
        version INTEGER
      )
    `);
    violated.exec(`
      CREATE TABLE dangling_child (
        lead_id TEXT NOT NULL,
        FOREIGN KEY (lead_id) REFERENCES business_leads(id)
      )
    `);
    violated.run("INSERT INTO dangling_child (lead_id) VALUES (?)", [missingLeadId]);
    violated.exec("PRAGMA foreign_keys = ON");
    assert.ok(violated.all("PRAGMA foreign_key_check").length > 0);
    assert.throws(
      () => applyMigrations(violated, [singlePageCrawlEvidenceMigration]),
      (error: unknown) => assertFixedError(error, foreignKeyMessage),
    );
    assertNotMigrated(violated);
  } finally {
    violated.close();
  }
});

test("persists fetched and failed evidence and reads each attempt by id", () => {
  const { database, leads, evidence } = openServices();
  try {
    leads.createLead(baseLead, actor);
    const auditsBefore = auditCount(database);
    const leadBefore = leadRow(database, leadId);
    const fetchedInput = fetched({ contentType: "application/xhtml+xml", redirectCount: 5 });
    const storedFetched = evidence.persist(fetchedInput);
    const storedFailed = evidence.persist(failed());

    assert.equal(Object.isFrozen(storedFetched), true);
    assert.equal(Object.isFrozen(storedFailed), true);
    assert.equal(storedFetched.id > 0 && Number.isSafeInteger(storedFetched.id), true);
    assert.equal(storedFailed.id > 0 && Number.isSafeInteger(storedFailed.id), true);
    assert.notEqual(storedFetched.id, storedFailed.id);
    assert.deepEqual(evidence.findById(storedFetched.id), storedFetched);
    assert.deepEqual(evidence.findById(storedFailed.id), storedFailed);
    assert.equal(storedFetched.outcome, "fetched");
    assert.equal(storedFailed.outcome, "failed");
    if (storedFetched.outcome === "fetched" && storedFailed.outcome === "failed") {
      assert.equal(storedFetched.requestedUrl, urlA);
      assert.equal(storedFetched.finalUrl, "https://example.com/final");
      assert.equal(storedFetched.bodyText, "<p>héllo</p>");
      assert.equal(storedFetched.byteLength, Buffer.byteLength("<p>héllo</p>", "utf8"));
      assert.equal(storedFetched.contentType, "application/xhtml+xml");
      assert.equal(storedFetched.redirectCount, 5);
      assert.equal(storedFetched.leadVersion, 1);
      assert.equal(storedFetched.attemptedAt, attemptedAt);
      assert.equal("failure" in storedFetched, false);
      assert.equal(storedFailed.requestedUrl, "http://127.0.0.1/historical");
      assert.equal(storedFailed.failure, "BLOCKED_ADDRESS");
      assert.equal(storedFailed.leadVersion, 1);
      assert.equal(storedFailed.attemptedAt, attemptedAt);
      assert.equal("bodyText" in storedFailed, false);
    }
    assert.deepEqual(leadRow(database, leadId), leadBefore);
    assert.equal(auditCount(database), auditsBefore);
    assert.equal(
      database.get("SELECT id FROM audit_events WHERE event_type = 'crawl.evidence_recorded'"),
      undefined,
    );
  } finally {
    database.close();
  }
});

test("stores the 1 MiB boundary, an empty body, and distinct rows for duplicate values", () => {
  const { database, leads, evidence } = openServices();
  try {
    leads.createLead(baseLead, actor);
    const empty = evidence.persist(fetched({ bodyText: "", byteLength: 0 }));
    assert.equal(empty.outcome, "fetched");
    if (empty.outcome === "fetched") {
      assert.equal(empty.bodyText, "");
      assert.equal(empty.byteLength, 0);
    }

    const bodyText = "a".repeat(MAX_CRAWL_BODY_BYTES);
    const capped = evidence.persist(fetched({ bodyText, byteLength: MAX_CRAWL_BODY_BYTES }));
    assert.equal(capped.outcome, "fetched");
    if (capped.outcome === "fetched") {
      assert.equal(capped.byteLength, MAX_CRAWL_BODY_BYTES);
      assert.equal(capped.bodyText.length, MAX_CRAWL_BODY_BYTES);
    }
    assert.deepEqual(evidence.findById(capped.id), capped);

    const input = fetched();
    const first = evidence.persist(input);
    const second = evidence.persist(input);
    assert.notEqual(first.id, second.id);
    assert.equal(first.attemptedAt, second.attemptedAt);
    assert.deepEqual(evidence.findById(first.id), first);
    assert.deepEqual(evidence.findById(second.id), second);

    const sameTimeFirst = evidence.persist(failed({ failure: "TIMEOUT" }));
    const sameTimeSecond = evidence.persist(failed({ failure: "HTTP_FAILURE" }));
    assert.equal(sameTimeFirst.attemptedAt, sameTimeSecond.attemptedAt);
    assert.notEqual(sameTimeFirst.id, sameTimeSecond.id);
  } finally {
    database.close();
  }
});

test("keeps historical lead version and requested URL after the lead changes", () => {
  const { database, leads, evidence } = openServices();
  try {
    leads.createLead(baseLead, actor);
    leads.setWebsiteObservation(leadId, { presence: "present", url: "https://example.com/temp" }, 1, actor);
    leads.setWebsiteObservation(leadId, { presence: "present", url: urlB }, 2, actor);
    leads.setWebsiteObservation(leadId, { presence: "present", url: "https://example.com/temp-2" }, 3, actor);
    leads.setWebsiteObservation(leadId, { presence: "present", url: urlB }, 4, actor);
    const current = leads.getLead(leadId);
    assert.equal(current.version, 5);
    assert.equal(current.websiteObservation.presence, "present");
    if (current.websiteObservation.presence === "present") {
      assert.equal(current.websiteObservation.url, urlB);
    }
    const before = leadRow(database, leadId);
    const stored = evidence.persist(fetched({ leadVersion: 4, requestedUrl: urlA, finalUrl: urlA }));
    assert.equal(stored.leadVersion, 4);
    assert.equal(stored.requestedUrl, urlA);
    assert.deepEqual(leadRow(database, leadId), before);

    const ahead = evidence.persist(failed({ leadVersion: 9, requestedUrl: urlA }));
    assert.equal(ahead.leadVersion, 9);
    assert.equal(leads.getLead(leadId).version, 5);
  } finally {
    database.close();
  }
});

test("accepts archived and suppressed leads without changing them", () => {
  const archived = openServices();
  try {
    archived.leads.createLead(baseLead, actor);
    const reviewing = archived.leads.transitionLead(leadId, "reviewing", 1, actor);
    const archivedLead = archived.leads.transitionLead(leadId, "archived", reviewing.version, actor);
    const beforeArchive = leadRow(archived.database, leadId);
    const stored = archived.evidence.persist(fetched({ leadVersion: archivedLead.version }));
    assert.equal(stored.leadId, leadId);
    assert.deepEqual(leadRow(archived.database, leadId), beforeArchive);
    assert.equal(archived.leads.getLead(leadId).status, "archived");
  } finally {
    archived.database.close();
  }

  const suppressed = openServices();
  const contacts = new DoNotContactService(suppressed.database, {
    clock: () => new Date("2026-03-01T00:00:00.000Z"),
  });
  try {
    suppressed.leads.createLead(baseLead, actor);
    contacts.applySuppression(leadId, "manual", actor);
    const suppressionBefore = suppressed.database.get(
      `SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
       FROM lead_contact_suppressions WHERE lead_id = ?`,
      [leadId],
    );
    const leadBefore = leadRow(suppressed.database, leadId);
    const auditsBefore = auditCount(suppressed.database);
    suppressed.evidence.persist(failed());
    assert.deepEqual(
      suppressed.database.get(
        `SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
         FROM lead_contact_suppressions WHERE lead_id = ?`,
        [leadId],
      ),
      suppressionBefore,
    );
    assert.deepEqual(leadRow(suppressed.database, leadId), leadBefore);
    assert.equal(auditCount(suppressed.database), auditsBefore);
  } finally {
    suppressed.database.close();
  }
});

test("rejects a missing lead and invalid evidence without writing a row", () => {
  const { database, leads, evidence } = openServices();
  try {
    leads.createLead(baseLead, actor);
    assert.throws(
      () => evidence.persist(fetched({ leadId: missingLeadId })),
      (error: unknown) => assertPersistence(error, "LEAD_NOT_FOUND"),
    );
    assert.equal(evidenceCount(database), 0);
    assert.throws(
      () => evidence.persist(fetched({ leadVersion: 0 })),
      (error: unknown) => assertPersistence(error, "INVALID_EVIDENCE"),
    );
    const leadBefore = leadRow(database, leadId);
    assert.throws(
      () => evidence.persist(fetched({ bodyText: `${"a".repeat(MAX_CRAWL_BODY_BYTES)}b`, byteLength: MAX_CRAWL_BODY_BYTES + 1 })),
      (error: unknown) => assertPersistence(error, "INVALID_EVIDENCE"),
    );
    assert.equal(evidenceCount(database), 0);
    assert.deepEqual(leadRow(database, leadId), leadBefore);
  } finally {
    database.close();
  }
});

test("does not query the database for invalid evidence or a malformed id", () => {
  const evidence = new SinglePageCrawlEvidenceService(new TouchDatabase());
  assert.throws(
    () => evidence.persist({ outcome: "fetched" }),
    (error: unknown) => assertPersistence(error, "INVALID_EVIDENCE"),
  );
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, Number.NaN]) {
    assert.throws(
      () => evidence.findById(id),
      (error: unknown) => assertPersistence(error, "INVALID_EVIDENCE"),
    );
  }
});

test("findById returns undefined for a valid missing id and fails closed on corruption", () => {
  const { database, leads, evidence } = openServices();
  try {
    leads.createLead(baseLead, actor);
    const stored = evidence.persist(fetched());
    assert.equal(evidence.findById(stored.id === 1 ? 2 : 1), undefined);
    assert.equal(evidence.findById(Number.MAX_SAFE_INTEGER), undefined);

    const corrupt = database.run(
      `INSERT INTO single_page_crawl_evidence (
        lead_id, lead_version, outcome, requested_url, attempted_at, failure_code
      ) VALUES (?, 1, 'failed', 'not-a-url', ?, 'INVALID_URL')`,
      [leadId, attemptedAt],
    );
    const corruptId = Number(corrupt.lastInsertRowid);
    assert.throws(
      () => evidence.findById(corruptId),
      (error: unknown) =>
        assertPersistence(error, "PERSISTENCE_FAILED", ["not-a-url", "SELECT", "INVALID_URL"]),
    );
    assert.deepEqual(evidence.findById(stored.id), stored);
  } finally {
    database.close();
  }
});

test("maps a constraint failure to the fixed persistence error and rejects update and delete", () => {
  const { database, leads, evidence } = openServices();
  try {
    leads.createLead(baseLead, actor);
    const stored = evidence.persist(fetched());
    database.exec(`
      CREATE TRIGGER single_page_crawl_evidence_test_abort
      BEFORE INSERT ON single_page_crawl_evidence
      BEGIN
        SELECT RAISE(ABORT, 'secret-constraint-marker');
      END;
    `);
    assert.throws(
      () => evidence.persist(fetched()),
      (error: unknown) => assertPersistence(error, "PERSISTENCE_FAILED", ["secret-constraint-marker"]),
    );
    assert.equal(evidenceCount(database), 1);
    assert.deepEqual(evidence.findById(stored.id), stored);

    assert.throws(() =>
      database.run("UPDATE single_page_crawl_evidence SET lead_version = lead_version + 1 WHERE id = ?", [
        stored.id,
      ]),
    );
    assert.throws(() => database.run("DELETE FROM single_page_crawl_evidence WHERE id = ?", [stored.id]));
    assert.deepEqual(evidence.findById(stored.id), stored);
    assert.equal(evidenceCount(database), 1);
  } finally {
    database.close();
  }
});

test("lets a programming error propagate", () => {
  const evidence = new SinglePageCrawlEvidenceService(new ProgrammingErrorDatabase());
  assert.throws(
    () => evidence.findById(1),
    (error: unknown) => error instanceof TypeError && error.message === "programming-marker",
  );
  assert.throws(
    () => evidence.persist(fetched()),
    (error: unknown) => error instanceof TypeError && error.message === "programming-marker",
  );
});

test("raw SQL enforces outcome shape, the byte cap, the failure allowlist, and the foreign key", () => {
  const { database, leads } = openServices();
  try {
    leads.createLead(baseLead, actor);
    assert.throws(() =>
      database.run(
        `INSERT INTO single_page_crawl_evidence (
          lead_id, lead_version, outcome, requested_url, attempted_at,
          final_url, status_code, content_type, body_text, byte_length, redirect_count, failure_code
        ) VALUES (?, 1, 'fetched', ?, ?, ?, 200, 'text/html', ?, ?, 0, 'TIMEOUT')`,
        [leadId, urlA, attemptedAt, urlA, "abc", 3],
      ),
    );
    assert.throws(() =>
      database.run(
        `INSERT INTO single_page_crawl_evidence (
          lead_id, lead_version, outcome, requested_url, attempted_at, body_text, failure_code
        ) VALUES (?, 1, 'failed', ?, ?, 'body', 'TIMEOUT')`,
        [leadId, urlA, attemptedAt],
      ),
    );
    const over = "a".repeat(MAX_CRAWL_BODY_BYTES + 1);
    assert.throws(() =>
      database.run(
        `INSERT INTO single_page_crawl_evidence (
          lead_id, lead_version, outcome, requested_url, attempted_at,
          final_url, status_code, content_type, body_text, byte_length, redirect_count
        ) VALUES (?, 1, 'fetched', ?, ?, ?, 200, 'text/html', ?, ?, 0)`,
        [leadId, urlA, attemptedAt, urlA, over, over.length],
      ),
    );
    assert.throws(() =>
      database.run(
        `INSERT INTO single_page_crawl_evidence (
          lead_id, lead_version, outcome, requested_url, attempted_at, failure_code
        ) VALUES (?, 1, 'failed', ?, ?, 'NOT_A_CODE')`,
        [leadId, urlA, attemptedAt],
      ),
    );
    assert.throws(() =>
      database.run(
        `INSERT INTO single_page_crawl_evidence (
          lead_id, lead_version, outcome, requested_url, attempted_at, failure_code
        ) VALUES (?, 1, 'failed', ?, ?, 'TIMEOUT')`,
        [missingLeadId, urlA, attemptedAt],
      ),
    );
    assert.equal(evidenceCount(database), 0);
  } finally {
    database.close();
  }
});

test("reopens a file database without changing the stored attempt", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-crawl-evidence-"));
  const url = `file:${join(directory, "evidence.sqlite")}` as const;
  try {
    const firstDatabase = createDatabase({ url });
    applyEvidenceSchema(firstDatabase);
    const leads = new LeadService(firstDatabase, {
      idGenerator: () => leadId,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    leads.createLead(baseLead, actor);
    const stored = new SinglePageCrawlEvidenceService(firstDatabase).persist(fetched());
    firstDatabase.close();

    const reopened = createDatabase({ url });
    try {
      assert.deepEqual(applyMigrations(reopened, [...currentLeadMigrations(), ...crawlerMigrations]), []);
      assert.deepEqual(new SinglePageCrawlEvidenceService(reopened).findById(stored.id), stored);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("exports the persistence error codes without a list API", () => {
  assert.deepEqual(
    [...CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES],
    ["INVALID_EVIDENCE", "LEAD_NOT_FOUND", "PERSISTENCE_FAILED"],
  );
  const service = new SinglePageCrawlEvidenceService(new TouchDatabase());
  assert.equal("listForLead" in service, false);
  assert.equal("latestForLead" in service, false);
});
