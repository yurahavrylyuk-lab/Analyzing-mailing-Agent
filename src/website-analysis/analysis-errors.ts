export const WEBSITE_ANALYSIS_ERROR_CODES = Object.freeze([
  "INVALID_ANALYSIS",
  "ANALYSIS_IDENTITY_MISMATCH",
] as const);

export type WebsiteAnalysisErrorCode =
  (typeof WEBSITE_ANALYSIS_ERROR_CODES)[number];

const messages: Readonly<Record<WebsiteAnalysisErrorCode, string>> = {
  INVALID_ANALYSIS: "Website analysis is invalid.",
  ANALYSIS_IDENTITY_MISMATCH:
    "Website analysis identity does not match the website facts.",
};

export class WebsiteAnalysisError extends Error {
  readonly name = "WebsiteAnalysisError";

  constructor(readonly code: WebsiteAnalysisErrorCode) {
    super(messages[code]);
  }
}
