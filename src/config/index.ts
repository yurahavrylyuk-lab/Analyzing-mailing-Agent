import { loadConfig } from "./env";

export { loadConfig } from "./env";
export {
  DISCOVERY_CONFIGURATION_ERROR_CODES,
  DiscoveryConfigurationError,
} from "./errors";
export type {
  AppConfig,
  ApplicationEnvironment,
  DiscoveryConfig,
  EnvironmentVariables,
  LogLevel,
  SQLiteDatabaseUrl,
} from "./env";
export type { DiscoveryConfigurationErrorCode } from "./errors";

/** Read-only process configuration for application entry points. */
export const config = loadConfig(process.env);
