import type { GeminiWebsiteAnalysisConfig } from "../config/env";
import { evidenceFromRow } from "../crawler/database-evidence-repository";
import { WebsiteAnalysisError } from "./analysis-errors";
import {
  DAILY_WEBSITE_CAP,
  readWebsiteAnalysisAdmissions,
  readWebsiteAnalysisDailyUsage,
  reserveGeminiRequest,
  reserveWebsiteAnalysisBatch,
  utcAnalysisDate,
} from "./daily-usage";
import { persistD1WebsiteAnalysis } from "./d1-analysis-store";
import { extractWebsiteFacts } from "./facts";
import type { WebsiteFacts } from "./facts";
import { D1WebsiteAnalysisPipelineError } from "./pipeline-errors";
import {
  GEMINI_WEBSITE_BATCH_SIZE,
  GeminiWebsiteAnalysisError,
  analyzeWebsitesWithGemini,
} from "./providers/gemini";
import type { GeminiWebsiteAnalysisResult, GeminiWebsiteBatchItem } from "./providers/gemini";
import type { WebsiteAnalysisRunOptions } from "./run";

export type WebsiteAnalysisBudgetSummary = Readonly<{
  utcDate: string;
  websitesAdmitted: number;
  websiteLimit: 50;
  geminiRequestsUsed: number;
  geminiRequestLimit: number;
  stoppedReason: "max_items" | "no_evidence" | "website_cap" | "request_cap";
}>;

export type D1WebsiteAnalysisPipelineResult = Readonly<{
  selected: number;
  succeeded: number;
  failed: number;
  retried: number;
  persisted: number;
  budget: WebsiteAnalysisBudgetSummary;
}>;

export type D1WebsiteAnalysisPipelineOptions = Readonly<{
  analysisRunOptions?: WebsiteAnalysisRunOptions;
  storedAt?: () => string;
  now?: () => Date;
  analyzeBatch?: typeof analyzeWebsitesWithGemini;
}>;

type D1WebsiteAnalysisPipelineStatement = {
  bind(...values: readonly unknown[]): D1WebsiteAnalysisPipelineStatement;
  all(): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{
    readonly meta: {
      readonly changes: number;
      readonly last_row_id: number;
    };
  }>;
};

export type D1WebsiteAnalysisPipelineDatabase = {
  prepare(sql: string): D1WebsiteAnalysisPipelineStatement;
  batch(
    statements: readonly D1WebsiteAnalysisPipelineStatement[],
  ): Promise<readonly unknown[]>;
};

type Terminal = {
  facts: WebsiteFacts;
  status: "succeeded" | "failed";
  result?: GeminiWebsiteAnalysisResult;
  retried: boolean;
};

type DeferredBatch = {
  start: number;
  facts: readonly WebsiteFacts[];
  retryAt: number;
};

const SELECTION_SQL = `
SELECT id, lead_id, lead_version, outcome, requested_url, attempted_at,
       final_url, status_code, content_type, body_text, byte_length,
       redirect_count, failure_code
FROM single_page_crawl_evidence AS evidence
WHERE evidence.outcome = 'fetched'
  AND NOT EXISTS (
    SELECT 1
    FROM website_analyses AS analysis
    WHERE analysis.evidence_id = evidence.id
  )
ORDER BY evidence.attempted_at ASC, evidence.id ASC
LIMIT ?
`;

