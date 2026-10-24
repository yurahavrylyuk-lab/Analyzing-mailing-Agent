import { timingSafeEqual } from "node:crypto";

import type { GeminiWebsiteAnalysisConfig } from "../config/env";
import {
  persistD1CrawlEvidence,
  selectD1CrawlCandidates,
  type D1CrawlDatabase,
} from "../crawler/d1-crawl-store";
import { CrawlEvidencePersistenceError } from "../crawler/evidence-domain";
import {
  runD1WebsiteAnalysisPipeline,
  type D1WebsiteAnalysisPipelineDatabase,
} from "../website-analysis/d1-analysis-pipeline";

export type CrawlGatewayDatabase = D1CrawlDatabase & D1WebsiteAnalysisPipelineDatabase;

export type CrawlGatewayEnv = Readonly<{
  DB: CrawlGatewayDatabase;
  CRAWL_GATEWAY_TOKEN?: string;
  ANALYSIS_GATEWAY_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_DAILY_REQUEST_LIMIT?: string;
}>;

export type CrawlGatewayDependencies = Readonly<{
  runPipeline?: typeof runD1WebsiteAnalysisPipeline;
}>;

const SELECT_PATH = "/internal/crawl/select";
const EVIDENCE_PATH = "/internal/crawl/evidence";
const ANALYSIS_PATH = "/internal/analysis/run";
const MAX_BODY_BYTES = 3_145_728;
const geminiKeyPattern = /[\s\u0000-\u001f\u007f-\u009f]/u;
const geminiDailyRequestLimitPattern = /^(?:[1-9][0-9]{0,4})$/;

function jsonResponse(status: number, body: Readonly<Record<string, unknown>>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function unauthorized(): Response {
  return jsonResponse(401, { error: "unauthorized" });
}

function notFound(): Response {
  return jsonResponse(404, { error: "not_found" });
}

function methodNotAllowed(): Response {
  return jsonResponse(405, { error: "method_not_allowed" });
}

function invalidRequest(): Response {
  return jsonResponse(400, { error: "invalid_request" });
}

function internalError(): Response {
  return jsonResponse(500, { error: "internal_error" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === allowed.length &&
    keys.every((key) => typeof key === "string" && allowed.includes(key))
  );
}

function tokensMatch(configured: string, presented: string): boolean {
  const secretBytes = Buffer.from(configured, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  if (secretBytes.length !== presentedBytes.length) {
    return false;
  }

  return timingSafeEqual(secretBytes, presentedBytes);
}

function isAuthorized(request: Request, env: CrawlGatewayEnv): boolean {
  const secret = env.CRAWL_GATEWAY_TOKEN;
  if (typeof secret !== "string" || secret.length === 0) {
    return false;
  }

  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return false;
  }

  return tokensMatch(secret, header.slice("Bearer ".length));
}

function isAnalysisAuthorized(request: Request, env: CrawlGatewayEnv): boolean {
  const secret = env.ANALYSIS_GATEWAY_TOKEN;
  if (typeof secret !== "string" || secret.length === 0) {
    return false;
  }

  const header = request.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) {
    return false;
  }

  return tokensMatch(secret, header.slice("Bearer ".length));
}

function parseGeminiDailyRequestLimit(value: string | undefined): number | undefined {
  if (value === undefined || !geminiDailyRequestLimitPattern.test(value)) {
    return undefined;
  }
  const dailyRequestLimit = Number(value);
  if (!Number.isInteger(dailyRequestLimit) || dailyRequestLimit < 1 || dailyRequestLimit > 10000) {
    return undefined;
  }
  return dailyRequestLimit;
}

function geminiConfigFromEnv(env: CrawlGatewayEnv): GeminiWebsiteAnalysisConfig | undefined {
  const apiKey = env.GEMINI_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0 || geminiKeyPattern.test(apiKey)) {
    return undefined;
  }
  const dailyRequestLimit = parseGeminiDailyRequestLimit(env.GEMINI_DAILY_REQUEST_LIMIT);
  if (dailyRequestLimit === undefined) {
    return undefined;
  }

  return Object.freeze({ provider: "gemini", apiKey, dailyRequestLimit });
}

