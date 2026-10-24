import type { D1WebsiteAnalysisPipelineDatabase } from "./d1-analysis-pipeline";
import { D1WebsiteAnalysisPipelineError } from "./pipeline-errors";

export const DAILY_WEBSITE_CAP = 50;

export type WebsiteAnalysisDailyUsage = Readonly<{
  websitesAdmitted: number;
  geminiRequestsUsed: number;
}>;

const INSERT_USAGE_SQL = `
INSERT INTO website_analysis_daily_usage (
  utc_date, websites_admitted, gemini_requests_used
) VALUES (?, 0, 0)
ON CONFLICT (utc_date) DO NOTHING
`;

const INSERT_ADMISSION_SQL = `
INSERT INTO website_analysis_daily_admissions (utc_date, evidence_id)
VALUES (?, ?)
`;

const RESERVE_REQUEST_SQL = `
UPDATE website_analysis_daily_usage
SET gemini_requests_used = CASE
  WHEN gemini_requests_used + 1 <= ?1 THEN gemini_requests_used + 1
  ELSE -1
END
WHERE utc_date = ?2
`;

export function utcAnalysisDate(clock: () => Date): string {
  return clock().toISOString().slice(0, 10);
}

function isIntegerInRange(value: unknown, maximum: number | undefined): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && (maximum === undefined || value <= maximum);
}

export async function readWebsiteAnalysisDailyUsage(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
): Promise<WebsiteAnalysisDailyUsage> {
  const row = await database
    .prepare(
      `SELECT websites_admitted, gemini_requests_used
       FROM website_analysis_daily_usage
       WHERE utc_date = ?`,
    )
    .bind(utcDate)
    .first();
  if (row === null) {
    return { websitesAdmitted: 0, geminiRequestsUsed: 0 };
  }
  const websitesAdmitted = row.websites_admitted;
  const geminiRequestsUsed = row.gemini_requests_used;
  if (
    !isIntegerInRange(websitesAdmitted, DAILY_WEBSITE_CAP)
    || !isIntegerInRange(geminiRequestsUsed, undefined)
  ) {
    throw new D1WebsiteAnalysisPipelineError("BUDGET_FAILED");
  }
  return { websitesAdmitted, geminiRequestsUsed };
}

export async function readWebsiteAnalysisAdmissions(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  evidenceIds: readonly number[],
): Promise<ReadonlySet<number>> {
  if (evidenceIds.length === 0) {
    return new Set();
  }
  const placeholders = evidenceIds.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT evidence_id
       FROM website_analysis_daily_admissions
       WHERE utc_date = ? AND evidence_id IN (${placeholders})`,
    )
    .bind(utcDate, ...evidenceIds)
    .all();
  const admitted = new Set<number>();
  for (const row of rows.results) {
    const evidenceId = row.evidence_id;
    if (typeof evidenceId === "number") {
      admitted.add(evidenceId);
    }
  }
  return admitted;
}

function isReservationExhaustion(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("daily website cap")
    || message.includes("CHECK constraint failed")
    || message.includes("UNIQUE constraint failed");
}

async function reserve(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  newEvidenceIds: readonly number[],
  requestLimit: number,
): Promise<boolean> {
  const statements = [
    database.prepare(INSERT_USAGE_SQL).bind(utcDate),
    ...newEvidenceIds.map((evidenceId) => database.prepare(INSERT_ADMISSION_SQL).bind(utcDate, evidenceId)),
    database.prepare(RESERVE_REQUEST_SQL).bind(requestLimit, utcDate),
  ];
  try {
    await database.batch(statements);
    return true;
  } catch (error) {
    if (isReservationExhaustion(error)) {
      return false;
    }
    throw new D1WebsiteAnalysisPipelineError("BUDGET_FAILED");
  }
}

export function reserveWebsiteAnalysisBatch(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  newEvidenceIds: readonly number[],
  requestLimit: number,
): Promise<boolean> {
  return reserve(database, utcDate, newEvidenceIds, requestLimit);
}

export function reserveGeminiRequest(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  requestLimit: number,
): Promise<boolean> {
  return reserve(database, utcDate, [], requestLimit);
}
