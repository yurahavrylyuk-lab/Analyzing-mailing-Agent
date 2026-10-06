import type { Database, Migration } from "../db";

export const businessLeadsMigration: Migration = Object.freeze({
  id: "004-business-leads",
  up(database: Database) {
    database.exec(`
      CREATE TABLE business_leads (
        id TEXT PRIMARY KEY NOT NULL,
        business_name TEXT NOT NULL
          CHECK (length(trim(business_name)) > 0 AND business_name = trim(business_name)),
        source_kind TEXT NOT NULL
          CHECK (source_kind = 'manual'),
        source_reference TEXT NOT NULL
          CHECK (length(trim(source_reference)) > 0 AND source_reference = trim(source_reference)),
        status TEXT NOT NULL
          CHECK (status IN ('recorded', 'reviewing', 'archived')),
        website_presence TEXT NOT NULL
          CHECK (website_presence IN ('unknown', 'present', 'missing')),
        website_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
          CHECK (typeof(version) = 'integer' AND version > 0),
        CHECK (
          (website_presence = 'present' AND website_url IS NOT NULL AND length(trim(website_url)) > 0)
          OR
          (website_presence IN ('unknown', 'missing') AND website_url IS NULL)
        )
      )
    `);
  },
});

const canonicalTimestampCheck = (column: string): string => `
  length(${column}) = 24
  AND ${column} GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  AND CAST(substr(${column}, 6, 2) AS INTEGER) BETWEEN 1 AND 12
  AND CAST(substr(${column}, 9, 2) AS INTEGER) BETWEEN 1 AND 31
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND date(substr(${column}, 1, 10)) = substr(${column}, 1, 10)
  AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) IS NOT NULL
  AND strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
`;

interface NamedObject {
  readonly name: string;
}

interface TableColumn {
  readonly name: string;
}

function requireTable(database: Database, name: string, columns: readonly string[]): void {
  const table = database.get<NamedObject>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  const actualColumns = database
    .all<TableColumn>(`PRAGMA table_info(${name})`)
    .map(({ name: columnName }) => columnName);
  if (table?.name !== name || actualColumns.join("|") !== columns.join("|")) {
    throw new Error("Discovery provenance migration prerequisites are unavailable.");
  }
}

function requireObject(database: Database, type: "index" | "trigger", name: string): void {
  if (
    database.get<NamedObject>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      [type, name],
    )?.name !== name
  ) {
    throw new Error("Discovery provenance migration prerequisites are unavailable.");
  }
}

function assertForeignKeysEnabledAndValid(database: Database): void {
  const enabled = database.get<{ readonly foreign_keys: number }>("PRAGMA foreign_keys");
  if (enabled?.foreign_keys !== 1 || database.all("PRAGMA foreign_key_check").length !== 0) {
    throw new Error("Discovery provenance migration foreign-key validation failed.");
  }
}

