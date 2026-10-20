export const CRAWL_PAGE_ERROR_CODES = Object.freeze([
  "CANCELLED",
  "TIMEOUT",
  "NETWORK_FAILURE",
  "REDIRECT_LIMIT",
  "REDIRECT_DOWNGRADE",
  "HTTP_FAILURE",
  "UNSUPPORTED_CONTENT_TYPE",
  "UNSUPPORTED_CONTENT_ENCODING",
  "RESPONSE_TOO_LARGE",
  "INVALID_BODY",
] as const);

export type CrawlPageErrorCode = (typeof CRAWL_PAGE_ERROR_CODES)[number];

const messages: Readonly<Record<CrawlPageErrorCode, string>> = {
  CANCELLED: "Crawl request was cancelled.",
  TIMEOUT: "Crawl request timed out.",
  NETWORK_FAILURE: "Crawl request failed.",
  REDIRECT_LIMIT: "Crawl redirect limit was reached.",
  REDIRECT_DOWNGRADE: "Crawl redirect changed HTTPS to HTTP.",
  HTTP_FAILURE: "Crawl response status was not usable.",
  UNSUPPORTED_CONTENT_TYPE: "Crawl response content type is not supported.",
  UNSUPPORTED_CONTENT_ENCODING: "Crawl response content encoding is not supported.",
  RESPONSE_TOO_LARGE: "Crawl response is too large.",
  INVALID_BODY: "Crawl response body is not valid UTF-8.",
};

export class CrawlPageError extends Error {
  readonly name = "CrawlPageError";

  constructor(readonly code: CrawlPageErrorCode) {
    super(messages[code]);
  }
}
