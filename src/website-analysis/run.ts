import type { GeminiWebsiteAnalysisConfig } from "../config/env";
import { WebsiteAnalysisError } from "./analysis-errors";
import type { WebsiteFacts } from "./facts";
import {
  analyzeWebsiteWithGemini,
  GeminiWebsiteAnalysisError,
} from "./providers/gemini";
import type { GeminiWebsiteAnalysisResult } from "./providers/gemini";

export const WEBSITE_ANALYSIS_RUN_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
] as const);

export type WebsiteAnalysisRunErrorCode =
  (typeof WEBSITE_ANALYSIS_RUN_ERROR_CODES)[number];

const messages: Readonly<Record<WebsiteAnalysisRunErrorCode, string>> = {
  INVALID_REQUEST: "Website analysis run request is invalid.",
};

export class WebsiteAnalysisRunError extends Error {
  readonly name = "WebsiteAnalysisRunError";

  constructor(readonly code: WebsiteAnalysisRunErrorCode) {
    super(messages[code]);
  }
}

export type WebsiteAnalysisRunItem =
  | Readonly<{
      status: "succeeded";
      facts: WebsiteFacts;
      result: GeminiWebsiteAnalysisResult;
      retried: boolean;
    }>
  | Readonly<{
      status: "failed";
      facts: WebsiteFacts;
      error: Error;
      retried: boolean;
    }>;

export type WebsiteAnalysisRunOptions = Readonly<{
  analyze?: typeof analyzeWebsiteWithGemini;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

const MAX_WEBSITE_FACTS_PER_RUN = 50;

function isKnownAnalyzerError(
  error: unknown,
): error is GeminiWebsiteAnalysisError | WebsiteAnalysisError {
  return error instanceof GeminiWebsiteAnalysisError || error instanceof WebsiteAnalysisError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function assertValidRun(facts: readonly WebsiteFacts[]): void {
  if (facts.length > MAX_WEBSITE_FACTS_PER_RUN) {
    throw new WebsiteAnalysisRunError("INVALID_REQUEST");
  }
  const seen = new Set<number>();
  for (const item of facts) {
    if (seen.has(item.evidenceId)) {
      throw new WebsiteAnalysisRunError("INVALID_REQUEST");
    }
    seen.add(item.evidenceId);
  }
}

export async function runWebsiteAnalysis(
  facts: readonly WebsiteFacts[],
  config: GeminiWebsiteAnalysisConfig,
  options?: WebsiteAnalysisRunOptions,
): Promise<readonly WebsiteAnalysisRunItem[]> {
  assertValidRun(facts);
  if (facts.length === 0) {
    return Object.freeze([]);
  }
  const analyze = options?.analyze ?? analyzeWebsiteWithGemini;
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? delay;
  const results: Array<WebsiteAnalysisRunItem | undefined> = new Array(facts.length);
  const deferredItems: Array<{ index: number; facts: WebsiteFacts; retryAt: number }> = [];

  for (let index = 0; index < facts.length; index += 1) {
    const websiteFacts = facts[index];
    if (websiteFacts === undefined) {
      throw new Error("Website analysis run left an input without a terminal result.");
    }
    try {
      const result = await analyze(websiteFacts, config);
      results[index] = Object.freeze({
        status: "succeeded",
        facts: websiteFacts,
        result,
        retried: false,
      });
    } catch (error) {
      if (
        error instanceof GeminiWebsiteAnalysisError &&
        error.code === "GEMINI_TRANSPORT_UNAVAILABLE"
      ) {
        const failureTime = now();
        deferredItems.push({
          index,
          facts: websiteFacts,
          retryAt: failureTime + 90_000,
        });
        continue;
      }
      if (isKnownAnalyzerError(error)) {
        results[index] = Object.freeze({
          status: "failed",
          facts: websiteFacts,
          error,
          retried: false,
        });
        continue;
      }
      throw error;
    }
  }

  for (const deferred of deferredItems) {
    const remaining = deferred.retryAt - now();
    if (remaining > 0) {
      await sleep(remaining);
    }
    try {
      const result = await analyze(deferred.facts, config);
      results[deferred.index] = Object.freeze({
        status: "succeeded",
        facts: deferred.facts,
        result,
        retried: true,
      });
    } catch (error) {
      if (isKnownAnalyzerError(error)) {
        results[deferred.index] = Object.freeze({
          status: "failed",
          facts: deferred.facts,
          error,
          retried: true,
        });
        continue;
      }
      throw error;
    }
  }

  return Object.freeze(results.map((item) => {
    if (item === undefined) {
      throw new Error("Website analysis run left an input without a terminal result.");
    }
    return item;
  }));
}
