import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { applyMigrations, createDatabase, type Database } from "../../src/db";
import { auditMigrations, type AuditActor } from "../../src/audit";
import { complianceMigrations } from "../../src/compliance";
import {
  ArchivedLeadWebsiteMutationError,
  InvalidLeadInputError,
  InvalidLeadTransitionError,
  LeadNotFoundError,
  LeadService,
  StaleLeadVersionError,
  businessLeadsMigration,
  leadMigrations,
  type CreateLeadInput,
  type LeadServiceOptions,
} from "../../src/leads";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
] as const;

const baseInput: CreateLeadInput = {
  businessName: "Example Business",
  sourceKind: "manual",
  sourceReference: "manual-entry",
  websiteObservation: { presence: "unknown" },
};

const actor: AuditActor = { type: "human", id: "lead-reviewer" };

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("Deterministic test sequence exhausted.");
    }
    index += 1;
    return value;
  };
}

function createHarness(options: LeadServiceOptions = {}) {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, [
    ...leadMigrations,
    ...auditMigrations,
    ...complianceMigrations,
  ]);
  const service = new LeadService(database, {
    idGenerator: options.idGenerator ?? sequence(ids),
    clock:
      options.clock ??
      sequence([
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:01.000Z"),
        new Date("2026-01-01T00:00:02.000Z"),
        new Date("2026-01-01T00:00:03.000Z"),
        new Date("2026-01-01T00:00:04.000Z"),
      ]),
  });

  return { database, service };
}

function tableNames(database: Database): string[] {
  return database
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name);
}

test("migration applies once and creates only the lead and migration tables", () => {
  const database = createDatabase({ url: "file::memory:" });

  try {
    assert.deepEqual(tableNames(database), []);
    assert.deepEqual(applyMigrations(database, [businessLeadsMigration]), ["004-business-leads"]);
    assert.deepEqual(applyMigrations(database, [businessLeadsMigration]), []);
    assert.deepEqual(tableNames(database), ["business_leads", "schema_migrations"]);
  } finally {
    database.close();
  }
});