export const discoveryLeadProvenanceMigration: Migration = Object.freeze({
  id: "011-discovery-lead-provenance",
  up(database: Database) {
    requireTable(database, "business_leads", [
      "id",
      "business_name",
      "source_kind",
      "source_reference",
      "status",
      "website_presence",
      "website_url",
      "created_at",
      "updated_at",
      "version",
    ]);
    requireTable(database, "lead_contact_suppressions", [
      "lead_id",
      "reason_code",
      "applied_at",
      "applied_by_type",
      "applied_by_id",
    ]);
    requireTable(database, "audit_events", [
      "id",
      "occurred_at",
      "event_type",
      "entity_type",
      "entity_id",
      "actor_type",
      "actor_id",
      "details_json",
    ]);
    requireObject(database, "trigger", "lead_contact_suppressions_prevent_update");
    requireObject(database, "trigger", "lead_contact_suppressions_prevent_delete");
    requireObject(database, "index", "audit_events_entity_history_idx");
    requireObject(database, "trigger", "audit_events_prevent_update");
    requireObject(database, "trigger", "audit_events_prevent_delete");
    assertForeignKeysEnabledAndValid(database);

    database.exec(`
      CREATE TABLE lead_contact_suppressions_dq011_backup (
        lead_id TEXT PRIMARY KEY NOT NULL,
        reason_code TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        applied_by_type TEXT NOT NULL,
        applied_by_id TEXT NOT NULL
      )
    `);
    database.exec(`
      INSERT INTO lead_contact_suppressions_dq011_backup (
        lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      )
      SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions
    `);
    database.exec(`
      CREATE TABLE business_leads_dq011_replacement (
        id TEXT PRIMARY KEY NOT NULL,
        business_name TEXT NOT NULL
          CHECK (length(trim(business_name)) > 0 AND business_name = trim(business_name)),
        source_kind TEXT NOT NULL
          CHECK (source_kind IN ('manual', 'discovery')),
        source_provider TEXT,
        source_reference TEXT NOT NULL
          CHECK (length(trim(source_reference)) > 0 AND source_reference = trim(source_reference)),
        status TEXT NOT NULL
          CHECK (status IN ('recorded', 'reviewing', 'archived')),
        website_presence TEXT NOT NULL
          CHECK (website_presence IN ('unknown', 'present', 'missing')),
        website_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
          CHECK (typeof(version) = 'integer' AND version > 0),
        CHECK (
          (website_presence = 'present' AND website_url IS NOT NULL AND length(trim(website_url)) > 0)
          OR
          (website_presence IN ('unknown', 'missing') AND website_url IS NULL)
        ),
        CHECK (
          (source_kind = 'manual' AND source_provider IS NULL)
          OR
          (
            source_kind = 'discovery'
            AND source_provider IS NOT NULL
            AND length(source_provider) BETWEEN 1 AND 64
            AND substr(source_provider, 1, 1) GLOB '[a-z]'
            AND source_provider NOT GLOB '*[^a-z0-9_]*'
            AND length(source_reference) <= 512
          )
        )
      )
    `);
    database.exec(`
      INSERT INTO business_leads_dq011_replacement (
        id, business_name, source_kind, source_provider, source_reference,
        status, website_presence, website_url, created_at, updated_at, version
      )
      SELECT
        id, business_name, source_kind, NULL, source_reference,
        status, website_presence, website_url, created_at, updated_at, version
      FROM business_leads
    `);
    database.exec("DROP TRIGGER lead_contact_suppressions_prevent_update");
    database.exec("DROP TRIGGER lead_contact_suppressions_prevent_delete");
    database.exec("DROP TABLE lead_contact_suppressions");
    database.exec("DROP TABLE business_leads");
    database.exec(
      "ALTER TABLE business_leads_dq011_replacement RENAME TO business_leads",
    );
    database.exec(`
      CREATE UNIQUE INDEX business_leads_discovery_identity_idx
      ON business_leads (source_provider, source_reference)
      WHERE source_kind = 'discovery'
    `);
    database.exec(`
      CREATE TABLE lead_contact_suppressions (
        lead_id TEXT PRIMARY KEY NOT NULL,
        reason_code TEXT NOT NULL
          CHECK (reason_code IN ('manual', 'requested')),
        applied_at TEXT NOT NULL CHECK (${canonicalTimestampCheck("applied_at")}),
        applied_by_type TEXT NOT NULL
          CHECK (applied_by_type IN ('human', 'system')),
        applied_by_id TEXT NOT NULL
          CHECK (
            length(trim(applied_by_id)) > 0
            AND applied_by_id = trim(applied_by_id)
            AND length(applied_by_id) <= 128
          ),
        FOREIGN KEY (lead_id) REFERENCES business_leads(id)
          ON DELETE RESTRICT
          ON UPDATE RESTRICT
      )
    `);
    database.exec(`
      INSERT INTO lead_contact_suppressions (
        lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      )
      SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions_dq011_backup
    `);
    database.exec(`
      CREATE TRIGGER lead_contact_suppressions_prevent_update
      BEFORE UPDATE ON lead_contact_suppressions
      BEGIN
        SELECT RAISE(ABORT, 'lead_contact_suppressions is insert-only');
      END
    `);
    database.exec(`
      CREATE TRIGGER lead_contact_suppressions_prevent_delete
      BEFORE DELETE ON lead_contact_suppressions
      BEGIN
        SELECT RAISE(ABORT, 'lead_contact_suppressions is insert-only');
      END
    `);

    const differences = database.all(`
      SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions_dq011_backup
      EXCEPT
      SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions
      UNION ALL
      SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions
      EXCEPT
      SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions_dq011_backup
    `);
    if (differences.length !== 0) {
      throw new Error("Discovery provenance migration suppression verification failed.");
    }
    assertForeignKeysEnabledAndValid(database);
    database.exec("DROP TABLE lead_contact_suppressions_dq011_backup");
  },
});

export const leadMigrations: readonly Migration[] = Object.freeze([
  businessLeadsMigration,
  discoveryLeadProvenanceMigration,
]);
