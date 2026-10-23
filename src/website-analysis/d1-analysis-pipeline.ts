import type { GeminiWebsiteAnalysisConfig } from "../config/env";
import { evidenceFromRow } from "../crawler/database-evidence-repository";
import { persistD1WebsiteAnalysis } from "./d1-analysis-store";
import { extractWebsiteFacts } from "./facts";
import { D1WebsiteAnalysisPipelineError } from "./pipeline-errors";
import { runWebsiteAnalysis, type WebsiteAnalysisRunOptions } from "./run";

export type D1WebsiteAnalysisPipelineResult = Readonly<{
  selected: number;
  succeeded: number;
  failed: number;
  retried: number;
  persisted: number;
}>;

export type D1WebsiteAnalysisPipelineOptions = Readonly<{
  analysisRunOptions?: WebsiteAnalysisRunOptions;
  storedAt?: () => string;
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

function zeroSummary(): D1WebsiteAnalysisPipelineResult {
  return Object.freeze({
    selected: 0,
    succeeded: 0,
    failed: 0,
    retried: 0,
    persisted: 0,
  });
}

function isValidMaxItems(value: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 50;
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
  if (maxItems === 0) {
    return zeroSummary();
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
    return zeroSummary();
  }

  const evidence = results.map((row) =>
    evidenceFromRow(row as unknown as Parameters<typeof evidenceFromRow>[0]),
  );
  const facts = evidence.map((item) => extractWebsiteFacts(item));
  const items = await runWebsiteAnalysis(facts, config, options?.analysisRunOptions);
  let succeeded = 0;
  let failed = 0;
  let retried = 0;
  let persisted = 0;
  for (const item of items) {
    if (item.status === "failed") {
      failed += 1;
      if (item.retried) {
        retried += 1;
      }
      continue;
    }
    const storedAt = (options?.storedAt ?? defaultStoredAt)();
    await persistD1WebsiteAnalysis(database, item.result, storedAt);
    succeeded += 1;
    persisted += 1;
    if (item.retried) {
      retried += 1;
    }
  }
  return Object.freeze({
    selected: evidence.length,
    succeeded,
    failed,
    retried,
    persisted,
  });
}
