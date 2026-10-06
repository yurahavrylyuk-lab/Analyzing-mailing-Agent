import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

import {
  DatabaseAuditRepository,
  InvalidAuditActorError,
  auditMigrations,
  type AuditActor,
} from "../../src/audit";
import { DoNotContactService, complianceMigrations } from "../../src/compliance";
import { applyMigrations, createDatabase, type Database } from "../../src/db";
import { normalizeDiscoveryCandidate } from "../../src/discovery";
import {
  DatabaseLeadRepository,
  InvalidDiscoveredLeadInputError,
  InvalidLeadInputError,
  LeadPersistenceError,
  LeadService,
  leadMigrations,
  type CreateLeadInput,
  type DiscoveredBusinessLead,
  type RecordDiscoveredLeadInput,
} from "../../src/leads";

const ids = [
  "00000000-0000-4000-8000-000000000121",
  "00000000-0000-4000-8000-000000000122",
  "00000000-0000-4000-8000-000000000123",
  "00000000-0000-4000-8000-000000000124",
  "00000000-0000-4000-8000-000000000125",
  "00000000-0000-4000-8000-000000000126",
] as const;
const actor: AuditActor = { type: "system", id: "discovery-recorder" };
const input: RecordDiscoveredLeadInput = {
  provider: "approved_directory",
  providerReference: "Place-ABC-123",
  businessName: "Example Business",
  websiteObservation: { presence: "present", url: "https://example.com/" },
};

function migrate(database: Database): void {
  applyMigrations(database, [...leadMigrations, ...auditMigrations, ...complianceMigrations]);
}

function service(
  database: Database,
  options: { idGenerator?: () => string; clock?: () => Date } = {},
): LeadService {
  return new LeadService(database, {
    idGenerator: options.idGenerator ?? (() => ids[0]),
    clock: options.clock ?? (() => new Date("2026-05-01T00:00:00.000Z")),
  });
}

function events(database: Database, leadId: string) {
  return new DatabaseAuditRepository(database).listForEntity("business_lead", leadId);
}

test("manual lead shape remains unchanged and explicit sourceProvider is rejected", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const manualInput: CreateLeadInput = {
    businessName: "Manual Business",
    sourceKind: "manual",
    sourceReference: "manual-reference",
    websiteObservation: { presence: "unknown" },
  };
  try {
    const lead = service(database).createLead(manualInput, actor);
    assert.deepEqual(Object.keys(lead).sort(), [
      "businessName", "createdAt", "id", "sourceKind", "sourceReference",
      "status", "updatedAt", "version", "websiteObservation",
    ]);
    assert.equal("sourceProvider" in lead, false);
    assert.throws(
      () => service(database, { idGenerator: () => ids[1] }).createLead(
        { ...manualInput, sourceProvider: "directory" } as CreateLeadInput,
        actor,
      ),
      InvalidLeadInputError,
    );
  } finally {
    database.close();
  }
});

test("records discovered provenance and one minimal lead.created event atomically", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const result = service(database).recordDiscoveredLead(input, actor);
    assert.equal(result.created, true);
    assert.deepEqual(result.lead, {
      id: ids[0],
      businessName: "Example Business",
      sourceKind: "discovery",
      sourceProvider: "approved_directory",
      sourceReference: "Place-ABC-123",
      status: "recorded",
      websiteObservation: { presence: "present", url: "https://example.com/" },
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      version: 1,
    });
    assert.deepEqual(service(database).recordDiscoveredLead(input, actor), {
      lead: result.lead,
      created: false,
    });
    assert.deepEqual(events(database, result.lead.id).map((event) => ({
      eventType: event.eventType,
      details: event.details,
    })), [{
      eventType: "lead.created",
      details: {
        initialStatus: "recorded",
        initialWebsitePresence: "present",
        version: 1,
      },
    }]);
  } finally {
    database.close();
  }
});

