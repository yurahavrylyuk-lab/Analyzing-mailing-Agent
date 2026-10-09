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
