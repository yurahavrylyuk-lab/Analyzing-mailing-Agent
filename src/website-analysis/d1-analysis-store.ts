import type { WebsiteAnalysisFinding } from "./analysis";
import { WebsiteAnalysisPersistenceError } from "./persistence-errors";
import { GEMINI_MODELS } from "./providers/gemini";
import type { GeminiModel, GeminiWebsiteAnalysisResult } from "./providers/gemini";

export type StoredWebsiteAnalysis = Readonly<{
  id: number;
  evidenceId: number;
  leadId: string;
  leadVersion: number;
  summary: string;
  findings: readonly WebsiteAnalysisFinding[];
  provider: "gemini";
  model: GeminiModel;
  attemptedModels: readonly GeminiModel[];
  storedAt: string;
}>;

type D1WebsiteAnalysisStatement = {
  bind(...values: readonly unknown[]): D1WebsiteAnalysisStatement;
  all(): Promise<{ readonly results: readonly Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
  run(): Promise<{
    readonly meta: {
      readonly changes: number;
      readonly last_row_id: number;
    };
  }>;
};

export type D1WebsiteAnalysisDatabase = {
  prepare(sql: string): D1WebsiteAnalysisStatement;
};

const EVIDENCE_SQL = `
  SELECT id, lead_id, lead_version, outcome
  FROM single_page_crawl_evidence
  WHERE id = ?
`;

const INSERT_SQL = `
  INSERT INTO website_analyses (
    evidence_id, lead_id, lead_version, summary, findings_json,
    provider, model, attempted_models_json, stored_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_SQL = `
  SELECT id, evidence_id, lead_id, lead_version, summary, findings_json,
         provider, model, attempted_models_json, stored_at
  FROM website_analyses
  WHERE id = ?
`;

const findingKeys = [
  "category",
  "severity",
  "observation",
  "evidence",
  "recommendation",
] as const;
const categories = ["design", "usability", "seo", "accessibility", "conversion"] as const;
const severities = ["low", "medium", "high"] as const;
type FindingCategory = (typeof categories)[number];
type FindingSeverity = (typeof severities)[number];
const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function persistenceFailed(): never {
  throw new WebsiteAnalysisPersistenceError("PERSISTENCE_FAILED");
}

function isCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && categories.some((category) => category === value);
}

function isSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && severities.some((severity) => severity === value);
}

function isGeminiModel(value: unknown): value is GeminiModel {
  return typeof value === "string" && GEMINI_MODELS.some((model) => model === value);
}

function isCanonicalTimestamp(value: string): boolean {
  if (value.length !== 24) {
    return false;
  }
  const pattern =
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
  if (!pattern.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : monthLengths[month - 1];
  return day >= 1 && days !== undefined && day <= days;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  if (names.length !== keys.length) {
    return false;
  }
  return keys.every((key) => hasOwn(value, key));
}

function exactText(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim()) {
    persistenceFailed();
  }
  return value;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) {
    persistenceFailed();
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      persistenceFailed();
    }
    throw error;
  }
}

function readFindings(value: unknown): readonly WebsiteAnalysisFinding[] {
  if (!Array.isArray(value) || value.length > 8) {
    persistenceFailed();
  }
  const counts: Record<(typeof categories)[number], number> = {
    design: 0,
    usability: 0,
    seo: 0,
    accessibility: 0,
    conversion: 0,
  };
  const findings: WebsiteAnalysisFinding[] = [];
  for (const item of value) {
    if (!isPlainObject(item) || !hasExactOwnKeys(item, findingKeys)) {
      persistenceFailed();
    }
    const category = item.category;
    const severity = item.severity;
    if (!isCategory(category) || !isSeverity(severity)) {
      persistenceFailed();
    }
    counts[category] += 1;
    if (counts[category] > 3) {
      persistenceFailed();
    }
    findings.push({
      category,
      severity,
      observation: exactText(item.observation, 500),
      evidence: exactText(item.evidence, 800),
      recommendation: exactText(item.recommendation, 500),
    });
  }
  return Object.freeze(findings.map((finding) => Object.freeze(finding)));
}

function readAttemptedModels(value: unknown, model: GeminiModel): readonly GeminiModel[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((entry) => isGeminiModel(entry))) {
    persistenceFailed();
  }
  if (parsed[parsed.length - 1] !== model) {
    persistenceFailed();
  }
  return Object.freeze([...parsed]);
}

function parseStoredRow(row: Record<string, unknown>): StoredWebsiteAnalysis {
  if (!isPositiveSafeInteger(row.id) || !isPositiveSafeInteger(row.evidence_id)) {
    persistenceFailed();
  }
  if (typeof row.lead_id !== "string" || row.lead_id.trim().length === 0) {
    persistenceFailed();
  }
  if (!isPositiveSafeInteger(row.lead_version)) {
    persistenceFailed();
  }
  if (typeof row.summary !== "string" || row.summary.length === 0 || row.summary.length > 800 || row.summary !== row.summary.trim()) {
    persistenceFailed();
  }
  if (row.provider !== "gemini" || !isGeminiModel(row.model)) {
    persistenceFailed();
  }
  if (typeof row.stored_at !== "string" || !isCanonicalTimestamp(row.stored_at)) {
    persistenceFailed();
  }
  return Object.freeze({
    id: row.id,
    evidenceId: row.evidence_id,
    leadId: row.lead_id,
    leadVersion: row.lead_version,
    summary: row.summary,
    findings: readFindings(parseJson(row.findings_json)),
    provider: "gemini",
    model: row.model,
    attemptedModels: readAttemptedModels(row.attempted_models_json, row.model),
    storedAt: row.stored_at,
  });
}

function assertInputProvenance(result: GeminiWebsiteAnalysisResult): void {
  if (result.provider !== "gemini" || !isGeminiModel(result.model)) {
    persistenceFailed();
  }
  const attempted = result.attemptedModels;
  if (
    !Array.isArray(attempted) ||
    attempted.length === 0 ||
    !attempted.every((model) => isGeminiModel(model)) ||
    attempted[attempted.length - 1] !== result.model
  ) {
    persistenceFailed();
  }
}

async function readRow(statement: D1WebsiteAnalysisStatement): Promise<Record<string, unknown> | null> {
  try {
    return await statement.first();
  } catch {
    persistenceFailed();
  }
}

export async function persistD1WebsiteAnalysis(
  database: D1WebsiteAnalysisDatabase,
  result: GeminiWebsiteAnalysisResult,
  storedAt: string,
): Promise<StoredWebsiteAnalysis> {
  if (!isCanonicalTimestamp(storedAt)) {
    persistenceFailed();
  }

  const evidence = await readRow(database.prepare(EVIDENCE_SQL).bind(result.analysis.evidenceId));
  if (evidence == null) {
    throw new WebsiteAnalysisPersistenceError("EVIDENCE_NOT_FOUND");
  }
  if (evidence.outcome !== "fetched") {
    throw new WebsiteAnalysisPersistenceError("EVIDENCE_NOT_ANALYZABLE");
  }
  if (
    result.analysis.evidenceId !== evidence.id ||
    result.analysis.leadId !== evidence.lead_id ||
    result.analysis.leadVersion !== evidence.lead_version
  ) {
    throw new WebsiteAnalysisPersistenceError("ANALYSIS_IDENTITY_MISMATCH");
  }

  assertInputProvenance(result);
  const findingsJson = JSON.stringify(result.analysis.findings);
  const attemptedModelsJson = JSON.stringify(result.attemptedModels);
  let inserted: {
    readonly meta: {
      readonly changes: number;
      readonly last_row_id: number;
    };
  };
  try {
    inserted = await database
      .prepare(INSERT_SQL)
      .bind(
        result.analysis.evidenceId,
        result.analysis.leadId,
        result.analysis.leadVersion,
        result.analysis.summary,
        findingsJson,
        result.provider,
        result.model,
        attemptedModelsJson,
        storedAt,
      )
      .run();
  } catch {
    persistenceFailed();
  }

  const insertedId = inserted.meta.last_row_id;
  if (inserted.meta.changes !== 1 || !isPositiveSafeInteger(insertedId)) {
    persistenceFailed();
  }

  const row = await readRow(database.prepare(SELECT_SQL).bind(insertedId));
  if (row == null) {
    persistenceFailed();
  }
  const stored = parseStoredRow(row);
  if (stored.id !== insertedId) {
    persistenceFailed();
  }
  return stored;
}