test("duplicate validation precedes lookup and the ordinary duplicate uses no clock or ID", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const first = service(database).recordDiscoveredLead(input, actor);
  let idCalls = 0;
  let clockCalls = 0;
  const duplicateService = service(database, {
    idGenerator: () => {
      idCalls += 1;
      throw new Error("must not run");
    },
    clock: () => {
      clockCalls += 1;
      throw new Error("must not run");
    },
  });
  try {
    const repeated = duplicateService.recordDiscoveredLead(
      { ...input, businessName: "Changed", websiteObservation: { presence: "unknown" } },
      actor,
    );
    assert.deepEqual(repeated, { lead: first.lead, created: false });
    assert.equal(idCalls, 0);
    assert.equal(clockCalls, 0);
    assert.throws(
      () => duplicateService.recordDiscoveredLead(
        { ...input, businessName: " " },
        actor,
      ),
      InvalidDiscoveredLeadInputError,
    );
    assert.throws(
      () => duplicateService.recordDiscoveredLead(input, { type: "human", id: "\n" }),
      InvalidAuditActorError,
    );
  } finally {
    database.close();
  }
});

test("validates discovery boundaries, exact shapes, and safe errors", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const validProvider = `a${"b".repeat(63)}`;
  const validReference = "R".repeat(512);
  const validName = "界".repeat(300);
  try {
    const accepted = service(database).recordDiscoveredLead({
      provider: validProvider,
      providerReference: validReference,
      businessName: ` ${validName} `,
      websiteObservation: { presence: "unknown" },
    }, actor);
    assert.equal(accepted.lead.sourceProvider, validProvider);
    assert.equal(accepted.lead.sourceReference, validReference);
    assert.equal(accepted.lead.businessName, validName);

    for (const invalid of [
      { ...input, provider: "" },
      { ...input, provider: "Upper" },
      { ...input, provider: "a".repeat(65) },
      { ...input, providerReference: " reference " },
      { ...input, providerReference: "line\nbreak" },
      { ...input, providerReference: "x".repeat(513) },
      { ...input, businessName: "line\nbreak" },
      { ...input, businessName: "x".repeat(301) },
      { ...input, websiteObservation: { presence: "missing" } },
      { ...input, websiteObservation: { presence: "present", url: "ftp://example.com" } },
      { ...input, websiteObservation: { presence: "unknown", url: "https://example.com" } },
      { ...input, extra: "sentinel-private-value" },
    ]) {
      assert.throws(
        () => service(database, { idGenerator: () => ids[1] }).recordDiscoveredLead(
          invalid as RecordDiscoveredLeadInput,
          actor,
        ),
        (error: unknown) =>
          error instanceof InvalidDiscoveredLeadInputError &&
          error.message === "Discovered lead input is invalid." &&
          !error.message.includes("sentinel-private-value"),
      );
    }
  } finally {
    database.close();
  }
});

test("accepted DQ-010 candidates cross the persistence boundary without network access", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    throw new Error("network not allowed");
  }) as typeof fetch;
  try {
    const withWebsite = normalizeDiscoveryCandidate({
      provider: "approved_directory",
      providerReference: "CaseSensitive",
      businessName: "  Candidate  ",
      websiteUrl: "HTTPS://Example.COM",
    });
    assert.equal(withWebsite.status, "accepted");
    if (withWebsite.status === "accepted") {
      const result = service(database).recordDiscoveredLead({
        provider: withWebsite.candidate.provider,
        providerReference: withWebsite.candidate.providerReference,
        businessName: withWebsite.candidate.businessName,
        websiteObservation: withWebsite.candidate.websiteObservation,
      }, actor);
      assert.deepEqual(result.lead.websiteObservation, {
        presence: "present",
        url: "https://example.com/",
      });
    }
    const invalidWebsite = normalizeDiscoveryCandidate({
      provider: "approved_directory",
      providerReference: "invalid-site",
      businessName: "Candidate Two",
      websiteUrl: "https://user:private@example.com",
    });
    assert.equal(invalidWebsite.status, "accepted");
    if (invalidWebsite.status === "accepted") {
      assert.deepEqual(invalidWebsite.warnings, ["invalid_website"]);
      assert.deepEqual(service(database, { idGenerator: () => ids[1] }).recordDiscoveredLead({
        provider: invalidWebsite.candidate.provider,
        providerReference: invalidWebsite.candidate.providerReference,
        businessName: invalidWebsite.candidate.businessName,
        websiteObservation: invalidWebsite.candidate.websiteObservation,
      }, actor).lead.websiteObservation, { presence: "unknown" });
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("identity is provider-specific and does not use name, website, or manual provenance", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  let next = 0;
  const record = service(database, { idGenerator: () => ids[next++] ?? ids[4] });
  try {
    const first = record.recordDiscoveredLead(input, actor).lead;
    const otherProvider = record.recordDiscoveredLead({ ...input, provider: "other_directory" }, actor).lead;
    const otherReference = record.recordDiscoveredLead({ ...input, providerReference: "Other-Ref" }, actor).lead;
    const sameWebsite = record.recordDiscoveredLead({
      ...input,
      providerReference: "Third-Ref",
      businessName: "Different Name",
    }, actor).lead;
    const caseDistinctReference = record.recordDiscoveredLead({
      ...input,
      providerReference: "place-ABC-123",
    }, actor).lead;
    const manual = record.createLead({
      businessName: input.businessName,
      sourceKind: "manual",
      sourceReference: input.providerReference,
      websiteObservation: input.websiteObservation,
    }, actor);
    assert.equal(new Set([
      first.id,
      otherProvider.id,
      otherReference.id,
      sameWebsite.id,
      caseDistinctReference.id,
      manual.id,
    ]).size, 6);
    assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count, 6);
  } finally {
    database.close();
  }
});

