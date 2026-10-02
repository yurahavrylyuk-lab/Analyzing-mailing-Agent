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

export const leadMigrations: readonly Migration[] = Object.freeze([
  businessLeadsMigration,
]);
