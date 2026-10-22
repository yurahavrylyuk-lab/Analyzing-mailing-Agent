export const WEBSITE_FACTS_ERROR_CODES = Object.freeze([
  "EVIDENCE_NOT_ANALYZABLE",
] as const);

export type WebsiteFactsErrorCode = (typeof WEBSITE_FACTS_ERROR_CODES)[number];

const messages: Readonly<Record<WebsiteFactsErrorCode, string>> = {
  EVIDENCE_NOT_ANALYZABLE: "Crawl evidence is not analyzable.",
};

export class WebsiteFactsError extends Error {
  readonly name = "WebsiteFactsError";

  constructor(readonly code: WebsiteFactsErrorCode) {
    super(messages[code]);
  }
}