test("rediscovery preserves archived, suppressed, missing-website state and audit history", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const lifecycle = service(database, {
    clock: (() => {
      const values = [
        new Date("2026-05-01T00:00:00.000Z"),
        new Date("2026-05-01T00:00:01.000Z"),
        new Date("2026-05-01T00:00:02.000Z"),
      ];
      return () => values.shift() ?? new Date("2026-05-01T00:00:03.000Z");
    })(),
  });
  try {
    const created = lifecycle.recordDiscoveredLead(input, actor).lead;
    const missing = lifecycle.setWebsiteObservation(created.id, { presence: "missing" }, 1, actor);
    const archived = lifecycle.transitionLead(created.id, "archived", 2, actor);
    new DoNotContactService(database, {
      clock: () => new Date("2026-05-01T00:00:03.000Z"),
    }).applySuppression(created.id, "requested", actor);
    const beforeEvents = events(database, created.id);
    const repeated = service(database, {
      idGenerator: () => { throw new Error("unused"); },
      clock: () => { throw new Error("unused"); },
    }).recordDiscoveredLead({
      ...input,
      businessName: "Replacement Name",
      websiteObservation: { presence: "present", url: "https://changed.example/" },
    }, actor);
    assert.equal(missing.websiteObservation.presence, "missing");
    assert.deepEqual(repeated, { lead: archived, created: false });
    assert.deepEqual(events(database, created.id), beforeEvents);
    assert.equal(
      database.get<{ count: number }>("SELECT count(*) AS count FROM lead_contact_suppressions WHERE lead_id = ?", [created.id])?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test("audit and lead failures roll back safely without leaking causes", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    database.exec(`
      CREATE TRIGGER audit_events_reject_discovery_test
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'lead.created'
      BEGIN SELECT RAISE(ABORT, 'sentinel audit secret'); END
    `);
    assert.throws(
      () => service(database).recordDiscoveredLead(input, actor),
      (error: unknown) => error instanceof LeadPersistenceError && !error.message.includes("sentinel"),
    );
    assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count, 0);
    database.exec("DROP TRIGGER audit_events_reject_discovery_test");
    database.exec(`
      CREATE TRIGGER business_leads_reject_discovery_test
      BEFORE INSERT ON business_leads
      BEGIN SELECT RAISE(ABORT, 'sentinel lead secret'); END
    `);
    assert.throws(
      () => service(database).recordDiscoveredLead(input, actor),
      LeadPersistenceError,
    );
    assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM audit_events")?.count, 0);
  } finally {
    database.close();
  }
});

test("targeted repository conflict returns false while unrelated constraints still fail", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const repository = new DatabaseLeadRepository(database);
  const lead: DiscoveredBusinessLead = {
    id: ids[0],
    businessName: "Winner",
    sourceKind: "discovery",
    sourceProvider: "approved_directory",
    sourceReference: "winner-ref",
    status: "recorded",
    websiteObservation: { presence: "unknown" },
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    version: 1,
  };
  try {
    assert.equal(repository.insertDiscoveredIfAbsent(lead), true);
    assert.equal(repository.insertDiscoveredIfAbsent({ ...lead, id: ids[1] }), false);
    assert.throws(() => repository.insertDiscoveredIfAbsent({
      ...lead,
      sourceReference: "different-ref",
    }));
    assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count, 1);
  } finally {
    database.close();
  }
});

