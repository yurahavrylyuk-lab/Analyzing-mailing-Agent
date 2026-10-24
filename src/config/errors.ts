export const DISCOVERY_CONFIGURATION_ERROR_CODES = [
  "INVALID_PROVIDER",
  "MISSING_GEOAPIFY_API_KEY",
  "INVALID_GEOAPIFY_API_KEY",
] as const;

export type DiscoveryConfigurationErrorCode =
  (typeof DISCOVERY_CONFIGURATION_ERROR_CODES)[number];

const messages: Readonly<Record<DiscoveryConfigurationErrorCode, string>> = {
  INVALID_PROVIDER: "Invalid DISCOVERY_PROVIDER. Expected disabled or geoapify.",
  MISSING_GEOAPIFY_API_KEY:
    "GEOAPIFY_API_KEY is required when discovery provider is geoapify.",
  INVALID_GEOAPIFY_API_KEY: "GEOAPIFY_API_KEY is invalid.",
};

export class DiscoveryConfigurationError extends Error {
  readonly name = "DiscoveryConfigurationError";

  constructor(readonly code: DiscoveryConfigurationErrorCode) {
    super(messages[code]);
  }
}

export const WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES = [
  "INVALID_PROVIDER",
  "MISSING_GEMINI_API_KEY",
  "INVALID_GEMINI_API_KEY",
  "MISSING_GEMINI_DAILY_REQUEST_LIMIT",
  "INVALID_GEMINI_DAILY_REQUEST_LIMIT",
] as const;

export type WebsiteAnalysisConfigurationErrorCode =
  (typeof WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES)[number];

const websiteAnalysisMessages: Readonly<Record<WebsiteAnalysisConfigurationErrorCode, string>> = {
  INVALID_PROVIDER: "Invalid WEBSITE_ANALYSIS_PROVIDER. Expected disabled or gemini.",
  MISSING_GEMINI_API_KEY: "GEMINI_API_KEY is required when website analysis provider is gemini.",
  INVALID_GEMINI_API_KEY: "GEMINI_API_KEY is invalid.",
  MISSING_GEMINI_DAILY_REQUEST_LIMIT:
    "GEMINI_DAILY_REQUEST_LIMIT is required when website analysis provider is gemini.",
  INVALID_GEMINI_DAILY_REQUEST_LIMIT: "GEMINI_DAILY_REQUEST_LIMIT is invalid.",
};

export class WebsiteAnalysisConfigurationError extends Error {
  readonly name = "WebsiteAnalysisConfigurationError";

  constructor(readonly code: WebsiteAnalysisConfigurationErrorCode) {
    super(websiteAnalysisMessages[code]);
  }
}