function isMaxItems(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 50;
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType === "application/json" || contentType === "application/json; charset=utf-8";
}

function hasAllowedContentLength(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (raw === null) {
    return true;
  }

  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    return false;
  }

  const length = Number(raw);
  return Number.isSafeInteger(length) && length <= MAX_BODY_BYTES;
}

function isMaxAttempts(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 60;
}

async function readJsonBody(request: Request): Promise<unknown | Response> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return invalidRequest();
  }

  if (raw.length > MAX_BODY_BYTES || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return invalidRequest();
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return invalidRequest();
  }
}

async function handleSelect(parsed: unknown, env: CrawlGatewayEnv): Promise<Response> {
  if (!isRecord(parsed) || !hasExactlyKeys(parsed, ["maxAttempts"]) || !isMaxAttempts(parsed.maxAttempts)) {
    return invalidRequest();
  }

  try {
    const candidates = await selectD1CrawlCandidates(env.DB, parsed.maxAttempts);
    return jsonResponse(200, { candidates });
  } catch {
    return internalError();
  }
}

async function handleEvidence(parsed: unknown, env: CrawlGatewayEnv): Promise<Response> {
  try {
    await persistD1CrawlEvidence(env.DB, parsed);
  } catch (error) {
    if (
      error instanceof CrawlEvidencePersistenceError &&
      (error.code === "INVALID_EVIDENCE" || error.code === "LEAD_NOT_FOUND")
    ) {
      return invalidRequest();
    }
    return internalError();
  }

  return jsonResponse(200, { persisted: true });
}

async function handleAnalysis(
  parsed: unknown,
  env: CrawlGatewayEnv,
  dependencies?: CrawlGatewayDependencies,
): Promise<Response> {
  if (!isRecord(parsed) || !hasExactlyKeys(parsed, ["maxItems"]) || !isMaxItems(parsed.maxItems)) {
    return invalidRequest();
  }

  const geminiConfig = geminiConfigFromEnv(env);
  if (geminiConfig === undefined) {
    return internalError();
  }

  const runPipeline = dependencies?.runPipeline ?? runD1WebsiteAnalysisPipeline;
  try {
    const result = await runPipeline(env.DB, geminiConfig, parsed.maxItems);
    return jsonResponse(200, {
      selected: result.selected,
      succeeded: result.succeeded,
      failed: result.failed,
      retried: result.retried,
      persisted: result.persisted,
      budget: {
        utcDate: result.budget.utcDate,
        websitesAdmitted: result.budget.websitesAdmitted,
        websiteLimit: result.budget.websiteLimit,
        geminiRequestsUsed: result.budget.geminiRequestsUsed,
        geminiRequestLimit: result.budget.geminiRequestLimit,
        stoppedReason: result.budget.stoppedReason,
      },
    });
  } catch {
    return internalError();
  }
}

export async function handleCrawlGatewayRequest(
  request: Request,
  env: CrawlGatewayEnv,
  dependencies?: CrawlGatewayDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const knownPath =
    url.pathname === SELECT_PATH ||
    url.pathname === EVIDENCE_PATH ||
    url.pathname === ANALYSIS_PATH;
  if (!knownPath || url.search !== "") {
    return notFound();
  }

  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  if (url.pathname === ANALYSIS_PATH) {
    if (!isAnalysisAuthorized(request, env)) {
      return unauthorized();
    }
  } else if (!isAuthorized(request, env)) {
    return unauthorized();
  }

  if (!hasJsonContentType(request) || !hasAllowedContentLength(request)) {
    return invalidRequest();
  }

  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) {
    return parsed;
  }

  if (url.pathname === ANALYSIS_PATH) {
    return handleAnalysis(parsed, env, dependencies);
  }

  if (url.pathname === SELECT_PATH) {
    return handleSelect(parsed, env);
  }

  return handleEvidence(parsed, env);
}

const worker: {
  fetch(request: Request, env: CrawlGatewayEnv): Promise<Response>;
} = {
  fetch(request, env) {
    return handleCrawlGatewayRequest(request, env);
  },
};

export default worker;
