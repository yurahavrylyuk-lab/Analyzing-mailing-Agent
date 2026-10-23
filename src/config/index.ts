import { loadConfig } from "./env";

export { loadConfig } from "./env";
export {
  DISCOVERY_CONFIGURATION_ERROR_CODES,
  DiscoveryConfigurationError,
  WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES,
  WebsiteAnalysisConfigurationError,
} from "./errors";
export type {
  AppConfig,
  ApplicationEnvironment,
  DiscoveryConfig,
  EnvironmentVariables,
  GeminiWebsiteAnalysisConfig,
  LogLevel,
  SQLiteDatabaseUrl,
  WebsiteAnalysisConfig,
} from "./env";
export type {
  DiscoveryConfigurationErrorCode,
  WebsiteAnalysisConfigurationErrorCode,
} from "./errors";

/** Read-only process configuration for application entry points. */
export const config = loadConfig(process.env);
