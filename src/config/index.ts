import { loadConfig } from "./env";

export { loadConfig } from "./env";
export type {
  AppConfig,
  ApplicationEnvironment,
  EnvironmentVariables,
  LogLevel,
} from "./env";

/** Read-only process configuration for application entry points. */
export const config = loadConfig(process.env);
