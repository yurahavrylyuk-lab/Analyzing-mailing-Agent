import type { Database, Migration } from "../db";

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

export const doNotContactMigration: Migration = Object.freeze({
  id: "007-do-not-contact",
  up(database: Database) {
    database.exec(`
      DROP TRIGGER audit_events_prevent_update;
      DROP TRIGGER audit_events_prevent_delete;
      DROP INDEX audit_events_entity_history_idx;

      CREATE TABLE audit_events_replacement (
        id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL CHECK (${canonicalTimestampCheck("occurred_at")}),
        event_type TEXT NOT NULL
          CHECK (
            length(trim(event_type)) > 0
            AND event_type IN (
              'lead.created',
              'lead.status_changed',
              'lead.website_observation_changed',
              'lead.do_not_contact_applied'
            )
          ),
        entity_type TEXT NOT NULL
          CHECK (length(trim(entity_type)) > 0),
        entity_id TEXT NOT NULL
          CHECK (length(trim(entity_id)) > 0),
        actor_type TEXT NOT NULL
          CHECK (actor_type IN ('human', 'system')),
        actor_id TEXT NOT NULL
          CHECK (
            length(trim(actor_id)) > 0
            AND actor_id = trim(actor_id)
            AND length(actor_id) <= 128
          ),
        details_json TEXT NOT NULL
          CHECK (
            json_valid(details_json)
            AND json_type(details_json) = 'object'
            AND length(CAST(details_json AS BLOB)) <= 2048
          )
      );

      INSERT INTO audit_events_replacement (
        id, occurred_at, event_type, entity_type, entity_id,
        actor_type, actor_id, details_json
      )
      SELECT
        id, occurred_at, event_type, entity_type, entity_id,
        actor_type, actor_id, details_json
      FROM audit_events
      ORDER BY id;

      DROP TABLE audit_events;
      ALTER TABLE audit_events_replacement RENAME TO audit_events;

      CREATE INDEX audit_events_entity_history_idx
        ON audit_events (entity_type, entity_id, id);

      CREATE TRIGGER audit_events_prevent_update
      BEFORE UPDATE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only');
      END;

      CREATE TRIGGER audit_events_prevent_delete
      BEFORE DELETE ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'audit_events is append-only');
      END;

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
      );

      CREATE TRIGGER lead_contact_suppressions_prevent_update
      BEFORE UPDATE ON lead_contact_suppressions
      BEGIN
        SELECT RAISE(ABORT, 'lead_contact_suppressions is insert-only');
      END;

      CREATE TRIGGER lead_contact_suppressions_prevent_delete
      BEFORE DELETE ON lead_contact_suppressions
      BEGIN
        SELECT RAISE(ABORT, 'lead_contact_suppressions is insert-only');
      END;
    `);
  },
});

export const complianceMigrations: readonly Migration[] = Object.freeze([
  doNotContactMigration,
]);
