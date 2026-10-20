import { parseArgs } from "node:util";

import { normalizeAuditActor } from "../audit";
import { InvalidAuditActorError } from "../audit/errors";
import { auditMigrations } from "../audit/migration";
import { complianceMigrations } from "../compliance/migration";
import { DiscoveryConfigurationError } from "../config/errors";
import {
  loadConfig,
  type AppConfig,
  type DiscoveryConfig,
  type EnvironmentVariables,
} from "../config/env";
import { applyMigrations, createDatabase } from "../db";
import { LeadService, leadMigrations } from "../leads";
import { normalizeDiscoveryCriteria } from "./domain";
import {
  DISCOVERY_PROVIDER_ERROR_MESSAGES,
  InvalidDiscoveryCriteriaError,
} from "./errors";
import { createGeoapifyProvider } from "./providers/geoapify";
import type { DiscoveryProvider } from "./provider";
import {
  runBoundedDiscovery,
  type DiscoveryLeadRecorder,
  type DiscoveryRunResult,
  type DiscoveryRunStop,
} from "./run";

export const DISCOVERY_ATTRIBUTION_LINES = [
  "© OpenStreetMap contributors",
  "Powered by Geoapify",
] as const;

export const DISCOVERY_COMMAND_EXIT = Object.freeze({
  completed: 0,
  unexpected: 1,
  usage: 2,
  configuration: 3,
  database: 4,
  failed: 5,
  cancelled: 130,
} as const);

export type DiscoveryCommandExitCode =
  (typeof DISCOVERY_COMMAND_EXIT)[keyof typeof DISCOVERY_COMMAND_EXIT];

export type DiscoveryCommandRequest = Readonly<{
  argv: readonly string[];
  env: EnvironmentVariables;
  signal: AbortSignal;
}>;

export type DiscoveryCommandResult = Readonly<{
  exitCode: DiscoveryCommandExitCode;
  stdout: string;
  stderr: string;
}>;

export type DiscoveryCommandDatabase = Readonly<{
  leads: DiscoveryLeadRecorder;
  close(): void;
}>;

export type DiscoveryCommandDependencies = Readonly<{
  openDatabase?: (database: AppConfig["database"]) => DiscoveryCommandDatabase;
  createProvider?: (
    config: Extract<DiscoveryConfig, { provider: "geoapify" }>,
  ) => DiscoveryProvider;
}>;

const HELP_TEXT = `Usage:
  npm run discover -- --location <location> --query <query> --actor <id> [--max-results <count>]
  npm run discover -- --help
  npm run discover -- -h

Options:
  --location <location>     Required city text. Passed to discovery criteria.
  --query <query>           Required query text. Passed to discovery criteria.
  --actor <id>              Required claimed human actor id.
  --max-results <count>     Optional examined-slot budget. Integer 1-60. Default 20.
  --help, -h                Show this help and exit.

Discovery stays disabled unless DISCOVERY_PROVIDER=geoapify and GEOAPIFY_API_KEY are set in the environment. This command does not read a .env file.

${DISCOVERY_ATTRIBUTION_LINES[0]}
${DISCOVERY_ATTRIBUTION_LINES[1]}
`;

const MAX_RESULTS_TOKEN = /^(?:[1-9][0-9]{0,2})$/u;

const LOAD_CONFIG_MESSAGES = new Set([
  "Invalid NODE_ENV. Expected one of: development, test, production.",
  "Invalid LOG_LEVEL. Expected one of: debug, info, warn, error.",
  "DATABASE_URL must be explicitly configured in production.",
  "Invalid DATABASE_URL. Expected a local SQLite file: URL.",
]);

const DATABASE_FAILURE = "Discovery database is unavailable.\n";
const UNEXPECTED_FAILURE = "Discovery command failed.\n";

type OptionValues = Readonly<{
  help: boolean;
  location?: readonly string[];
  query?: readonly string[];
  actor?: readonly string[];
  maxResults?: readonly string[];
}>;

function unexpectedResult(): DiscoveryCommandResult {
  return {
    exitCode: DISCOVERY_COMMAND_EXIT.unexpected,
    stdout: "",
    stderr: UNEXPECTED_FAILURE,
  };
}

function usageResult(line: string): DiscoveryCommandResult {
  return {
    exitCode: DISCOVERY_COMMAND_EXIT.usage,
    stdout: "",
    stderr: `${line}\n${HELP_TEXT}`,
  };
}