test("insert-time discovery winner is returned and a conflict without a winner fails", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    database.exec(`
      CREATE TRIGGER business_leads_simulate_discovery_winner
      BEFORE INSERT ON business_leads
      WHEN NEW.source_kind = 'discovery'
      BEGIN
        INSERT INTO business_leads (
          id, business_name, source_kind, source_provider, source_reference,
          status, website_presence, website_url, created_at, updated_at, version
        ) VALUES (
          '${ids[1]}', NEW.business_name, NEW.source_kind, NEW.source_provider,
          NEW.source_reference, NEW.status, NEW.website_presence, NEW.website_url,
          NEW.created_at, NEW.updated_at, NEW.version
        );
        INSERT INTO audit_events (
          occurred_at, event_type, entity_type, entity_id,
          actor_type, actor_id, details_json
        ) VALUES (
          NEW.created_at, 'lead.created', 'business_lead', '${ids[1]}',
          'system', 'concurrent-winner',
          '{"initialStatus":"recorded","initialWebsitePresence":"present","version":1}'
        );
      END
    `);
    const result = service(database).recordDiscoveredLead(input, actor);
    assert.equal(result.created, false);
    assert.equal(result.lead.id, ids[1]);
    assert.equal(events(database, ids[1]).length, 1);

    database.exec("DROP TRIGGER business_leads_simulate_discovery_winner");
    database.exec(`
      CREATE TRIGGER business_leads_simulate_missing_winner
      BEFORE INSERT ON business_leads
      WHEN NEW.source_kind = 'discovery'
      BEGIN SELECT RAISE(IGNORE); END
    `);
    assert.throws(
      () => service(database, { idGenerator: () => ids[2] }).recordDiscoveredLead(
        { ...input, providerReference: "no-winner" },
        actor,
      ),
      LeadPersistenceError,
    );
  } finally {
    database.close();
  }
});

test("repository decoding rejects malformed stored lead fields", () => {
  const corruptions: readonly Readonly<{
    sql: string;
    parameters: readonly (string | number | null)[];
    lookupId?: string;
  }>[] = [
    { sql: "UPDATE business_leads SET source_kind = 'other'", parameters: [] },
    { sql: "UPDATE business_leads SET source_provider = NULL", parameters: [] },
    { sql: "UPDATE business_leads SET source_provider = 'Upper'", parameters: [] },
    { sql: "UPDATE business_leads SET source_reference = ' bad '", parameters: [] },
    { sql: "UPDATE business_leads SET id = 'not-a-uuid'", parameters: [], lookupId: "not-a-uuid" },
    { sql: "UPDATE business_leads SET status = 'other'", parameters: [] },
    { sql: "UPDATE business_leads SET version = 0", parameters: [] },
    { sql: "UPDATE business_leads SET created_at = 'not-a-date'", parameters: [] },
    { sql: "UPDATE business_leads SET website_url = 'HTTPS://Example.COM/'", parameters: [] },
    {
      sql: "UPDATE business_leads SET website_presence = 'unknown', website_url = 'https://example.com/'",
      parameters: [],
    },
  ];

  for (const corruption of corruptions) {
    const database = createDatabase({ url: "file::memory:" });
    migrate(database);
    service(database).recordDiscoveredLead(input, actor);
    try {
      database.exec("PRAGMA ignore_check_constraints = ON");
      database.run(corruption.sql, corruption.parameters);
      assert.throws(
        () => new DatabaseLeadRepository(database).findById(corruption.lookupId ?? ids[0]),
        LeadPersistenceError,
      );
    } finally {
      database.close();
    }
  }
});