function defaultStoredAt(): string {
  return new Date().toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isKnownAnalyzerError(error: unknown): boolean {
  return error instanceof GeminiWebsiteAnalysisError || error instanceof WebsiteAnalysisError;
}

function isValidMaxItems(value: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 50;
}

function isValidDailyRequestLimit(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 10000;
}

function composeBatch(
  unsent: readonly WebsiteFacts[],
  admitted: ReadonlySet<number>,
  slotsLeft: number,
): { batch: WebsiteFacts[]; newEvidenceIds: number[] } {
  const batch: WebsiteFacts[] = [];
  const newEvidenceIds: number[] = [];
  for (const candidate of unsent) {
    if (batch.length === GEMINI_WEBSITE_BATCH_SIZE) break;
    if (admitted.has(candidate.evidenceId)) {
      batch.push(candidate);
      continue;
    }
    if (newEvidenceIds.length >= slotsLeft) break;
    batch.push(candidate);
    newEvidenceIds.push(candidate.evidenceId);
  }
  return { batch, newEvidenceIds };
}

function failedTerminal(facts: WebsiteFacts, retried: boolean): Terminal {
  return { facts, status: "failed", retried };
}

function placeItems(
  slots: Array<Terminal | undefined>,
  start: number,
  websites: readonly WebsiteFacts[],
  items: readonly GeminiWebsiteBatchItem[],
  retried: boolean,
): void {
  const byId = new Map(items.map((item) => [item.facts.evidenceId, item]));
  for (let index = 0; index < websites.length; index += 1) {
    const facts = websites[index];
    if (facts === undefined) continue;
    const item = byId.get(facts.evidenceId);
    if (item !== undefined && item.ok) {
      slots[start + index] = {
        facts,
        status: "succeeded",
        result: item.result,
        retried,
      };
      continue;
    }
    slots[start + index] = failedTerminal(facts, retried);
  }
}

function placeFailures(
  slots: Array<Terminal | undefined>,
  start: number,
  websites: readonly WebsiteFacts[],
  retried: boolean,
): void {
  for (let index = 0; index < websites.length; index += 1) {
    const facts = websites[index];
    if (facts === undefined) continue;
    slots[start + index] = failedTerminal(facts, retried);
  }
}

function budgetFor(
  utcDate: string,
  usage: { readonly websitesAdmitted: number; readonly geminiRequestsUsed: number },
  requestLimit: number,
  stoppedReason: WebsiteAnalysisBudgetSummary["stoppedReason"],
): WebsiteAnalysisBudgetSummary {
  return Object.freeze({
    utcDate,
    websitesAdmitted: usage.websitesAdmitted,
    websiteLimit: 50,
    geminiRequestsUsed: usage.geminiRequestsUsed,
    geminiRequestLimit: requestLimit,
    stoppedReason,
  });
}

function zeroCounters(
  budget: WebsiteAnalysisBudgetSummary,
): D1WebsiteAnalysisPipelineResult {
  return Object.freeze({
    selected: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    persisted: 0,
    budget,
  });
}

export async function runD1WebsiteAnalysisPipeline(
  database: D1WebsiteAnalysisPipelineDatabase,
  config: GeminiWebsiteAnalysisConfig,
  maxItems: number,
  options?: D1WebsiteAnalysisPipelineOptions,
): Promise<D1WebsiteAnalysisPipelineResult> {
  if (!isValidMaxItems(maxItems)) {
    throw new D1WebsiteAnalysisPipelineError("INVALID_REQUEST");
  }
  if (!isValidDailyRequestLimit(config.dailyRequestLimit)) {
    throw new D1WebsiteAnalysisPipelineError("INVALID_CONFIGURATION");
  }
  const clock = options?.now ?? (() => new Date());
  const nowMs = options?.analysisRunOptions?.now ?? (() => clock().getTime());
  const sleep = options?.analysisRunOptions?.sleep ?? delay;
  if (maxItems === 0) {
    const utcDate = utcAnalysisDate(clock);
    const usage = await readWebsiteAnalysisDailyUsage(database, utcDate);
    return zeroCounters(budgetFor(utcDate, usage, config.dailyRequestLimit, "max_items"));
  }
  const openingDate = utcAnalysisDate(clock);
  const openingUsage = await readWebsiteAnalysisDailyUsage(database, openingDate);
  if (openingUsage.geminiRequestsUsed >= config.dailyRequestLimit) {
    return zeroCounters(budgetFor(
      openingDate,
      openingUsage,
      config.dailyRequestLimit,
      "request_cap",
    ));
  }

  let response: { readonly results: readonly Record<string, unknown>[] };
  try {
    response = await database.prepare(SELECTION_SQL).bind(maxItems).all();
  } catch {
    throw new D1WebsiteAnalysisPipelineError("SELECTION_FAILED");
  }
  const results = response.results;
  if (!Array.isArray(results) || results.length > maxItems) {
    throw new D1WebsiteAnalysisPipelineError("SELECTION_FAILED");
  }
  if (results.length === 0) {
    const utcDate = utcAnalysisDate(clock);
    const usage = await readWebsiteAnalysisDailyUsage(database, utcDate);
    return zeroCounters(budgetFor(utcDate, usage, config.dailyRequestLimit, "no_evidence"));
  }

  const evidence = results.map((row) =>
    evidenceFromRow(row as unknown as Parameters<typeof evidenceFromRow>[0]),
  );
  const facts = evidence.map((item) => extractWebsiteFacts(item));
  const analyzeBatch = options?.analyzeBatch ?? analyzeWebsitesWithGemini;
  const reserveNextRequest = () => reserveGeminiRequest(
    database,
    utcAnalysisDate(clock),
    config.dailyRequestLimit,
  );
  const slots: Array<Terminal | undefined> = new Array(facts.length);
  const deferred: DeferredBatch[] = [];
  let unsent = facts.slice();
  let start = 0;
  let halt: "request_cap" | "website_cap" | "no_evidence" = "no_evidence";
  let recomposed = false;

  while (unsent.length > 0) {
    const utcDate = utcAnalysisDate(clock);
    const usage = await readWebsiteAnalysisDailyUsage(database, utcDate);
    if (usage.geminiRequestsUsed >= config.dailyRequestLimit) {
      halt = "request_cap";
      break;
    }
    const admitted = await readWebsiteAnalysisAdmissions(
      database,
      utcDate,
      unsent.map((website) => website.evidenceId),
    );
    let composed = composeBatch(unsent, admitted, DAILY_WEBSITE_CAP - usage.websitesAdmitted);
    if (composed.batch.length === 0) {
      halt = "website_cap";
      break;
    }
    let reserved = await reserveWebsiteAnalysisBatch(
      database,
      utcDate,
      composed.newEvidenceIds,
      config.dailyRequestLimit,
    );
    if (!reserved && !recomposed && composed.newEvidenceIds.length > 0) {
      const refreshed = await readWebsiteAnalysisAdmissions(
        database,
        utcDate,
        composed.newEvidenceIds,
      );
      const lostAdmission = composed.newEvidenceIds.some((evidenceId) => refreshed.has(evidenceId));
      if (lostAdmission) {
        recomposed = true;
        const usageNow = await readWebsiteAnalysisDailyUsage(database, utcDate);
        if (usageNow.geminiRequestsUsed >= config.dailyRequestLimit) {
          halt = "request_cap";
          break;
        }
        const admittedNow = await readWebsiteAnalysisAdmissions(
          database,
          utcDate,
          unsent.map((website) => website.evidenceId),
        );
        composed = composeBatch(
          unsent,
          admittedNow,
          DAILY_WEBSITE_CAP - usageNow.websitesAdmitted,
        );
        if (composed.batch.length === 0) {
          halt = "website_cap";
          break;
        }
        reserved = await reserveWebsiteAnalysisBatch(
          database,
          utcDate,
          composed.newEvidenceIds,
          config.dailyRequestLimit,
        );
      }
    }
    if (!reserved) {
      const latest = await readWebsiteAnalysisDailyUsage(database, utcDate);
      halt = latest.geminiRequestsUsed >= config.dailyRequestLimit ? "request_cap" : "website_cap";
      break;
    }
    const group = composed.batch;
    const groupStart = start;
    unsent = unsent.slice(group.length);
    start += group.length;
    try {
      const batch = await analyzeBatch(group, config, {
        firstRequestReserved: true,
        reserveNextRequest,
      });
      placeItems(slots, groupStart, group, batch.items, false);
      if (batch.requestExhausted) {
        halt = "request_cap";
        break;
      }
    } catch (error) {
      if (
        error instanceof GeminiWebsiteAnalysisError
        && error.code === "GEMINI_TRANSPORT_UNAVAILABLE"
      ) {
        deferred.push({ start: groupStart, facts: group, retryAt: nowMs() + 90_000 });
        continue;
      }
      if (isKnownAnalyzerError(error)) {
        placeFailures(slots, groupStart, group, false);
        continue;
      }
      throw error;
    }
  }

  let stopRetries = false;
  for (const pending of deferred) {
    if (stopRetries) {
      placeFailures(slots, pending.start, pending.facts, false);
      continue;
    }
    const remaining = pending.retryAt - nowMs();
    if (remaining > 0) await sleep(remaining);
    const reserved = await reserveGeminiRequest(
      database,
      utcAnalysisDate(clock),
      config.dailyRequestLimit,
    );
    if (!reserved) {
      placeFailures(slots, pending.start, pending.facts, false);
      stopRetries = true;
      continue;
    }
    try {
      const batch = await analyzeBatch(pending.facts, config, {
        firstRequestReserved: true,
        reserveNextRequest,
      });
      placeItems(slots, pending.start, pending.facts, batch.items, true);
      if (batch.requestExhausted) stopRetries = true;
    } catch (error) {
      if (isKnownAnalyzerError(error)) {
        placeFailures(slots, pending.start, pending.facts, true);
        continue;
      }
      throw error;
    }
  }

  let persisted = 0;
  for (const slot of slots) {
    if (slot?.status !== "succeeded" || slot.result === undefined) continue;
    const storedAt = (options?.storedAt ?? defaultStoredAt)();
    await persistD1WebsiteAnalysis(database, slot.result, storedAt);
    persisted += 1;
  }

  const terminals = slots.filter((slot): slot is Terminal => slot !== undefined);
  let succeeded = 0;
  let failed = 0;
  let retried = 0;
  for (const item of terminals) {
    if (item.status === "succeeded") succeeded += 1;
    else failed += 1;
    if (item.retried) retried += 1;
  }
  const responseDate = utcAnalysisDate(clock);
  const usage = await readWebsiteAnalysisDailyUsage(database, responseDate);
  const stoppedReason = terminals.length === maxItems ? "max_items" : halt;
  return Object.freeze({
    selected: terminals.length,
    succeeded,
    failed,
    retried,
    persisted,
    budget: budgetFor(responseDate, usage, config.dailyRequestLimit, stoppedReason),
  });
}
