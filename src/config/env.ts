export const APPLICATION_ENVIRONMENTS = [
  "development",
  "test",
  "production",
] as const;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type ApplicationEnvironment = (typeof APPLICATION_ENVIRONMENTS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

export interface AppConfig {
  readonly environment: ApplicationEnvironment;
  readonly logLevel: LogLevel;
}

const defaultLogLevels: Readonly<Record<ApplicationEnvironment, LogLevel>> = {
  development: "debug",
  test: "warn",
  production: "info",
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

/**
 * Parses the application settings currently supported by the foundation.
 * Future provider settings stay optional until their owning feature enables them.
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

  return Object.freeze({ environment: appEnvironment, logLevel });
}
