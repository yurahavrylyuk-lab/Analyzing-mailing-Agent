import type { BusinessLead } from "../leads/domain";
import type { StoredSinglePageCrawlEvidence } from "./evidence-domain";
import type { SinglePageCrawlEvidence } from "./single-page-evidence";

const MIN_SINGLE_PAGE_CRAWL_ATTEMPTS = 1;
const MAX_SINGLE_PAGE_CRAWL_ATTEMPTS = 60;

const CRAWL_RUN_ERROR_MESSAGES = {
  INVALID_REQUEST: "Crawl run request is invalid.",
  SELECTION_FAILED: "Crawl candidate selection failed.",
} as const;

type Awaitable<T> = T | Promise<T>;

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
  select: (maxAttempts: number) => Awaitable<readonly BusinessLead[]>;
  collect: (lead: BusinessLead, signal: AbortSignal) => Promise<SinglePageCrawlEvidence>;
  persist: (evidence: SinglePageCrawlEvidence) => Awaitable<StoredSinglePageCrawlEvidence>;
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

export async function runBoundedSinglePageCrawlWithDependencies(
  request: SinglePageCrawlRunRequest,
  dependencies: SinglePageCrawlRunDependencies,
): Promise<SinglePageCrawlRunResult> {
  assertValidRequest(request);
  if (request.signal.aborted) {
    return cancelledResult(zeroCounts());
  }

  const snapshots = await dependencies.select(request.maxAttempts);
  const counts = zeroCounts();
  counts.selected = snapshots.length;

  for (const snapshot of snapshots) {
    if (request.signal.aborted) {
      return cancelledResult(counts);
    }

    const evidence = await dependencies.collect(snapshot, request.signal);
    await dependencies.persist(evidence);
    counts.attempted += 1;
    counts.persisted += 1;
    let cancelledAttempt = false;
    if (evidence.outcome === "fetched") {
      counts.fetched += 1;
    } else {
      counts.failed += 1;
      cancelledAttempt = evidence.failure === "CANCELLED";
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
