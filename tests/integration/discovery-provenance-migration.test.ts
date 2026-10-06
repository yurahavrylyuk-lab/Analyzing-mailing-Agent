import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DatabaseAuditRepository, auditMigrations } from "../../src/audit";
import { complianceMigrations } from "../../src/compliance";
import {
  applyMigrations,
  createDatabase,
  type Database,
  type RunResult,
  type SqlParameters,
} from "../../src/db";
import {
  businessLeadsMigration,
  discoveryLeadProvenanceMigration,
  leadMigrations,
} from "../../src/leads";

const ids = [
  "00000000-0000-4000-8000-000000000111",
  "00000000-0000-4000-8000-000000000112",
  "00000000-0000-4000-8000-000000000113",
] as const;

function migrateThrough007(database: Database): void {
  applyMigrations(database, [
    businessLeadsMigration,
    ...auditMigrations,
    ...complianceMigrations,
  ]);
}

function seedLead(
  database: Database,
  id: string,
  status: "recorded" | "reviewing" | "archived",
  presence: "unknown" | "present" | "missing",
  reference: string,
): void {
  database.run(
    `INSERT INTO business_leads (
      id, business_name, source_kind, source_reference, status,
      website_presence, website_url, created_at, updated_at, version
    ) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `Business ${id.slice(-3)}`,
      reference,
      status,
      presence,
      presence === "present" ? "https://example.com/" : null,
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:00:01.000Z",
      status === "recorded" ? 1 : 3,
    ],
  );
  new DatabaseAuditRepository(database).append({
    occurredAt: "2026-04-01T00:00:00.000Z",
    eventType: "lead.created",
    entityType: "business_lead",
    entityId: id,
    actor: { type: "system", id: "migration-fixture" },
    details: { initialStatus: "recorded", initialWebsitePresence: presence, version: 1 },
  });
}

function temporaryObjects(database: Database): string[] {
  return database
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name LIKE '%dq011%' ORDER BY name",
    )
    .map(({ name }) => name);
}

class FailingExecDatabase implements Database {
  constructor(
    private readonly delegate: Database,
    private readonly marker: string,
  ) {}

  exec(sql: string): void {
    this.delegate.exec(sql);
    if (sql.includes(this.marker)) {
      throw new Error("injected DQ-011 migration failure");
    }
  }

  run(sql: string, parameters?: SqlParameters): RunResult {
    return this.delegate.run(sql, parameters);
  }

  get<T>(sql: string, parameters?: SqlParameters): T | undefined {
    return this.delegate.get<T>(sql, parameters);
  }

  all<T>(sql: string, parameters?: SqlParameters): T[] {
    return this.delegate.all<T>(sql, parameters);
  }

  transaction<T>(operation: () => T): T {
    return this.delegate.transaction(operation);
  }

  close(): void {
    this.delegate.close();
  }
}

test("migration 011 applies after 004, 005, and 007 and is idempotent", () => {
  const database = createDatabase({ url: "file::memory:" });
  try {
    assert.deepEqual(
      applyMigrations(database, [...leadMigrations, ...auditMigrations, ...complianceMigrations]),
      [
        "004-business-leads",
        "005-audit-events",
        "007-do-not-contact",
        "011-discovery-lead-provenance",
      ],
    );
    assert.deepEqual(
      applyMigrations(database, [...leadMigrations, ...auditMigrations, ...complianceMigrations]),
      [],
    );
    assert.equal(
      database.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys,
      1,
    );
    assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    assert.equal(
      database.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'business_leads_discovery_identity_idx'",
      )?.name,
      "business_leads_discovery_identity_idx",
    );
  } finally {
    database.close();
  }
});

test("migration 011 preserves leads, suppressions, audits, protections, and historical manual values", () => {
  const database = createDatabase({ url: "file::memory:" });
  migrateThrough007(database);
  const longManualReference = "m".repeat(600);
  seedLead(database, ids[0], "recorded", "unknown", "duplicate-manual");
  seedLead(database, ids[1], "reviewing", "present", "duplicate-manual");
  seedLead(database, ids[2], "archived", "missing", longManualReference);
  database.run(
    `INSERT INTO lead_contact_suppressions (
      lead_id, reason_code, applied_at, applied_by_type, applied_by_id
    ) VALUES (?, ?, ?, ?, ?)`,
    [ids[2], "requested", "2026-04-01T00:00:02.000Z", "human", "reviewer"],
  );
  const leadsBefore = database.all("SELECT * FROM business_leads ORDER BY id");
  const auditsBefore = database.all("SELECT * FROM audit_events ORDER BY id");
  const suppressionsBefore = database.all("SELECT * FROM lead_contact_suppressions ORDER BY lead_id");

  try {
    assert.deepEqual(applyMigrations(database, [discoveryLeadProvenanceMigration]), [
      "011-discovery-lead-provenance",
    ]);
    const leadsAfter = database.all<Record<string, unknown>>(
      "SELECT * FROM business_leads ORDER BY id",
    );
    assert.deepEqual(
      leadsAfter.map(({ source_provider: _provider, ...lead }) => lead),
      leadsBefore,
    );
    assert.ok(leadsAfter.every(({ source_provider }) => source_provider === null));
    assert.deepEqual(database.all("SELECT * FROM audit_events ORDER BY id"), auditsBefore);
    assert.deepEqual(
      database.all("SELECT * FROM lead_contact_suppressions ORDER BY lead_id"),
      suppressionsBefore,
    );
    assert.deepEqual(temporaryObjects(database), []);
    assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    assert.equal(
      database.get<{ table: string }>("PRAGMA foreign_key_list(lead_contact_suppressions)")?.table,
      "business_leads",
    );
    assert.throws(() =>
      database.run(
        `INSERT INTO lead_contact_suppressions (
          lead_id, reason_code, applied_at, applied_by_type, applied_by_id
        ) VALUES (?, 'manual', '2026-04-01T00:00:00.000Z', 'human', 'reviewer')`,
        ["00000000-0000-4000-8000-000000000199"],
      ),
    );
    assert.throws(() =>
      database.run("UPDATE lead_contact_suppressions SET reason_code = 'manual' WHERE lead_id = ?", [ids[2]]),
    );
    assert.throws(() =>
      database.run("DELETE FROM lead_contact_suppressions WHERE lead_id = ?", [ids[2]]),
    );
    assert.throws(() => database.run("DELETE FROM business_leads WHERE id = ?", [ids[2]]));
    assert.throws(() => database.run("UPDATE audit_events SET actor_id = 'x' WHERE id = 1"));
    assert.throws(() => database.run("DELETE FROM audit_events WHERE id = 1"));
  } finally {
    database.close();
  }
});

for (const [name, marker] of [
  ["lead replacement", "ALTER TABLE business_leads_dq011_replacement"],
  ["suppression restoration", "FROM lead_contact_suppressions_dq011_backup"],
] as const) {
  test(`migration 011 rolls back an injected failure after ${name}`, () => {
    const database = createDatabase({ url: "file::memory:" });
    migrateThrough007(database);
    seedLead(database, ids[0], "recorded", "unknown", "historical");
    database.run(
      `INSERT INTO lead_contact_suppressions (
        lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      ) VALUES (?, 'manual', '2026-04-01T00:00:02.000Z', 'system', 'fixture')`,
      [ids[0]],
    );
    const failing = new FailingExecDatabase(database, marker);
    try {
      assert.throws(
        () => applyMigrations(failing, [discoveryLeadProvenanceMigration]),
        /injected DQ-011/u,
      );
      assert.deepEqual(
        database.all<{ name: string }>("PRAGMA table_info(business_leads)").map(({ name }) => name),
        [
          "id", "business_name", "source_kind", "source_reference", "status",
          "website_presence", "website_url", "created_at", "updated_at", "version",
        ],
      );
      assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM business_leads")?.count, 1);
      assert.equal(database.get<{ count: number }>("SELECT count(*) AS count FROM lead_contact_suppressions")?.count, 1);
      assert.equal(
        database.get("SELECT id FROM schema_migrations WHERE id = '011-discovery-lead-provenance'"),
        undefined,
      );
      assert.deepEqual(temporaryObjects(database), []);
      assert.deepEqual(database.all("PRAGMA foreign_key_check"), []);
    } finally {
      database.close();
    }
  });
}

test("migration 011 fails safely when prerequisite schema is missing", () => {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, [businessLeadsMigration]);
  try {
    assert.throws(() => applyMigrations(database, [discoveryLeadProvenanceMigration]));
    assert.equal(
      database.get("SELECT id FROM schema_migrations WHERE id = '011-discovery-lead-provenance'"),
      undefined,
    );
    assert.deepEqual(temporaryObjects(database), []);
  } finally {
    database.close();
  }
});
