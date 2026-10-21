import type { Database } from "../db";
import { DatabaseLeadRepository } from "../leads/database-lead-repository";
import type { BusinessLead } from "../leads/domain";
import { LeadPersistenceError } from "../leads/errors";
import type { StoredSinglePageCrawlEvidence } from "./evidence-domain";
import { SinglePageCrawlEvidenceService } from "./evidence-service";
import {
  collectSinglePageCrawlEvidence,
  type SinglePageCrawlEvidence,
} from "./single-page-evidence";

const MIN_SINGLE_PAGE_CRAWL_ATTEMPTS = 1;
const MAX_SINGLE_PAGE_CRAWL_ATTEMPTS = 60;

const CRAWL_RUN_ERROR_MESSAGES = {
  INVALID_REQUEST: "Crawl run request is invalid.",
  SELECTION_FAILED: "Crawl candidate selection failed.",
} as const;

const CANDIDATE_IDS_SQL = `
SELECT id
FROM business_leads
WHERE status IN ('recorded', 'reviewing')
  AND website_presence = 'present'
  AND website_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM single_page_crawl_evidence AS evidence
    WHERE evidence.lead_id = business_leads.id
      AND evidence.requested_url = business_leads.website_url
      AND (
        evidence.outcome = 'fetched'
        OR evidence.failure_code <> 'CANCELLED'
      )
  )
ORDER BY created_at ASC, id ASC
LIMIT ?
`;

export type SinglePageCrawlRunRequest = Readonly<{
  maxAttempts: number;
  signal: AbortSignal;
}>;

export type SinglePageCrawlRunSummary = Readonly<{
  selected: number;
  attempted: number;
  fetched: number;
  failed: number;
  persisted: number;
}>;

export type SinglePageCrawlRunStop =
  | Readonly<{
      status: "completed";
      reason: "budget_exhausted" | "candidates_exhausted";
    }>
  | Readonly<{
      status: "cancelled";
      reason: "cancelled";
    }>;

export type SinglePageCrawlRunResult = Readonly<{
  summary: SinglePageCrawlRunSummary;
  stop: SinglePageCrawlRunStop;
}>;

export type SinglePageCrawlRunDependencies = Readonly<{
  select?: (maxAttempts: number) => readonly BusinessLead[];
  collect: (
    lead: BusinessLead,
    signal: AbortSignal,
  ) => Promise<SinglePageCrawlEvidence>;
  persist: (evidence: SinglePageCrawlEvidence) => StoredSinglePageCrawlEvidence;
}>;

type CrawlRunCounts = {
  selected: number;
  attempted: number;
  fetched: number;
  failed: number;
  persisted: number;
};

export class CrawlRunError extends Error {
  readonly name = "CrawlRunError";

  constructor(readonly code: "INVALID_REQUEST" | "SELECTION_FAILED") {
    super(CRAWL_RUN_ERROR_MESSAGES[code]);
  }
}

function isSqliteError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "SqliteError";
}

function isClosedDatabaseError(error: unknown): boolean {
  return error instanceof TypeError && error.message === "The database connection is not open";
}

function zeroCounts(): CrawlRunCounts {
  return {
    selected: 0,
    attempted: 0,
    fetched: 0,
    failed: 0,
    persisted: 0,
  };
}

function summaryOf(counts: CrawlRunCounts): SinglePageCrawlRunSummary {
  return Object.freeze({
    selected: counts.selected,
    attempted: counts.attempted,
    fetched: counts.fetched,
    failed: counts.failed,
    persisted: counts.persisted,
  });
}

function cancelledResult(counts: CrawlRunCounts): SinglePageCrawlRunResult {
  return Object.freeze({
    summary: summaryOf(counts),
    stop: Object.freeze({
      status: "cancelled" as const,
      reason: "cancelled" as const,
    }),
  });
}

function completedResult(
  counts: CrawlRunCounts,
  reason: "budget_exhausted" | "candidates_exhausted",
): SinglePageCrawlRunResult {
  return Object.freeze({
    summary: summaryOf(counts),
    stop: Object.freeze({
      status: "completed" as const,
      reason,
    }),
  });
}

function assertValidRequest(request: SinglePageCrawlRunRequest): void {
  if (typeof request !== "object" || request === null) {
    throw new CrawlRunError("INVALID_REQUEST");
  }

  const { maxAttempts, signal } = request;
  if (
    typeof maxAttempts !== "number" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < MIN_SINGLE_PAGE_CRAWL_ATTEMPTS ||
    maxAttempts > MAX_SINGLE_PAGE_CRAWL_ATTEMPTS ||
    !(signal instanceof AbortSignal)
  ) {
    throw new CrawlRunError("INVALID_REQUEST");
  }
}

function selectCandidates(database: Database, maxAttempts: number): readonly BusinessLead[] {
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

export async function runBoundedSinglePageCrawlWithDependencies(
  database: Database,
  request: SinglePageCrawlRunRequest,
  dependencies: SinglePageCrawlRunDependencies,
): Promise<SinglePageCrawlRunResult> {
  assertValidRequest(request);
  if (request.signal.aborted) {
    return cancelledResult(zeroCounts());
  }

  const select = dependencies.select ?? ((maxAttempts: number) => selectCandidates(database, maxAttempts));
  const snapshots = select(request.maxAttempts);
  const counts = zeroCounts();
  counts.selected = snapshots.length;

  for (const snapshot of snapshots) {
    if (request.signal.aborted) {
      return cancelledResult(counts);
    }

    let cancelledAttempt = false;
    {
      const evidence = await dependencies.collect(snapshot, request.signal);
      dependencies.persist(evidence);
      counts.attempted += 1;
      counts.persisted += 1;
      if (evidence.outcome === "fetched") {
        counts.fetched += 1;
      } else {
        counts.failed += 1;
        cancelledAttempt = evidence.failure === "CANCELLED";
      }
    }

    if (cancelledAttempt) {
      return cancelledResult(counts);
    }
    if (request.signal.aborted) {
      return cancelledResult(counts);
    }
  }

  if (counts.selected === request.maxAttempts) {
    return completedResult(counts, "budget_exhausted");
  }

  return completedResult(counts, "candidates_exhausted");
}

export function runBoundedSinglePageCrawl(
  database: Database,
  request: SinglePageCrawlRunRequest,
): Promise<SinglePageCrawlRunResult> {
  const evidence = new SinglePageCrawlEvidenceService(database);
  return runBoundedSinglePageCrawlWithDependencies(database, request, {
    select: (maxAttempts) => selectCandidates(database, maxAttempts),
    collect: collectSinglePageCrawlEvidence,
    persist: (value) => evidence.persist(value),
  });
}
