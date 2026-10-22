import type { Database } from "../db";
import { DatabaseLeadRepository } from "../leads/database-lead-repository";
import type { BusinessLead } from "../leads/domain";
import { LeadPersistenceError } from "../leads/errors";
import { CRAWL_CANDIDATE_WHERE_SQL } from "./candidate-filter";
import { SinglePageCrawlEvidenceService } from "./evidence-service";
import { collectSinglePageCrawlEvidence } from "./single-page-evidence";
import {
  CrawlRunError,
  runBoundedSinglePageCrawlWithDependencies,
  type SinglePageCrawlRunRequest,
  type SinglePageCrawlRunResult,
} from "./run-loop";

export {
  CrawlRunError,
  type SinglePageCrawlRunRequest,
  type SinglePageCrawlRunResult,
  type SinglePageCrawlRunStop,
  type SinglePageCrawlRunSummary,
} from "./run-loop";

const CANDIDATE_IDS_SQL = `
SELECT id
FROM business_leads
WHERE ${CRAWL_CANDIDATE_WHERE_SQL}
ORDER BY created_at ASC, id ASC
LIMIT ?
`;

function isSqliteError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "SqliteError";
}

function isClosedDatabaseError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "The database connection is not open";
}

export function selectCandidates(database: Database, maxAttempts: number): readonly BusinessLead[] {
  const repository = new DatabaseLeadRepository(database);

  try {
    return database.transaction(() => {
      const rows = database.all<{ readonly id: unknown }>(CANDIDATE_IDS_SQL, [maxAttempts]);
      if (rows.length > maxAttempts) {
        throw new CrawlRunError("SELECTION_FAILED");
      }

      const snapshots: BusinessLead[] = [];
      for (const row of rows) {
        if (typeof row.id !== "string") {
          throw new CrawlRunError("SELECTION_FAILED");
        }

        const lead = repository.findById(row.id);
        if (lead === undefined) {
          throw new CrawlRunError("SELECTION_FAILED");
        }

        snapshots.push(lead);
      }

      return Object.freeze([...snapshots]);
    });
  } catch (error) {
    if (error instanceof CrawlRunError || error instanceof LeadPersistenceError) {
      throw error;
    }
    if (isSqliteError(error) || isClosedDatabaseError(error)) {
      throw new CrawlRunError("SELECTION_FAILED");
    }
    throw error;
  }
}

export function runBoundedSinglePageCrawl(
  database: Database,
  request: SinglePageCrawlRunRequest,
): Promise<SinglePageCrawlRunResult> {
  const evidence = new SinglePageCrawlEvidenceService(database);
  return runBoundedSinglePageCrawlWithDependencies(request, {
    select: (maxAttempts) => selectCandidates(database, maxAttempts),
    collect: collectSinglePageCrawlEvidence,
    persist: (value) => evidence.persist(value),
  });
}