function textResult(
  exitCode: DiscoveryCommandExitCode,
  stderr: string,
  stdout = "",
): DiscoveryCommandResult {
  return { exitCode, stdout, stderr };
}

function optionList(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return undefined;
}

function parseCommandArgs(argv: readonly string[]): OptionValues | "usage" {
  try {
    const parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        location: { type: "string", multiple: true },
        query: { type: "string", multiple: true },
        actor: { type: "string", multiple: true },
        "max-results": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    });
    return {
      help: parsed.values.help === true,
      location: optionList(parsed.values.location),
      query: optionList(parsed.values.query),
      actor: optionList(parsed.values.actor),
      maxResults: optionList(parsed.values["max-results"]),
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return "usage";
    }
    throw error;
  }
}

function duplicateOption(values: OptionValues): string | undefined {
  const options = [
    ["location", values.location],
    ["query", values.query],
    ["actor", values.actor],
    ["max-results", values.maxResults],
  ] as const;
  for (const [name, list] of options) {
    if (list !== undefined && list.length > 1) {
      return `Duplicate option --${name}.`;
    }
  }
  return undefined;
}

function missingOptions(values: OptionValues): string | undefined {
  const missing = [
    ["location", values.location],
    ["query", values.query],
    ["actor", values.actor],
  ].flatMap(([name, list]) =>
    list?.length === 1 ? [] : [`Missing required option --${name}.`],
  );
  return missing.length === 0 ? undefined : missing.join("\n");
}

function configurationFailureMessage(error: unknown): string | undefined {
  if (error instanceof DiscoveryConfigurationError) {
    return error.message;
  }
  if (error instanceof Error && LOAD_CONFIG_MESSAGES.has(error.message)) {
    return error.message;
  }
  return undefined;
}

function openDiscoveryDatabase(
  configuration: AppConfig["database"],
): DiscoveryCommandDatabase {
  const database = createDatabase(configuration);
  try {
    applyMigrations(database, [
      ...leadMigrations,
      ...auditMigrations,
      ...complianceMigrations,
    ]);
  } catch (error) {
    try {
      database.close();
    } catch {
      // Keep the migration failure as the thrown database error.
    }
    throw error;
  }
  return {
    leads: new LeadService(database),
    close() {
      database.close();
    },
  };
}

export function formatDiscoveryRunResult(result: DiscoveryRunResult): string {
  const lines = [
    "Discovery run",
    `providerId: ${result.providerId}`,
    `status: ${result.stop.status}`,
    `reason: ${result.stop.reason}`,
  ];
  if ("code" in result.stop) {
    lines.push(`code: ${result.stop.code}`);
  }
  lines.push(
    `slotsExamined: ${result.summary.slotsExamined}`,
    `slotsAccepted: ${result.summary.slotsAccepted}`,
    `slotsRejected: ${result.summary.slotsRejected}`,
    `acceptedPersisted: ${result.summary.acceptedPersisted}`,
    `leadsCreated: ${result.summary.leadsCreated}`,
    `leadsDuplicate: ${result.summary.leadsDuplicate}`,
    `pagesFetched: ${result.summary.pagesFetched}`,
    "",
    DISCOVERY_ATTRIBUTION_LINES[0],
    DISCOVERY_ATTRIBUTION_LINES[1],
  );
  return `${lines.join("\n")}\n`;
}

function stderrForStop(stop: DiscoveryRunStop): string {
  switch (stop.status) {
    case "completed":
      return "";
    case "cancelled":
      return "Discovery run was cancelled.\n";
    case "failed":
      switch (stop.reason) {
        case "provider_error":
          return stop.code === "UNEXPECTED"
            ? "Discovery provider request failed.\n"
            : `${DISCOVERY_PROVIDER_ERROR_MESSAGES[stop.code]}\n`;
        case "malformed_page":
          return "Discovery provider response is invalid.\n";
        case "pagination_blocked":
          return "Discovery pagination stopped.\n";
        case "persistence_error":
          return "Discovery persistence failed.\n";
        default:
          return UNEXPECTED_FAILURE;
      }
    default:
      return UNEXPECTED_FAILURE;
  }
}

function exitCodeForStop(stop: DiscoveryRunStop): DiscoveryCommandExitCode {
  switch (stop.status) {
    case "completed":
      return DISCOVERY_COMMAND_EXIT.completed;
    case "cancelled":
      return DISCOVERY_COMMAND_EXIT.cancelled;
    case "failed":
      return DISCOVERY_COMMAND_EXIT.failed;
    default:
      return DISCOVERY_COMMAND_EXIT.unexpected;
  }
}

