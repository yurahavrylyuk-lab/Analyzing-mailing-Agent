import type { BusinessLead } from "../leads/domain";
import { leadFromRow } from "../leads/database-lead-repository";
import { CRAWL_CANDIDATE_WHERE_SQL } from "./candidate-filter";
import {
  EVIDENCE_INSERT_SQL,
  EVIDENCE_SELECT_BY_ID_SQL,
  evidenceFromRow,
  evidenceInsertParameters,
} from "./database-evidence-repository";
import {
  CrawlEvidencePersistenceError,
  normalizeSinglePageCrawlEvidence,
  type StoredSinglePageCrawlEvidence,
} from "./evidence-domain";
import { CrawlRunError } from "./run-loop";

export type D1CrawlDatabase = {
  prepare(sql: string): D1CrawlStatement;
};

type D1CrawlStatement = {
  bind(...values: readonly unknown[]): D1CrawlStatement;
  all(): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{
    readonly meta: {
      readonly changes: number;
      readonly last_row_id: number;
    };
  }>;
};

const CANDIDATE_SQL = `
SELECT id, business_name, source_kind, source_provider, source_reference,
       status, website_presence, website_url, created_at, updated_at, version
FROM business_leads
WHERE ${CRAWL_CANDIDATE_WHERE_SQL}
ORDER BY created_at ASC, id ASC
LIMIT ?
`;

const LEAD_PRESENT_SQL = "SELECT 1 AS present FROM business_leads WHERE id = ?";

function selectionFailed(): never {
  throw new CrawlRunError("SELECTION_FAILED");
}

function persistenceFailed(): never {
  throw new CrawlEvidencePersistenceError("PERSISTENCE_FAILED");
}

function isStoredRowId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function selectD1CrawlCandidates(
  database: D1CrawlDatabase,
  maxAttempts: number,
): Promise<readonly BusinessLead[]> {
  const statement = database.prepare(CANDIDATE_SQL).bind(maxAttempts);
  let response: { readonly results: readonly Record<string, unknown>[] };
  try {
    response = await statement.all();
  } catch {
    selectionFailed();
  }

  const results = response.results;
  if (results.length > maxAttempts) {
    selectionFailed();
  }

  return Object.freeze(results.map((row) => leadFromRow(row as unknown as Parameters<typeof leadFromRow>[0])));
}

export async function persistD1CrawlEvidence(
  database: D1CrawlDatabase,
  input: unknown,
): Promise<StoredSinglePageCrawlEvidence> {
  const evidence = normalizeSinglePageCrawlEvidence(input);

  const presentStatement = database.prepare(LEAD_PRESENT_SQL).bind(evidence.leadId);
  let present: Record<string, unknown> | null;
  try {
    present = await presentStatement.first();
  } catch {
    persistenceFailed();
  }

  if (present == null) {
    throw new CrawlEvidencePersistenceError("LEAD_NOT_FOUND");
  }

  const insertStatement = database
    .prepare(EVIDENCE_INSERT_SQL)
    .bind(...evidenceInsertParameters(evidence));
  let inserted: {
    readonly meta: {
      readonly changes: number;
      readonly last_row_id: number;
    };
  };
  try {
    inserted = await insertStatement.run();
  } catch {
    persistenceFailed();
  }

  const insertedId = inserted.meta.last_row_id;
  if (inserted.meta.changes !== 1 || !isStoredRowId(insertedId)) {
    persistenceFailed();
  }

  const readStatement = database.prepare(EVIDENCE_SELECT_BY_ID_SQL).bind(insertedId);
  let row: Record<string, unknown> | null;
  try {
    row = await readStatement.first();
  } catch {
    persistenceFailed();
  }

  if (row == null) {
    persistenceFailed();
  }

  const stored = evidenceFromRow(row as unknown as Parameters<typeof evidenceFromRow>[0]);
  if (stored.id !== insertedId) {
    persistenceFailed();
  }
  return stored;
}
