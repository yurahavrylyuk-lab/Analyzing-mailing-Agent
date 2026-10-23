export const GEMINI_WEBSITE_ANALYSIS_ERROR_CODES = Object.freeze([
  "GEMINI_TRANSPORT_UNAVAILABLE",
  "GEMINI_HTTP_ERROR",
  "GEMINI_INVALID_RESPONSE",
] as const);

export type GeminiWebsiteAnalysisErrorCode =
  (typeof GEMINI_WEBSITE_ANALYSIS_ERROR_CODES)[number];

const messages: Readonly<Record<GeminiWebsiteAnalysisErrorCode, string>> = {
  GEMINI_TRANSPORT_UNAVAILABLE: "Gemini transport is unavailable.",
  GEMINI_HTTP_ERROR: "Gemini returned an HTTP error.",
  GEMINI_INVALID_RESPONSE: "Gemini response is invalid.",
};

export class GeminiWebsiteAnalysisError extends Error {
  readonly name = "GeminiWebsiteAnalysisError";

  constructor(readonly code: GeminiWebsiteAnalysisErrorCode) {
    super(messages[code]);
  }
}
