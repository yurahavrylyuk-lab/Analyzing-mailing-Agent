import { DiscoveryConfigurationError } from "./errors";

export const APPLICATION_ENVIRONMENTS = [
  "development",
  "test",
  "production",
] as const;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type ApplicationEnvironment = (typeof APPLICATION_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type SQLiteDatabaseUrl = `file:${string}`;

export type DiscoveryConfig =
  | Readonly<{
      provider: "disabled";
    }>
  | Readonly<{
      provider: "geoapify";
      apiKey: string;
    }>;

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

export interface AppConfig {
  readonly environment: ApplicationEnvironment;
  readonly logLevel: LogLevel;
  readonly database: Readonly<{
    url: SQLiteDatabaseUrl;
  }>;
  readonly discovery: DiscoveryConfig;
}

const defaultLogLevels: Readonly<Record<ApplicationEnvironment, LogLevel>> = {
  development: "debug",
  test: "warn",
  production: "info",
};

const defaultDatabaseUrls: Readonly<
  Record<Exclude<ApplicationEnvironment, "production">, SQLiteDatabaseUrl>
> = {
  development: "file:./data/delta-qoralis.sqlite",
  test: "file::memory:",
};

function parseEnum<T extends string>(
  variableName: string,
  value: string | undefined,
  allowedValues: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined) {
    return defaultValue;
  }

  if (allowedValues.includes(value as T)) {
    return value as T;
  }

  throw new Error(
    `Invalid ${variableName}. Expected one of: ${allowedValues.join(", ")}.`,
  );
}

function parseDatabaseUrl(
  environment: ApplicationEnvironment,
  value: string | undefined,
): SQLiteDatabaseUrl {
  if (value === undefined) {
    if (environment === "production") {
      throw new Error("DATABASE_URL must be explicitly configured in production.");
    }

    return defaultDatabaseUrls[environment];
  }

  if (
    !value.startsWith("file:") ||
    value.slice("file:".length).trim().length === 0 ||
    value.startsWith("file://") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new Error("Invalid DATABASE_URL. Expected a local SQLite file: URL.");
  }

  return value as SQLiteDatabaseUrl;
}

const whitespaceOrControlCharacterPattern = /[\s\u0000-\u001f\u007f-\u009f]/u;

function parseDiscoveryConfig(
  environment: EnvironmentVariables,
): DiscoveryConfig {
  const provider = environment.DISCOVERY_PROVIDER;

  if (provider === undefined || provider === "disabled") {
    return Object.freeze({ provider: "disabled" });
  }

  if (provider !== "geoapify") {
    throw new DiscoveryConfigurationError("INVALID_PROVIDER");
  }

  const apiKey = environment.GEOAPIFY_API_KEY;
  if (apiKey === undefined) {
    throw new DiscoveryConfigurationError("MISSING_GEOAPIFY_API_KEY");
  }
  if (apiKey.length === 0 || whitespaceOrControlCharacterPattern.test(apiKey)) {
    throw new DiscoveryConfigurationError("INVALID_GEOAPIFY_API_KEY");
  }

  return Object.freeze({ provider: "geoapify", apiKey });
}

/**
 * Parses application settings without performing I/O or activating providers.
 */
export function loadConfig(environment: EnvironmentVariables): AppConfig {
  const appEnvironment = parseEnum(
    "NODE_ENV",
    environment.NODE_ENV,
    APPLICATION_ENVIRONMENTS,
    "development",
  );
  const logLevel = parseEnum(
    "LOG_LEVEL",
    environment.LOG_LEVEL,
    LOG_LEVELS,
    defaultLogLevels[appEnvironment],
  );
  const database = Object.freeze({
    url: parseDatabaseUrl(appEnvironment, environment.DATABASE_URL),
  });
  const discovery = parseDiscoveryConfig(environment);

  return Object.freeze({
    environment: appEnvironment,
    logLevel,
    database,
    discovery,
  });
}
