export const WEBSITE_ANALYSIS_PERSISTENCE_ERROR_CODES = Object.freeze([
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_NOT_ANALYZABLE",
  "ANALYSIS_IDENTITY_MISMATCH",
  "PERSISTENCE_FAILED",
] as const);

export type WebsiteAnalysisPersistenceErrorCode =
  (typeof WEBSITE_ANALYSIS_PERSISTENCE_ERROR_CODES)[number];

const messages: Readonly<Record<WebsiteAnalysisPersistenceErrorCode, string>> = {
  EVIDENCE_NOT_FOUND: "Crawl evidence was not found.",
  EVIDENCE_NOT_ANALYZABLE: "Crawl evidence is not analyzable.",
  ANALYSIS_IDENTITY_MISMATCH: "Website analysis identity does not match the crawl evidence.",
  PERSISTENCE_FAILED: "Website analysis persistence failed.",
};

export class WebsiteAnalysisPersistenceError extends Error {
  readonly name = "WebsiteAnalysisPersistenceError";

  constructor(readonly code: WebsiteAnalysisPersistenceErrorCode) {
    super(messages[code]);
  }
}
