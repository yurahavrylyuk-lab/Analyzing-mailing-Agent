import type { Database, Migration } from "../db";

const PREREQUISITES_UNAVAILABLE =
  "Single-page crawl evidence migration prerequisites are unavailable.";
const FOREIGN_KEY_VALIDATION_FAILED =
  "Single-page crawl evidence migration foreign-key validation failed.";

const BUSINESS_LEAD_COLUMNS = Object.freeze([
  "id",
  "business_name",
  "source_kind",
  "source_provider",
  "source_reference",
  "status",
  "website_presence",
  "website_url",
  "created_at",
  "updated_at",
  "version",
] as const);

interface NamedObject {
  readonly name: string;
}

interface TableColumn {
  readonly name: string;
}

interface ForeignKeySetting {
  readonly foreign_keys: number;
}

function assertBusinessLeadsSchema(database: Database): void {
  const table = database.get<NamedObject>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ["business_leads"],
  );
  const columns = database
    .all<TableColumn>("PRAGMA table_info(business_leads)")
    .map((column) => column.name);

  if (
    table?.name !== "business_leads" ||
    columns.length !== BUSINESS_LEAD_COLUMNS.length ||
    columns.some((name, index) => name !== BUSINESS_LEAD_COLUMNS[index])
  ) {
    throw new Error(PREREQUISITES_UNAVAILABLE);
  }
}

function assertForeignKeysEnabledAndValid(database: Database): void {
  const enabled = database.get<ForeignKeySetting>("PRAGMA foreign_keys");
  if (enabled?.foreign_keys !== 1 || database.all("PRAGMA foreign_key_check").length !== 0) {
    throw new Error(FOREIGN_KEY_VALIDATION_FAILED);
  }
}

export const singlePageCrawlEvidenceMigration: Migration = Object.freeze({
  id: "022-single-page-crawl-evidence",
  up(database: Database) {
    assertBusinessLeadsSchema(database);
    assertForeignKeysEnabledAndValid(database);

    database.exec(`
      CREATE TABLE single_page_crawl_evidence (
        id INTEGER PRIMARY KEY,
        lead_id TEXT NOT NULL,
        lead_version INTEGER NOT NULL
          CHECK (typeof(lead_version) = 'integer' AND lead_version > 0),
        outcome TEXT NOT NULL
          CHECK (outcome IN ('fetched', 'failed')),
        requested_url TEXT NOT NULL
          CHECK (
            length(trim(requested_url)) > 0
            AND requested_url = trim(requested_url)
          ),
        attempted_at TEXT NOT NULL
          CHECK (
            length(attempted_at) = 24
            AND attempted_at GLOB
              '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
            AND CAST(substr(attempted_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
            AND CAST(substr(attempted_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
            AND CAST(substr(attempted_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
            AND CAST(substr(attempted_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
            AND CAST(substr(attempted_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
            AND date(substr(attempted_at, 1, 10)) = substr(attempted_at, 1, 10)
            AND strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) IS NOT NULL
            AND strftime('%Y-%m-%dT%H:%M:%fZ', attempted_at) = attempted_at
          ),
        final_url TEXT
          CHECK (
            final_url IS NULL
            OR (
              length(trim(final_url)) > 0
              AND final_url = trim(final_url)
            )
          ),
        status_code INTEGER,
        content_type TEXT,
        body_text TEXT,
        byte_length INTEGER,
        redirect_count INTEGER,
        failure_code TEXT,
        CHECK (
          (
            outcome = 'fetched'
            AND final_url IS NOT NULL
            AND status_code IS NOT NULL
            AND typeof(status_code) = 'integer'
            AND status_code = 200
            AND content_type IS NOT NULL
            AND content_type IN ('text/html', 'application/xhtml+xml')
            AND body_text IS NOT NULL
            AND byte_length IS NOT NULL
            AND typeof(byte_length) = 'integer'
            AND byte_length >= 0
            AND byte_length <= 1048576
            AND byte_length = length(CAST(body_text AS BLOB))
            AND redirect_count IS NOT NULL
            AND typeof(redirect_count) = 'integer'
            AND redirect_count >= 0
            AND redirect_count <= 5
            AND failure_code IS NULL
          )
          OR
          (
            outcome = 'failed'
            AND final_url IS NULL
            AND status_code IS NULL
            AND content_type IS NULL
            AND body_text IS NULL
            AND byte_length IS NULL
            AND redirect_count IS NULL
            AND failure_code IS NOT NULL
            AND failure_code IN (
              'INVALID_URL',
              'UNSUPPORTED_SCHEME',
              'CREDENTIALS_NOT_ALLOWED',
              'PORT_NOT_ALLOWED',
              'BLOCKED_HOST',
              'BLOCKED_ADDRESS',
              'DNS_RESOLUTION_FAILED',
              'CANCELLED',
              'TIMEOUT',
              'NETWORK_FAILURE',
              'REDIRECT_LIMIT',
              'REDIRECT_DOWNGRADE',
              'HTTP_FAILURE',
              'UNSUPPORTED_CONTENT_TYPE',
              'UNSUPPORTED_CONTENT_ENCODING',
              'RESPONSE_TOO_LARGE',
              'INVALID_BODY'
            )
          )
        ),
        FOREIGN KEY (lead_id) REFERENCES business_leads(id)
          ON DELETE RESTRICT
          ON UPDATE RESTRICT
      );

      CREATE TRIGGER single_page_crawl_evidence_prevent_update
      BEFORE UPDATE ON single_page_crawl_evidence
      BEGIN
        SELECT RAISE(ABORT, 'single_page_crawl_evidence is append-only');
      END;

      CREATE TRIGGER single_page_crawl_evidence_prevent_delete
      BEFORE DELETE ON single_page_crawl_evidence
      BEGIN
        SELECT RAISE(ABORT, 'single_page_crawl_evidence is append-only');
      END;
    `);
  },
});

export const crawlerMigrations: readonly Migration[] = Object.freeze([
  singlePageCrawlEvidenceMigration,
]);