test("creates and retrieves unknown, missing, and present observations", () => {
  const { database, service } = createHarness();

  try {
    const unknown = service.createLead(baseInput, actor);
    const missing = service.createLead({
      ...baseInput,
      websiteObservation: { presence: "missing" },
    }, actor);
    const present = service.createLead({
      ...baseInput,
      websiteObservation: { presence: "present", url: "HTTPS://Example.COM" },
    }, actor);

    assert.deepEqual(service.getLead(unknown.id).websiteObservation, { presence: "unknown" });
    assert.deepEqual(service.getLead(missing.id).websiteObservation, { presence: "missing" });
    assert.deepEqual(service.getLead(present.id).websiteObservation, {
      presence: "present",
      url: "https://example.com/",
    });
    assert.equal(unknown.id, ids[0]);
    assert.equal(unknown.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(unknown.status, "recorded");
    assert.equal(unknown.version, 1);
  } finally {
    database.close();
  }
});

test("does not add uniqueness constraints to lead identity fields", () => {
  const { database, service } = createHarness();
  const duplicateInput: CreateLeadInput = {
    ...baseInput,
    websiteObservation: { presence: "present", url: "https://example.com" },
  };

  try {
    assert.doesNotThrow(() => service.createLead(duplicateInput, actor));
    assert.doesNotThrow(() => service.createLead(duplicateInput, actor));
  } finally {
    database.close();
  }
});

test("persists a lead across file-backed database reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "delta-qoralis-leads-"));
  const url = `file:${join(directory, "leads.sqlite")}` as const;

  try {
    const firstDatabase = createDatabase({ url });
    applyMigrations(firstDatabase, [...leadMigrations, ...auditMigrations, ...complianceMigrations]);
    const firstService = new LeadService(firstDatabase, {
      idGenerator: () => ids[0],
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const created = firstService.createLead(baseInput, actor);
    firstDatabase.close();

    const reopenedDatabase = createDatabase({ url });
    try {
      applyMigrations(reopenedDatabase, [...leadMigrations, ...auditMigrations, ...complianceMigrations]);
      const reopenedService = new LeadService(reopenedDatabase);
      assert.deepEqual(reopenedService.getLead(created.id), created);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("database constraints reject inconsistent website storage", () => {
  const database = createDatabase({ url: "file::memory:" });
  applyMigrations(database, [businessLeadsMigration]);
  const commonValues = [
    ids[0],
    "Business",
    "manual",
    "source",
    "recorded",
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    1,
  ] as const;

  try {
    const insert = `INSERT INTO business_leads (
      id, business_name, source_kind, source_reference, status,
      website_presence, website_url, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    assert.throws(() =>
      database.run(insert, [
        ...commonValues.slice(0, 5),
        "present",
        null,
        ...commonValues.slice(5),
      ]),
    );
    assert.throws(() =>
      database.run(insert, [
        ids[1],
        ...commonValues.slice(1, 5),
        "missing",
        "https://example.com/",
        ...commonValues.slice(5),
      ]),
    );
  } finally {
    database.close();
  }
});

test("performs every valid lifecycle transition with one version increment", () => {
  const { database, service } = createHarness();

  try {
    const recorded = service.createLead(baseInput, actor);
    const reviewing = service.transitionLead(recorded.id, "reviewing", 1, actor);
    const archived = service.transitionLead(recorded.id, "archived", 2, actor);
    const restored = service.transitionLead(recorded.id, "reviewing", 3, actor);

    assert.deepEqual(
      [reviewing.status, archived.status, restored.status],
      ["reviewing", "archived", "reviewing"],
    );
    assert.deepEqual([reviewing.version, archived.version, restored.version], [2, 3, 4]);
    assert.deepEqual(
      [reviewing.updatedAt, archived.updatedAt, restored.updatedAt],
      [
        "2026-01-01T00:00:01.000Z",
        "2026-01-01T00:00:02.000Z",
        "2026-01-01T00:00:03.000Z",
      ],
    );
  } finally {
    database.close();
  }
});

test("invalid transitions leave the persisted lead unchanged", () => {
  const { database, service } = createHarness();

  try {
    const created = service.createLead(baseInput, actor);
    const reviewing = service.transitionLead(created.id, "reviewing", 1, actor);
    assert.throws(
      () => service.transitionLead(created.id, "recorded", 2, actor),
      InvalidLeadTransitionError,
    );
    assert.deepEqual(service.getLead(created.id), reviewing);
  } finally {
    database.close();
  }
});

test("same-state transitions are no-ops but still enforce expected version", () => {
  const { database, service } = createHarness();

  try {
    const created = service.createLead(baseInput, actor);
    assert.deepEqual(service.transitionLead(created.id, "recorded", 1, actor), created);
    const reviewing = service.transitionLead(created.id, "reviewing", 1, actor);
    assert.throws(
      () => service.transitionLead(created.id, "reviewing", 1, actor),
      StaleLeadVersionError,
    );
    assert.equal(reviewing.version, 2);
  } finally {
    database.close();
  }
});

test("website updates normalize values, preserve status, and no-op when identical", () => {
  const { database, service } = createHarness();

  try {
    const created = service.createLead(baseInput, actor);
    assert.deepEqual(
      service.setWebsiteObservation(created.id, { presence: "unknown" }, 1, actor),
      created,
    );

    const present = service.setWebsiteObservation(
      created.id,
      { presence: "present", url: "HTTPS://Example.COM" },
      1,
      actor,
    );
    assert.deepEqual(present.websiteObservation, {
      presence: "present",
      url: "https://example.com/",
    });
    assert.equal(present.status, "recorded");
    assert.equal(present.version, 2);
    assert.equal(present.updatedAt, "2026-01-01T00:00:01.000Z");
    assert.deepEqual(
      service.setWebsiteObservation(
        created.id,
        { presence: "present", url: "https://example.com/" },
        2,
        actor,
      ),
      present,
    );
  } finally {
    database.close();
  }
});

test("archived leads reject website observation updates", () => {
  const { database, service } = createHarness();

  try {
    const created = service.createLead(baseInput, actor);
    const archived = service.transitionLead(created.id, "archived", 1, actor);
    assert.throws(
      () =>
        service.setWebsiteObservation(
          created.id,
          { presence: "unknown" },
          archived.version,
          actor,
        ),
      ArchivedLeadWebsiteMutationError,
    );
    assert.deepEqual(service.getLead(created.id), archived);
  } finally {
    database.close();
  }
});

test("reports missing leads and rejects stale writes including identical updates", () => {
  const { database, service } = createHarness();

  try {
    assert.throws(() => service.getLead(ids[0]), LeadNotFoundError);
    const created = service.createLead(baseInput, actor);
    service.setWebsiteObservation(created.id, { presence: "missing" }, 1, actor);
    assert.throws(
      () => service.setWebsiteObservation(created.id, { presence: "missing" }, 1, actor),
      StaleLeadVersionError,
    );
  } finally {
    database.close();
  }
});

test("two mutations based on the same version cannot both succeed", () => {
  const { database, service } = createHarness();

  try {
    const created = service.createLead(baseInput, actor);
    service.transitionLead(created.id, "reviewing", created.version, actor);
    assert.throws(
      () =>
        service.setWebsiteObservation(
          created.id,
          { presence: "present", url: "https://example.com" },
          created.version,
          actor,
        ),
      StaleLeadVersionError,
    );
  } finally {
    database.close();
  }
});

test("service rejects unsafe website URLs without changing the lead", () => {
  const { database, service } = createHarness();

  try {
    const created = service.createLead(baseInput, actor);
    for (const url of [
      "relative/path",
      "ftp://example.com/file",
      "https://user:password@example.com/",
    ]) {
      assert.throws(
        () =>
          service.setWebsiteObservation(
            created.id,
            { presence: "present", url },
            created.version,
            actor,
          ),
        InvalidLeadInputError,
      );
    }
    assert.deepEqual(service.getLead(created.id), created);
  } finally {
    database.close();
  }
});
