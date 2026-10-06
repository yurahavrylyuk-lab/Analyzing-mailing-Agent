import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DatabaseAuditRepository,
  InvalidAuditActorError,
  auditMigrations,
  type AuditActor,
  type AuditEventInput,
  type AuditRepository,
} from "../../src/audit";
import { applyMigrations, createDatabase, type Database } from "../../src/db";
import { complianceMigrations } from "../../src/compliance";
import {
  ArchivedLeadWebsiteMutationError,
  DatabaseLeadRepository,
  InvalidLeadTransitionError,
  LeadNotFoundError,
  LeadService,
  StaleLeadVersionError,
  leadMigrations,
  type CreateLeadInput,
  type LeadRepository,
} from "../../src/leads";

const leadId = "00000000-0000-4000-8000-000000000051";
const otherLeadId = "00000000-0000-4000-8000-000000000052";
const actor: AuditActor = { type: "human", id: "  reviewer-5  " };
const input: CreateLeadInput = {
  businessName: "Audit Test Business",
  sourceKind: "manual",
  sourceReference: "private-source-ref",
  websiteObservation: { presence: "unknown" },
};

function migrate(database: Database): void {
  applyMigrations(database, [
    ...leadMigrations,
    ...auditMigrations,
    ...complianceMigrations,
  ]);
}

function makeService(database: Database, id = leadId): LeadService {
  return new LeadService(database, {
    idGenerator: () => id,
    clock: (() => {
      const dates = [
        new Date("2026-02-01T00:00:00.000Z"),
        new Date("2026-02-01T00:00:01.000Z"),
        new Date("2026-02-01T00:00:02.000Z"),
      ];
      return () => dates.shift() ?? new Date("2026-02-01T00:00:03.000Z");
    })(),
  });
}

function createdEvent(entityId: string, actorId = "system-worker"): AuditEventInput {
  return {
    occurredAt: "2026-02-01T00:00:00.000Z",
    eventType: "lead.created",
    entityType: "business_lead",
    entityId,
    actor: { type: "system", id: actorId },
    details: {
      initialStatus: "recorded",
      initialWebsitePresence: "unknown",
      version: 1,
    },
  };
}

function objectNames(database: Database, type: "index" | "trigger"): string[] {
  return database
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'audit_events_%' ORDER BY name",
      [type],
    )
    .map(({ name }) => name);
}

function rejectAuditInserts(database: Database): void {
  database.exec(`
    CREATE TRIGGER audit_events_reject_test_insert
    BEFORE INSERT ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'Simulated audit write failure.');
    END;
  `);
}

test("audit migration applies once and creates its table, index, and triggers", () => {
  const database = createDatabase({ url: "file::memory:" });
  try {
    assert.deepEqual(applyMigrations(database, auditMigrations), ["005-audit-events"]);
    assert.deepEqual(applyMigrations(database, auditMigrations), []);
    assert.deepEqual(objectNames(database, "index"), ["audit_events_entity_history_idx"]);
    assert.deepEqual(objectNames(database, "trigger"), [
      "audit_events_prevent_delete",
      "audit_events_prevent_update",
    ]);
    assert.equal(
      database.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_events'",
      )?.name,
      "audit_events",
    );
  } finally {
    database.close();
  }
});

