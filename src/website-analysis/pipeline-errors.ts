export const D1_WEBSITE_ANALYSIS_PIPELINE_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "SELECTION_FAILED",
  "INVALID_CONFIGURATION",
  "BUDGET_FAILED",
] as const);

export type D1WebsiteAnalysisPipelineErrorCode =
  (typeof D1_WEBSITE_ANALYSIS_PIPELINE_ERROR_CODES)[number];

const messages: Readonly<Record<D1WebsiteAnalysisPipelineErrorCode, string>> = {
  INVALID_REQUEST: "D1 website analysis pipeline request is invalid.",
  SELECTION_FAILED: "D1 website analysis selection failed.",
  INVALID_CONFIGURATION: "D1 website analysis configuration is invalid.",
  BUDGET_FAILED: "D1 website analysis budget ledger failed.",
};

export class D1WebsiteAnalysisPipelineError extends Error {
  readonly name = "D1WebsiteAnalysisPipelineError";

  constructor(readonly code: D1WebsiteAnalysisPipelineErrorCode) {
    super(messages[code]);
  }
}
