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
} from "../../src/audit";
import {
  ContactBlockedError,
  ContactProtectionUnavailableError,
  DoNotContactService,
  InvalidSuppressionInputError,
  complianceMigrations,
  doNotContactMigration,
} from "../../src/compliance";
import { applyMigrations, createDatabase, type Database, type Migration } from "../../src/db";
import {
  LeadNotFoundError,
  LeadService,
  leadMigrations,
  type BusinessLead,
} from "../../src/leads";

const leadId = "00000000-0000-4000-8000-000000000071";
const otherLeadId = "00000000-0000-4000-8000-000000000072";
const thirdLeadId = "00000000-0000-4000-8000-000000000073";
const actor: AuditActor = { type: "human", id: "  compliance-reviewer  " };

function migrate(database: Database): void {
  applyMigrations(database, [
    ...leadMigrations,
    ...auditMigrations,
    ...complianceMigrations,
  ]);
}

function createLead(database: Database, id = leadId): BusinessLead {
  return new LeadService(database, {
    idGenerator: () => id,
    clock: () => new Date("2026-03-01T00:00:00.000Z"),
  }).createLead(
    {
      businessName: "Suppression Test Business",
      sourceKind: "manual",
      sourceReference: "manual-test",
      websiteObservation: { presence: "unknown" },
    },
    { type: "system", id: "test-fixture" },
  );
}

function service(database: Database, timestamp = "2026-03-01T00:00:01.000Z") {
  return new DoNotContactService(database, {
    clock: () => new Date(timestamp),
  });
}

function eventCount(database: Database, id = leadId): number {
  return new DatabaseAuditRepository(database).listForEntity("business_lead", id).length;
}

test("migration 007 applies once and creates the exact suppression schema and triggers", () => {
  const database = createDatabase({ url: "file::memory:" });
  try {
    applyMigrations(database, [...leadMigrations, ...auditMigrations]);
    assert.deepEqual(applyMigrations(database, complianceMigrations), ["007-do-not-contact"]);
    assert.deepEqual(applyMigrations(database, complianceMigrations), []);
    assert.deepEqual(
      database.all<{ name: string }>("PRAGMA table_info(lead_contact_suppressions)")
        .map(({ name }) => name),
      ["lead_id", "reason_code", "applied_at", "applied_by_type", "applied_by_id"],
    );
    assert.deepEqual(
      database.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'lead_contact_suppressions_%' ORDER BY name",
      ).map(({ name }) => name),
      [
        "lead_contact_suppressions_prevent_delete",
        "lead_contact_suppressions_prevent_update",
      ],
    );
  } finally {
    database.close();
  }
});

test("migration 007 upgrades populated audit storage without changing rows or ID continuity", () => {
  const database = createDatabase({ url: "file::memory:" });
  try {
    applyMigrations(database, [...leadMigrations, ...auditMigrations]);
    const lead = createLead(database);
    const leadService = new LeadService(database, {
      clock: () => new Date("2026-03-01T00:00:01.000Z"),
    });
    leadService.transitionLead(lead.id, "reviewing", lead.version, actor);
    const before = database.all<Record<string, unknown>>(
      "SELECT * FROM audit_events ORDER BY id",
    );

    applyMigrations(database, complianceMigrations);
    assert.deepEqual(database.all("SELECT * FROM audit_events ORDER BY id"), before);

    const applied = service(database, "2026-03-01T00:00:02.000Z")
      .applySuppression(lead.id, "manual", actor);
    const events = new DatabaseAuditRepository(database).listForEntity(
      "business_lead",
      lead.id,
    );
    assert.equal(applied.changed, true);
    assert.deepEqual(events.map(({ id }) => id), [1, 2, 3]);
    assert.deepEqual(events[2]?.details, { reasonCode: "manual" });
  } finally {
    database.close();
  }
});

