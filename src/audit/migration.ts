import type { Database, Migration } from "../db";

export const auditEventsMigration: Migration = Object.freeze({
  id: "005-audit-events",
  up(database: Database) {
    database.exec(`
      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY,
        occurred_at TEXT NOT NULL
          CHECK (
            length(occurred_at) = 24
            AND occurred_at GLOB
              '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
            AND CAST(substr(occurred_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
            AND CAST(substr(occurred_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
            AND CAST(substr(occurred_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
            AND CAST(substr(occurred_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
            AND CAST(substr(occurred_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
            AND date(substr(occurred_at, 1, 10)) = substr(occurred_at, 1, 10)
            AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at
          ),
        event_type TEXT NOT NULL
          CHECK (
            length(trim(event_type)) > 0
            AND event_type IN (
              'lead.created',
              'lead.status_changed',
              'lead.website_observation_changed'
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
    `);
  },
});

export const auditMigrations: readonly Migration[] = Object.freeze([
  auditEventsMigration,
]);