test("database accepts only canonical UTC audit timestamps", () => {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, auditMigrations);
  const insert = (occurredAt: string) =>
    database.run(
      `INSERT INTO audit_events (
        occurred_at, event_type, entity_type, entity_id,
        actor_type, actor_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        occurredAt,
        "lead.created",
        "business_lead",
        leadId,
        "system",
        "timestamp-test",
        JSON.stringify({
          initialStatus: "recorded",
          initialWebsitePresence: "unknown",
          version: 1,
        }),
      ],
    );

  try {
    assert.doesNotThrow(() => insert("2026-10-03T08:20:30.123Z"));
    assert.doesNotThrow(() => insert("2024-02-29T23:59:59.999Z"));
    for (const invalidTimestamp of [
      "hello",
      "2026-10-03",
      "2026-10-03T10:20:30",
      "2026-10-03T10:20:30+02:00",
      "2026-10-03T08:20:30Z",
      "2026-10-03T08:20:30.1234Z",
      "2026-01-01T24:00:00.000Z",
      "2026-02-30T12:00:00.000Z",
      "2025-02-29T12:00:00.000Z",
      "2026-13-01T12:00:00.000Z",
      "2026-00-01T12:00:00.000Z",
      "2026-01-00T12:00:00.000Z",
      "2026-01-01T25:00:00.000Z",
      "2026-01-01T12:60:00.000Z",
      "2026-01-01T12:00:60.000Z",
    ]) {
      assert.throws(() => insert(invalidTimestamp));
    }
  } finally {
    database.close();
  }
});

test("LeadService accepts Database and rejects a structural fake audited unit of work", () => {
  const database = createDatabase({ url: "file::memory:" });
  const fakeAudits: AuditRepository = {
    append(event) {
      return { id: 1, ...event };
    },
    listForEntity() {
      return [];
    },
  };
  const fakeContext: Readonly<{
    leads: LeadRepository;
    audits: AuditRepository;
  }> = {
    leads: new DatabaseLeadRepository(database),
    audits: fakeAudits,
  };
  const fakeAuditedUnitOfWork = {
    ...fakeContext,
    transaction<T>(operation: (context: typeof fakeContext) => T): T {
      return operation(fakeContext);
    },
  };

  try {
    assert.doesNotThrow(() => new LeadService(database));
    if (false) {
      // @ts-expect-error LeadService persistence must be backed by Database.
      new LeadService(fakeAuditedUnitOfWork);
    }
  } finally {
    database.close();
  }
});

test("append persists values, isolates histories, and orders equal timestamps by ID", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const repository = new DatabaseAuditRepository(database);
    const first = repository.append(createdEvent(leadId, "worker'; DROP TABLE audit_events;--"));
    repository.append(createdEvent(otherLeadId));
    const second = repository.append({
      ...createdEvent(leadId),
      eventType: "lead.status_changed",
      details: { previousStatus: "recorded", newStatus: "reviewing", version: 2 },
    });

    assert.ok(first.id < second.id);
    assert.deepEqual(repository.listForEntity("business_lead", leadId), [first, second]);
    assert.deepEqual(
      repository.listForEntity("business_lead", otherLeadId).map(({ entityId }) => entityId),
      [otherLeadId],
    );
    assert.equal(
      database.get<{ count: number }>("SELECT count(*) AS count FROM audit_events")?.count,
      3,
    );
  } finally {
    database.close();
  }
});

test("audit history persists across a file-backed database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-audit-"));
  const url = `file:${join(directory, "audit.sqlite")}` as const;
  try {
    const firstDatabase = createDatabase({ url });
    migrate(firstDatabase);
    const expected = new DatabaseAuditRepository(firstDatabase).append(createdEvent(leadId));
    firstDatabase.close();

    const reopenedDatabase = createDatabase({ url });
    try {
      migrate(reopenedDatabase);
      assert.deepEqual(
        new DatabaseAuditRepository(reopenedDatabase).listForEntity(
          "business_lead",
          leadId,
        ),
        [expected],
      );
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("database triggers reject audit updates and deletes", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const event = new DatabaseAuditRepository(database).append(createdEvent(leadId));
    assert.throws(() =>
      database.run("UPDATE audit_events SET actor_id = ? WHERE id = ?", ["changed", event.id]),
    );
    assert.throws(() => database.run("DELETE FROM audit_events WHERE id = ?", [event.id]));
    assert.equal(
      new DatabaseAuditRepository(database).listForEntity("business_lead", leadId).length,
      1,
    );
  } finally {
    database.close();
  }
});

test("lead mutations append exact attributable events without sensitive fields", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const service = makeService(database);
    const created = service.createLead(input, actor);
    const reviewing = service.transitionLead(created.id, "reviewing", 1, actor);
    const observed = service.setWebsiteObservation(
      created.id,
      { presence: "present", url: "https://user.example/private?token=secret" },
      2,
      { type: "system", id: "website-checker" },
    );
    const events = new DatabaseAuditRepository(database).listForEntity(
      "business_lead",
      created.id,
    );

    assert.deepEqual(
      events.map(({ eventType, occurredAt, actor: eventActor, details }) => ({
        eventType,
        occurredAt,
        actor: eventActor,
        details,
      })),
      [
        {
          eventType: "lead.created",
          occurredAt: created.createdAt,
          actor: { type: "human", id: "reviewer-5" },
          details: {
            initialStatus: "recorded",
            initialWebsitePresence: "unknown",
            version: 1,
          },
        },
        {
          eventType: "lead.status_changed",
          occurredAt: reviewing.updatedAt,
          actor: { type: "human", id: "reviewer-5" },
          details: { previousStatus: "recorded", newStatus: "reviewing", version: 2 },
        },
        {
          eventType: "lead.website_observation_changed",
          occurredAt: observed.updatedAt,
          actor: { type: "system", id: "website-checker" },
          details: {
            previousPresence: "unknown",
            newPresence: "present",
            urlChanged: true,
            version: 3,
          },
        },
      ],
    );
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(input.businessName));
    assert.ok(!serialized.includes(input.sourceReference));
    assert.ok(!serialized.includes("user.example"));
    assert.ok(!serialized.includes("token=secret"));
  } finally {
    database.close();
  }
});

test("website observation auditing performs no network request", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const originalFetch = globalThis.fetch;
  let networkRequests = 0;
  globalThis.fetch = (() => {
    networkRequests += 1;
    throw new Error("Unexpected network request.");
  }) as typeof fetch;

  try {
    const service = makeService(database);
    const created = service.createLead(input, actor);
    service.setWebsiteObservation(
      created.id,
      { presence: "present", url: "https://unreachable.invalid/business" },
      created.version,
      actor,
    );
    assert.equal(networkRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("no-ops and rejected lead mutations append no event", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const service = makeService(database);
    const created = service.createLead(input, actor);
    const audit = new DatabaseAuditRepository(database);
    service.transitionLead(created.id, "recorded", 1, actor);
    service.setWebsiteObservation(created.id, { presence: "unknown" }, 1, actor);
    assert.throws(
      () => service.transitionLead(created.id, "archived", 2, actor),
      StaleLeadVersionError,
    );
    const reviewing = service.transitionLead(created.id, "reviewing", 1, actor);
    assert.throws(
      () => service.transitionLead(created.id, "recorded", reviewing.version, actor),
      InvalidLeadTransitionError,
    );
    const archived = service.transitionLead(created.id, "archived", reviewing.version, actor);
    assert.throws(
      () =>
        service.setWebsiteObservation(
          created.id,
          { presence: "missing" },
          archived.version,
          actor,
        ),
      ArchivedLeadWebsiteMutationError,
    );
    assert.throws(
      () => service.transitionLead(otherLeadId, "reviewing", 1, actor),
      LeadNotFoundError,
    );
    assert.equal(audit.listForEntity("business_lead", created.id).length, 3);
    assert.equal(audit.listForEntity("business_lead", otherLeadId).length, 0);
  } finally {
    database.close();
  }
});

test("audit failures roll back lead creation", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    rejectAuditInserts(database);
    const service = new LeadService(
      database,
      { idGenerator: () => leadId, clock: () => new Date("2026-02-01T00:00:00.000Z") },
    );
    assert.throws(() => service.createLead(input, actor), /Simulated audit write failure/u);
    assert.equal(
      database.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count,
      0,
    );
  } finally {
    database.close();
  }
});

test("audit failures roll back status and website mutations", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const normalService = makeService(database);
    const created = normalService.createLead(input, actor);
    rejectAuditInserts(database);
    const failingService = new LeadService(
      database,
      { clock: () => new Date("2026-02-01T01:00:00.000Z") },
    );

    assert.throws(
      () => failingService.transitionLead(created.id, "reviewing", 1, actor),
      /Simulated audit write failure/u,
    );
    assert.deepEqual(normalService.getLead(created.id), created);
    assert.throws(
      () =>
        failingService.setWebsiteObservation(
          created.id,
          { presence: "missing" },
          1,
          actor,
        ),
      /Simulated audit write failure/u,
    );
    assert.deepEqual(normalService.getLead(created.id), created);
    assert.equal(
      new DatabaseAuditRepository(database).listForEntity("business_lead", created.id)
        .length,
      1,
    );
  } finally {
    database.close();
  }
});

test("LeadService rejects invalid actors before writing or accepting a no-op", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  try {
    const service = makeService(database);
    assert.throws(
      () => service.createLead(input, { type: "human", id: "\n" }),
      InvalidAuditActorError,
    );
    assert.equal(
      database.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count,
      0,
    );
    const created = service.createLead(input, actor);
    assert.throws(
      () => service.transitionLead(created.id, "recorded", 1, { type: "system", id: " " }),
      InvalidAuditActorError,
    );
    assert.equal(
      new DatabaseAuditRepository(database).listForEntity("business_lead", created.id)
        .length,
      1,
    );
  } finally {
    database.close();
  }
});