test("malformed stored rows, missing migration, closed storage, and bad generators fail safely", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  service(database).recordDiscoveredLead(input, actor);
  try {
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.run("UPDATE business_leads SET business_name = '' WHERE id = ?", [ids[0]]);
    assert.throws(() => service(database).recordDiscoveredLead(input, actor), LeadPersistenceError);
  } finally {
    database.close();
  }

  const historical = createDatabase({ url: "file::memory:" });
  applyMigrations(historical, [leadMigrations[0]!, ...auditMigrations, ...complianceMigrations]);
  try {
    assert.throws(() => service(historical).recordDiscoveredLead(input, actor), LeadPersistenceError);
  } finally {
    historical.close();
  }

  const invalidGenerator = createDatabase({ url: "file::memory:" });
  migrate(invalidGenerator);
  try {
    assert.throws(
      () => service(invalidGenerator, { idGenerator: () => "sentinel-bad-id" }).recordDiscoveredLead(input, actor),
      LeadPersistenceError,
    );
    assert.throws(
      () => service(invalidGenerator, { clock: () => new Date("invalid") }).recordDiscoveredLead(input, actor),
      LeadPersistenceError,
    );
    const closedService = service(invalidGenerator);
    invalidGenerator.close();
    assert.throws(() => closedService.recordDiscoveredLead(input, actor), LeadPersistenceError);
  } finally {
    invalidGenerator.close();
  }
});

test("file-backed idempotency survives reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-discovery-"));
  const url = `file:${join(directory, "discovery.sqlite")}` as const;
  try {
    const firstDatabase = createDatabase({ url });
    migrate(firstDatabase);
    const first = service(firstDatabase).recordDiscoveredLead(input, actor);
    firstDatabase.close();

    const reopened = createDatabase({ url });
    try {
      migrate(reopened);
      assert.deepEqual(service(reopened, {
        idGenerator: () => { throw new Error("unused"); },
        clock: () => { throw new Error("unused"); },
      }).recordDiscoveredLead(input, actor), { lead: first.lead, created: false });
      assert.equal(events(reopened, first.lead.id).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two genuine SQLite connections create at most one discovered lead and event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-discovery-race-"));
  const url = `file:${join(directory, "race.sqlite")}` as const;
  const setup = createDatabase({ url });
  migrate(setup);
  setup.close();
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { createDatabase } = require(workerData.dbModule);
    const { LeadService } = require(workerData.leadsModule);
    const database = createDatabase({ url: workerData.url });
    const service = new LeadService(database, {
      idGenerator: () => workerData.id,
      clock: () => new Date(workerData.timestamp),
    });
    parentPort.postMessage({ type: 'ready' });
    parentPort.once('message', () => {
      try {
        const result = service.recordDiscoveredLead(workerData.input, workerData.actor);
        parentPort.postMessage({ type: 'result', created: result.created, id: result.lead.id });
      } catch (error) {
        parentPort.postMessage({ type: 'error', name: error && error.name, message: error && error.message });
      } finally {
        database.close();
      }
    });
  `;
  const workerData = (id: string) => ({
    dbModule: require.resolve("../../src/db"),
    leadsModule: require.resolve("../../src/leads"),
    url,
    id,
    timestamp: "2026-05-01T00:00:00.000Z",
    input,
    actor,
  });
  const workers = [
    new Worker(workerSource, { eval: true, workerData: workerData(ids[0]) }),
    new Worker(workerSource, { eval: true, workerData: workerData(ids[1]) }),
  ];
  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("message", (message: { type: string }) => {
        if (message.type === "ready") resolve();
      });
      worker.once("error", reject);
    })));
    const outcomes = workers.map((worker) => new Promise<Record<string, unknown>>((resolve, reject) => {
      worker.once("message", (message: Record<string, unknown>) => resolve(message));
      worker.once("error", reject);
      worker.postMessage("start");
    }));
    const results = await Promise.all(outcomes);
    assert.equal(results.filter(({ type }) => type === "result").length >= 1, true);
    assert.ok(results.every(({ type, name, message }) =>
      type === "result" ||
      (type === "error" && name === "LeadPersistenceError" && message === "Lead persistence operation failed."),
    ));

    const verify = createDatabase({ url });
    try {
      assert.equal(verify.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count, 1);
      assert.equal(verify.get<{ count: number }>("SELECT count(*) AS count FROM audit_events WHERE event_type = 'lead.created'")?.count, 1);
      const retry = service(verify, {
        idGenerator: () => { throw new Error("unused"); },
        clock: () => { throw new Error("unused"); },
      }).recordDiscoveredLead(input, actor);
      assert.equal(retry.created, false);
      assert.equal(verify.get<{ count: number }>("SELECT count(*) AS count FROM audit_events")?.count, 1);
    } finally {
      verify.close();
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});