function withCloseFailure(result: DiscoveryCommandResult): DiscoveryCommandResult {
  if (result.exitCode === DISCOVERY_COMMAND_EXIT.completed) {
    return textResult(DISCOVERY_COMMAND_EXIT.database, DATABASE_FAILURE, result.stdout);
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: `${result.stderr}${DATABASE_FAILURE}`,
  };
}

async function composeDiscoveryCommand(
  request: DiscoveryCommandRequest,
  dependencies: DiscoveryCommandDependencies | undefined,
  opened: { current?: DiscoveryCommandDatabase },
): Promise<DiscoveryCommandResult> {
  const parsed = parseCommandArgs(request.argv);
  if (parsed === "usage") {
    return usageResult("Discovery command usage is invalid.");
  }
  if (parsed.help) {
    return textResult(DISCOVERY_COMMAND_EXIT.completed, "", HELP_TEXT);
  }

  const duplicate = duplicateOption(parsed);
  if (duplicate !== undefined) {
    return usageResult(duplicate);
  }
  const missing = missingOptions(parsed);
  if (missing !== undefined) {
    return usageResult(missing);
  }

  const location = parsed.location?.[0];
  const query = parsed.query?.[0];
  const actorId = parsed.actor?.[0];
  if (location === undefined || query === undefined || actorId === undefined) {
    return usageResult("Discovery command usage is invalid.");
  }

  const criteriaInput: Record<string, unknown> = { location, query };
  const maxResultsToken = parsed.maxResults?.[0];
  if (maxResultsToken !== undefined) {
    criteriaInput.maxResults = MAX_RESULTS_TOKEN.test(maxResultsToken)
      ? Number(maxResultsToken)
      : maxResultsToken;
  }

  let criteria;
  try {
    criteria = normalizeDiscoveryCriteria(criteriaInput);
  } catch (error) {
    if (error instanceof InvalidDiscoveryCriteriaError) {
      return usageResult(error.message);
    }
    throw error;
  }

  let actor;
  try {
    actor = normalizeAuditActor({ type: "human", id: actorId });
  } catch (error) {
    if (error instanceof InvalidAuditActorError) {
      return usageResult(error.message);
    }
    throw error;
  }

  let config: AppConfig;
  try {
    config = loadConfig(request.env);
  } catch (error) {
    const message = configurationFailureMessage(error);
    if (message === undefined) {
      throw error;
    }
    return textResult(DISCOVERY_COMMAND_EXIT.configuration, `${message}\n`);
  }

  if (config.discovery.provider !== "geoapify") {
    return textResult(DISCOVERY_COMMAND_EXIT.configuration, "Discovery is disabled.\n");
  }

  const openDatabase = dependencies?.openDatabase ?? openDiscoveryDatabase;
  let database: DiscoveryCommandDatabase;
  try {
    database = openDatabase(config.database);
  } catch {
    return textResult(DISCOVERY_COMMAND_EXIT.database, DATABASE_FAILURE);
  }
  opened.current = database;

  const createProvider =
    dependencies?.createProvider ??
    ((discoveryConfig: Extract<DiscoveryConfig, { provider: "geoapify" }>) =>
      createGeoapifyProvider(discoveryConfig));
  let provider: DiscoveryProvider;
  try {
    provider = createProvider(config.discovery);
  } catch {
    return textResult(
      DISCOVERY_COMMAND_EXIT.configuration,
      "Discovery provider configuration is invalid.\n",
    );
  }

  const runResult = await runBoundedDiscovery({
    criteria,
    provider,
    leads: database.leads,
    actor,
    signal: request.signal,
  });
  return {
    exitCode: exitCodeForStop(runResult.stop),
    stdout: formatDiscoveryRunResult(runResult),
    stderr: stderrForStop(runResult.stop),
  };
}

export async function runDiscoveryCommand(
  request: DiscoveryCommandRequest,
  dependencies?: DiscoveryCommandDependencies,
): Promise<DiscoveryCommandResult> {
  const opened: { current?: DiscoveryCommandDatabase } = {};
  let outcome = unexpectedResult();
  try {
    outcome = await composeDiscoveryCommand(request, dependencies, opened);
  } catch {
    outcome = unexpectedResult();
  } finally {
    if (opened.current !== undefined) {
      try {
        opened.current.close();
      } catch {
        outcome = withCloseFailure(outcome);
      }
    }
  }
  return outcome;
}
