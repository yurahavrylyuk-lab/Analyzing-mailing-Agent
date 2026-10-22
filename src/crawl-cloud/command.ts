import type { BusinessLead } from "../leads/domain";
import { collectSinglePageCrawlEvidence } from "../crawler/single-page-evidence";
import type { SinglePageCrawlEvidence } from "../crawler/single-page-evidence";
import {
  runBoundedSinglePageCrawlWithDependencies,
  type SinglePageCrawlRunResult,
} from "../crawler/run-loop";
import {
  CrawlCloudConfigurationError,
  loadCrawlCloudConfig,
  type CrawlCloudConfig,
} from "./config";
import { createCrawlGatewayClient } from "./gateway-client";

export type CrawlCloudCommandRequest = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
}>;

export type CrawlCloudCommandResult = Readonly<{
  exitCode: 0 | 1 | 130;
  stdout: string;
  stderr: string;
}>;

export type CrawlCloudCommandDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  collect?: (lead: BusinessLead, signal: AbortSignal) => Promise<SinglePageCrawlEvidence>;
}>;

const configurationError = "Crawl gateway configuration is invalid.\n";
const runFailed = "Crawl run failed.\n";
const runCancelled = "Crawl run was cancelled.\n";

function renderResult(result: SinglePageCrawlRunResult): string {
  return [
    `status: ${result.stop.status}`,
    `reason: ${result.stop.reason}`,
    `selected: ${result.summary.selected}`,
    `attempted: ${result.summary.attempted}`,
    `fetched: ${result.summary.fetched}`,
    `failed: ${result.summary.failed}`,
    `persisted: ${result.summary.persisted}`,
    "",
  ].join("\n");
}

function configurationFailure(): CrawlCloudCommandResult {
  return { exitCode: 1, stdout: "", stderr: configurationError };
}

function runFailure(): CrawlCloudCommandResult {
  return { exitCode: 1, stdout: "", stderr: runFailed };
}

function cancelledFailure(): CrawlCloudCommandResult {
  return { exitCode: 130, stdout: "", stderr: runCancelled };
}

export async function runCrawlCloudCommand(
  request: CrawlCloudCommandRequest,
  dependencies: CrawlCloudCommandDependencies = {},
): Promise<CrawlCloudCommandResult> {
  let config: CrawlCloudConfig;
  try {
    config = loadCrawlCloudConfig(request.env);
  } catch (error) {
    if (error instanceof CrawlCloudConfigurationError) {
      return configurationFailure();
    }
    return runFailure();
  }

  const client = createCrawlGatewayClient(config, dependencies.fetchImpl ?? fetch);
  try {
    const result = await runBoundedSinglePageCrawlWithDependencies(
      {
        maxAttempts: config.maxAttempts,
        signal: request.signal,
      },
      {
        select: (maxAttempts) => client.select(maxAttempts, request.signal),
        collect: dependencies.collect ?? collectSinglePageCrawlEvidence,
        persist: (evidence) => client.persist(evidence, request.signal),
      },
    );
    return {
      exitCode: result.stop.status === "cancelled" ? 130 : 0,
      stdout: renderResult(result),
      stderr: result.stop.status === "cancelled" ? runCancelled : "",
    };
  } catch {
    if (request.signal.aborted) {
      return cancelledFailure();
    }
    return runFailure();
  }
}
