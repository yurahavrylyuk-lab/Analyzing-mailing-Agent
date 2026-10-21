import type { BusinessLead } from "../leads/domain";
import { NetworkTargetError, type NetworkTargetErrorCode } from "../network-safety/errors";
import type { CrawlPageContentType, CrawlPageResult } from "./domain";
import { CrawlPageError, type CrawlPageErrorCode } from "./errors";
import { fetchCrawlPage } from "./fetch-page";

export const CRAWL_EVIDENCE_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
] as const);

export type CrawlEvidenceErrorCode = (typeof CRAWL_EVIDENCE_ERROR_CODES)[number];

export class CrawlEvidenceError extends Error {
  readonly name: "CrawlEvidenceError" = "CrawlEvidenceError";

  constructor(readonly code: CrawlEvidenceErrorCode) {
    super("Crawl evidence request is invalid.");
  }
}

export type CrawlEvidenceFailureCode = NetworkTargetErrorCode | CrawlPageErrorCode;

export type FetchedCrawlEvidence = Readonly<{
  outcome: "fetched";
  leadId: string;
  leadVersion: number;
  requestedUrl: string;
  finalUrl: string;
  statusCode: 200;
  contentType: CrawlPageContentType;
  bodyText: string;
  byteLength: number;
  redirectCount: number;
  attemptedAt: string;
}>;

export type FailedCrawlEvidence = Readonly<{
  outcome: "failed";
  leadId: string;
  leadVersion: number;
  requestedUrl: string;
  failure: CrawlEvidenceFailureCode;
  attemptedAt: string;
}>;

export type SinglePageCrawlEvidence = FetchedCrawlEvidence | FailedCrawlEvidence;

export type CrawlPageFetcher = (
  input: unknown,
  signal: AbortSignal,
) => Promise<CrawlPageResult>;

export type SinglePageCrawlDependencies = Readonly<{
  fetchPage: CrawlPageFetcher;
  clock: () => Date;
}>;

export function collectSinglePageCrawlEvidence(
  lead: BusinessLead,
  signal: AbortSignal,
): Promise<SinglePageCrawlEvidence> {
  return collectSinglePageCrawlEvidenceWithDependencies(lead, signal, {
    fetchPage: fetchCrawlPage,
    clock: () => new Date(),
  });
}

export async function collectSinglePageCrawlEvidenceWithDependencies(
  lead: BusinessLead,
  signal: AbortSignal,
  dependencies: SinglePageCrawlDependencies,
): Promise<SinglePageCrawlEvidence> {
  if (!(signal instanceof AbortSignal)) {
    throw new CrawlEvidenceError("INVALID_REQUEST");
  }

  const observation = lead.websiteObservation;
  if (observation.presence !== "present" || typeof observation.url !== "string") {
    throw new CrawlEvidenceError("INVALID_REQUEST");
  }

  const leadId = lead.id;
  const leadVersion = lead.version;
  const requestedUrl = observation.url;
  const attemptedAt = dependencies.clock().toISOString();

  try {
    const page = await dependencies.fetchPage(requestedUrl, signal);
    const fetched: FetchedCrawlEvidence = {
      outcome: "fetched",
      leadId,
      leadVersion,
      requestedUrl,
      finalUrl: page.finalUrl,
      statusCode: page.statusCode,
      contentType: page.contentType,
      bodyText: page.bodyText,
      byteLength: page.byteLength,
      redirectCount: page.redirectCount,
      attemptedAt,
    };
    return Object.freeze(fetched);
  } catch (error) {
    if (error instanceof NetworkTargetError || error instanceof CrawlPageError) {
      const failed: FailedCrawlEvidence = {
        outcome: "failed",
        leadId,
        leadVersion,
        requestedUrl,
        failure: error.code,
        attemptedAt,
      };
      return Object.freeze(failed);
    }
    throw error;
  }
}
