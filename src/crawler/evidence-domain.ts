import { isBusinessLeadId, normalizeWebsiteUrl } from "../leads/domain";
import { InvalidLeadInputError } from "../leads/errors";
import { NETWORK_TARGET_ERROR_CODES } from "../network-safety/errors";
import { MAX_CRAWL_BODY_BYTES, MAX_CRAWL_REDIRECTS, type CrawlPageContentType } from "./domain";
import { CRAWL_PAGE_ERROR_CODES } from "./errors";
import type {
  CrawlEvidenceFailureCode,
  FailedCrawlEvidence,
  FetchedCrawlEvidence,
  SinglePageCrawlEvidence,
} from "./single-page-evidence";

export const CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES = Object.freeze([
  "INVALID_EVIDENCE",
  "LEAD_NOT_FOUND",
  "PERSISTENCE_FAILED",
] as const);

export type CrawlEvidencePersistenceErrorCode =
  (typeof CRAWL_EVIDENCE_PERSISTENCE_ERROR_CODES)[number];

const messages: Readonly<Record<CrawlEvidencePersistenceErrorCode, string>> = {
  INVALID_EVIDENCE: "Crawl evidence is invalid.",
  LEAD_NOT_FOUND: "Business lead was not found.",
  PERSISTENCE_FAILED: "Crawl evidence persistence failed.",
};

export class CrawlEvidencePersistenceError extends Error {
  readonly name = "CrawlEvidencePersistenceError";

  constructor(readonly code: CrawlEvidencePersistenceErrorCode) {
    super(messages[code]);
  }
}

export type StoredSinglePageCrawlEvidence = SinglePageCrawlEvidence &
  Readonly<{ id: number }>;

const FETCHED_KEYS = Object.freeze([
  "outcome",
  "leadId",
  "leadVersion",
  "requestedUrl",
  "finalUrl",
  "statusCode",
  "contentType",
  "bodyText",
  "byteLength",
  "redirectCount",
  "attemptedAt",
] as const);

const FAILED_KEYS = Object.freeze([
  "outcome",
  "leadId",
  "leadVersion",
  "requestedUrl",
  "failure",
  "attemptedAt",
] as const);

const CONTENT_TYPES = new Set<string>(["text/html", "application/xhtml+xml"]);
const FAILURE_CODES = new Set<string>([
  ...NETWORK_TARGET_ERROR_CODES,
  ...CRAWL_PAGE_ERROR_CODES,
]);

function invalidEvidence(): never {
  throw new CrawlEvidencePersistenceError("INVALID_EVIDENCE");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === allowed.length &&
    keys.every((key) => typeof key === "string" && allowed.includes(key))
  );
}

function isLeadVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isCanonicalStorageUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    return normalizeWebsiteUrl(value) === value;
  } catch (error) {
    if (error instanceof InvalidLeadInputError) {
      return false;
    }
    throw error;
  }
}

function isCanonicalAttemptedAt(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isContentType(value: unknown): value is CrawlPageContentType {
  return typeof value === "string" && CONTENT_TYPES.has(value);
}

function isFailureCode(value: unknown): value is CrawlEvidenceFailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}

function utf8ByteLength(value: string): number | undefined {
  const bytes = Buffer.from(value, "utf8");
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (decoded !== value) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return bytes.length;
}

function readCommon(input: Record<string, unknown>): {
  readonly leadId: string;
  readonly leadVersion: number;
  readonly requestedUrl: string;
  readonly attemptedAt: string;
} {
  if (
    !isBusinessLeadId(input.leadId) ||
    !isLeadVersion(input.leadVersion) ||
    !isCanonicalStorageUrl(input.requestedUrl) ||
    !isCanonicalAttemptedAt(input.attemptedAt)
  ) {
    invalidEvidence();
  }

  return {
    leadId: input.leadId,
    leadVersion: input.leadVersion,
    requestedUrl: input.requestedUrl,
    attemptedAt: input.attemptedAt,
  };
}

function normalizeFetched(input: Record<string, unknown>): FetchedCrawlEvidence {
  if (!hasExactlyKeys(input, FETCHED_KEYS)) {
    invalidEvidence();
  }

  const common = readCommon(input);
  const actualBytes = typeof input.bodyText === "string" ? utf8ByteLength(input.bodyText) : undefined;
  if (
    input.statusCode !== 200 ||
    !isContentType(input.contentType) ||
    typeof input.bodyText !== "string" ||
    actualBytes === undefined ||
    typeof input.byteLength !== "number" ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0 ||
    input.byteLength > MAX_CRAWL_BODY_BYTES ||
    input.byteLength !== actualBytes ||
    typeof input.redirectCount !== "number" ||
    !Number.isSafeInteger(input.redirectCount) ||
    input.redirectCount < 0 ||
    input.redirectCount > MAX_CRAWL_REDIRECTS ||
    !isCanonicalStorageUrl(input.finalUrl)
  ) {
    invalidEvidence();
  }

  return Object.freeze({
    outcome: "fetched",
    leadId: common.leadId,
    leadVersion: common.leadVersion,
    requestedUrl: common.requestedUrl,
    finalUrl: input.finalUrl,
    statusCode: 200,
    contentType: input.contentType,
    bodyText: input.bodyText,
    byteLength: input.byteLength,
    redirectCount: input.redirectCount,
    attemptedAt: common.attemptedAt,
  });
}

function normalizeFailed(input: Record<string, unknown>): FailedCrawlEvidence {
  if (!hasExactlyKeys(input, FAILED_KEYS) || !isFailureCode(input.failure)) {
    invalidEvidence();
  }

  const common = readCommon(input);
  return Object.freeze({
    outcome: "failed",
    leadId: common.leadId,
    leadVersion: common.leadVersion,
    requestedUrl: common.requestedUrl,
    failure: input.failure,
    attemptedAt: common.attemptedAt,
  });
}

export function normalizeSinglePageCrawlEvidence(input: unknown): SinglePageCrawlEvidence {
  if (!isRecord(input)) {
    invalidEvidence();
  }

  if (input.outcome === "fetched") {
    return normalizeFetched(input);
  }

  if (input.outcome === "failed") {
    return normalizeFailed(input);
  }

  invalidEvidence();
}