test("migration preserves old restrictions, permits only the new event, and restores audit triggers", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const insert = (eventType: string) =>
    database.run(
      `INSERT INTO audit_events (
        occurred_at, event_type, entity_type, entity_id,
        actor_type, actor_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        "2026-03-01T00:00:00.000Z",
        eventType,
        "business_lead",
        leadId,
        "human",
        "reviewer",
        JSON.stringify({ reasonCode: "manual" }),
      ],
    );
  try {
    assert.doesNotThrow(() => insert("lead.do_not_contact_applied"));
    assert.throws(() => insert("lead.unknown"));
    assert.throws(() =>
      database.run("UPDATE audit_events SET actor_id = 'changed' WHERE id = 1"),
    );
    assert.throws(() => database.run("DELETE FROM audit_events WHERE id = 1"));
  } finally {
    database.close();
  }
});

test("migration failure rolls back the audit rebuild and suppression table", () => {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, [...leadMigrations, ...auditMigrations]);
  createLead(database);
  const failingMigration: Migration = {
    id: doNotContactMigration.id,
    up(migrationDatabase) {
      doNotContactMigration.up(migrationDatabase);
      throw new Error("simulated migration failure");
    },
  };
  try {
    assert.throws(() => applyMigrations(database, [failingMigration]), /simulated/u);
    assert.equal(
      database.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lead_contact_suppressions'"),
      undefined,
    );
    assert.equal(eventCount(database), 1);
    assert.throws(() => database.run("DELETE FROM audit_events WHERE id = 1"));
  } finally {
    database.close();
  }
});

test("suppression constraints enforce foreign keys, canonical values, and insert-only rows", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  const insert = (id: string, reason: string, timestamp: string, type: string) =>
    database.run(
      `INSERT INTO lead_contact_suppressions (
        lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      ) VALUES (?, ?, ?, ?, ?)`,
      [id, reason, timestamp, type, "actor"],
    );
  try {
    assert.throws(() => insert(otherLeadId, "manual", "2026-03-01T00:00:00.000Z", "human"));
    assert.throws(() => insert(leadId, "other", "2026-03-01T00:00:00.000Z", "human"));
    assert.throws(() => insert(leadId, "manual", "2026-03-01", "human"));
    assert.throws(() => insert(leadId, "manual", "2026-03-01T00:00:00.000Z", "service"));
    insert(leadId, "manual", "2026-03-01T00:00:00.000Z", "human");
    assert.throws(() =>
      database.run("UPDATE lead_contact_suppressions SET reason_code = 'requested' WHERE lead_id = ?", [leadId]),
    );
    assert.throws(() =>
      database.run("DELETE FROM lead_contact_suppressions WHERE lead_id = ?", [leadId]),
    );
  } finally {
    database.close();
  }
});

test("first suppression supports both reasons and actor types and writes one exact event", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  createLead(database, otherLeadId);
  try {
    const first = service(database).applySuppression(leadId, "manual", actor);
    const second = service(database, "2026-03-01T00:00:02.000Z")
      .applySuppression(otherLeadId, "requested", { type: "system", id: "automation" });
    assert.equal(first.changed, true);
    assert.deepEqual(first.suppression, {
      leadId,
      reasonCode: "manual",
      appliedAt: "2026-03-01T00:00:01.000Z",
      appliedBy: { type: "human", id: "compliance-reviewer" },
    });
    assert.equal(second.suppression.reasonCode, "requested");
    assert.equal(second.suppression.appliedBy.type, "system");
    const event = new DatabaseAuditRepository(database)
      .listForEntity("business_lead", leadId)[1];
    assert.deepEqual(event && {
      eventType: event.eventType,
      occurredAt: event.occurredAt,
      actor: event.actor,
      details: event.details,
    }, {
      eventType: "lead.do_not_contact_applied",
      occurredAt: first.suppression.appliedAt,
      actor: first.suppression.appliedBy,
      details: { reasonCode: "manual" },
    });
  } finally {
    database.close();
  }
});

test("repeated valid application is a no-op preserving the original row and event", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  try {
    const original = service(database).applySuppression(leadId, "manual", actor);
    const repeated = service(database, "2027-01-01T00:00:00.000Z")
      .applySuppression(leadId, "requested", { type: "system", id: "other" });
    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.suppression, original.suppression);
    assert.equal(eventCount(database), 2);
  } finally {
    database.close();
  }
});

test("invalid initial and repeated requests fail before writing events", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  const doNotContact = service(database);
  try {
    assert.throws(
      () => doNotContact.applySuppression(leadId, "invalid", actor),
      InvalidSuppressionInputError,
    );
    assert.throws(
      () => doNotContact.applySuppression("lead-71", "manual", actor),
      InvalidSuppressionInputError,
    );
    assert.throws(
      () => doNotContact.applySuppression(leadId, "manual", { type: "human", id: "\n" }),
      InvalidAuditActorError,
    );
    assert.throws(
      () => doNotContact.applySuppression(otherLeadId, "manual", actor),
      LeadNotFoundError,
    );
    doNotContact.applySuppression(leadId, "manual", actor);
    assert.throws(
      () => doNotContact.applySuppression(leadId, { reason: "requested", notes: "no" }, actor),
      InvalidSuppressionInputError,
    );
    assert.equal(eventCount(database), 2);
  } finally {
    database.close();
  }
});

test("query distinguishes reliable absence, persisted suppression, and missing leads", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  const doNotContact = service(database);
  try {
    assert.deepEqual(doNotContact.getSuppression(leadId), {
      state: "not_suppressed",
      leadId,
    });
    const applied = doNotContact.applySuppression(leadId, "requested", actor);
    assert.deepEqual(doNotContact.getSuppression(leadId), {
      state: "suppressed",
      suppression: applied.suppression,
    });
    assert.throws(() => doNotContact.getSuppression(otherLeadId), LeadNotFoundError);
  } finally {
    database.close();
  }
});

test("contact guard passes recorded and reviewing leads and blocks suppressed or archived leads", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const recorded = createLead(database);
  const reviewing = createLead(database, otherLeadId);
  const archivedLead = createLead(database, thirdLeadId);
  const leadService = new LeadService(database, {
    clock: () => new Date("2026-03-01T00:00:03.000Z"),
  });
  leadService.transitionLead(reviewing.id, "reviewing", reviewing.version, actor);
  const doNotContact = service(database);
  try {
    assert.doesNotThrow(() => doNotContact.assertContactAllowed(recorded.id));
    assert.doesNotThrow(() => doNotContact.assertContactAllowed(reviewing.id));
    doNotContact.applySuppression(recorded.id, "requested", actor);
    assert.throws(
      () => doNotContact.assertContactAllowed(recorded.id),
      (error: unknown) => error instanceof ContactBlockedError && error.reason === "suppressed",
    );
    doNotContact.applySuppression(reviewing.id, "manual", actor);
    assert.throws(
      () => doNotContact.assertContactAllowed(reviewing.id),
      (error: unknown) => error instanceof ContactBlockedError && error.reason === "suppressed",
    );
    leadService.transitionLead(reviewing.id, "archived", reviewing.version + 1, actor);
    assert.throws(
      () => doNotContact.assertContactAllowed(reviewing.id),
      (error: unknown) => error instanceof ContactBlockedError && error.reason === "suppressed",
    );
    leadService.transitionLead(archivedLead.id, "archived", archivedLead.version, actor);
    assert.throws(
      () => doNotContact.assertContactAllowed(archivedLead.id),
      (error: unknown) => error instanceof ContactBlockedError && error.reason === "archived",
    );
    assert.throws(() => doNotContact.assertContactAllowed("00000000-0000-4000-8000-000000000074"), LeadNotFoundError);
  } finally {
    database.close();
  }
});

test("guard and query fail closed when suppression storage is unavailable or malformed", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  const doNotContact = service(database);
  try {
    database.exec("DROP TABLE lead_contact_suppressions");
    assert.throws(() => doNotContact.assertContactAllowed(leadId), ContactProtectionUnavailableError);
    assert.throws(() => doNotContact.getSuppression(leadId), ContactProtectionUnavailableError);
  } finally {
    database.close();
  }

  const malformedDatabase = createDatabase({ url: "file::memory:" });
  migrate(malformedDatabase);
  createLead(malformedDatabase);
  try {
    malformedDatabase.exec("PRAGMA ignore_check_constraints = ON");
    malformedDatabase.run(
      `INSERT INTO lead_contact_suppressions (
        lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      ) VALUES (?, ?, ?, ?, ?)`,
      [leadId, "invalid", "not-a-date", "human", "actor"],
    );
    assert.throws(
      () => service(malformedDatabase).assertContactAllowed(leadId),
      ContactProtectionUnavailableError,
    );
  } finally {
    malformedDatabase.close();
  }
});

test("suppression survives reopen and remains independent from lead lifecycle and version", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-suppression-"));
  const url = `file:${join(directory, "suppression.sqlite")}` as const;
  try {
    const firstDatabase = createDatabase({ url });
    migrate(firstDatabase);
    const lead = createLead(firstDatabase);
    const applied = service(firstDatabase).applySuppression(lead.id, "requested", actor);
    const lifecycle = new LeadService(firstDatabase, {
      clock: () => new Date("2026-03-01T00:00:02.000Z"),
    });
    assert.deepEqual(lifecycle.getLead(lead.id), lead);
    const observed = lifecycle.setWebsiteObservation(
      lead.id,
      { presence: "missing" },
      lead.version,
      actor,
    );
    assert.deepEqual(service(firstDatabase).getSuppression(lead.id), {
      state: "suppressed",
      suppression: applied.suppression,
    });
    const archived = lifecycle.transitionLead(lead.id, "archived", observed.version, actor);
    const reopened = lifecycle.transitionLead(lead.id, "reviewing", archived.version, actor);
    assert.equal(applied.suppression.leadId, reopened.id);
    assert.equal(reopened.version, 4);
    firstDatabase.close();

    const secondDatabase = createDatabase({ url });
    migrate(secondDatabase);
    try {
      assert.deepEqual(service(secondDatabase).getSuppression(lead.id), {
        state: "suppressed",
        suppression: applied.suppression,
      });
      assert.equal(new LeadService(secondDatabase).getLead(lead.id).version, 4);
    } finally {
      secondDatabase.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archived leads may be suppressed without changing lead data", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  const lead = createLead(database);
  const lifecycle = new LeadService(database, {
    clock: () => new Date("2026-03-01T00:00:02.000Z"),
  });
  const archived = lifecycle.transitionLead(lead.id, "archived", lead.version, actor);
  try {
    assert.equal(service(database).applySuppression(lead.id, "manual", actor).changed, true);
    assert.deepEqual(lifecycle.getLead(lead.id), archived);
  } finally {
    database.close();
  }
});

test("audit failure rolls back suppression and a retry creates one row and event", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  try {
    database.exec(`
      CREATE TRIGGER audit_events_reject_suppression_test
      BEFORE INSERT ON audit_events
      WHEN NEW.event_type = 'lead.do_not_contact_applied'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit failure');
      END;
    `);
    assert.throws(
      () => service(database).applySuppression(leadId, "manual", actor),
      ContactProtectionUnavailableError,
    );
    assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM lead_contact_suppressions")?.count, 0);
    assert.equal(eventCount(database), 1);

    database.exec("DROP TRIGGER audit_events_reject_suppression_test");
    assert.equal(service(database).applySuppression(leadId, "manual", actor).changed, true);
    assert.equal(eventCount(database), 2);
  } finally {
    database.close();
  }
});

test("suppression insert failure creates no event", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  try {
    database.exec(`
      CREATE TRIGGER lead_contact_suppressions_reject_test
      BEFORE INSERT ON lead_contact_suppressions
      BEGIN
        SELECT RAISE(ABORT, 'simulated suppression failure');
      END;
    `);
    assert.throws(
      () => service(database).applySuppression(leadId, "manual", actor),
      ContactProtectionUnavailableError,
    );
    assert.equal(eventCount(database), 1);
  } finally {
    database.close();
  }
});

test("two service instances cannot create duplicate suppression rows or events", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  try {
    const first = service(database).applySuppression(leadId, "manual", actor);
    const second = service(database, "2026-03-01T00:00:02.000Z")
      .applySuppression(leadId, "requested", { type: "system", id: "second" });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM lead_contact_suppressions")?.count, 1);
    assert.equal(eventCount(database), 2);
  } finally {
    database.close();
  }
});

test("an insert-time uniqueness winner is returned without a duplicate audit event", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  try {
    database.exec(`
      CREATE TRIGGER lead_contact_suppressions_simulate_winner
      BEFORE INSERT ON lead_contact_suppressions
      BEGIN
        INSERT INTO lead_contact_suppressions (
          lead_id, reason_code, applied_at, applied_by_type, applied_by_id
        ) VALUES (
          NEW.lead_id, 'requested', '2026-03-01T00:00:00.500Z', 'system', 'winner'
        );
      END;
    `);
    const result = service(database).applySuppression(leadId, "manual", actor);
    assert.equal(result.changed, false);
    assert.deepEqual(result.suppression, {
      leadId,
      reasonCode: "requested",
      appliedAt: "2026-03-01T00:00:00.500Z",
      appliedBy: { type: "system", id: "winner" },
    });
    assert.equal(eventCount(database), 1);
  } finally {
    database.close();
  }
});

test("suppression uses bound data, stores no sensitive payload, and performs no network operation", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrate(database);
  createLead(database);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (() => {
    requests += 1;
    throw new Error("network not allowed");
  }) as typeof fetch;
  try {
    const punctuatedActor = "reviewer'; DROP TABLE business_leads;--";
    service(database).applySuppression(leadId, "requested", {
      type: "human",
      id: punctuatedActor,
    });
    const stored = database.get<Record<string, unknown>>(
      "SELECT * FROM lead_contact_suppressions WHERE lead_id = ?",
      [leadId],
    );
    assert.equal(stored?.applied_by_id, punctuatedActor);
    assert.deepEqual(Object.keys(stored ?? {}).sort(), [
      "applied_at",
      "applied_by_id",
      "applied_by_type",
      "lead_id",
      "reason_code",
    ]);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
