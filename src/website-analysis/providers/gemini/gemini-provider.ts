import type { GeminiWebsiteAnalysisConfig } from "../../../config/env";
import { validateWebsiteAnalysis } from "../../analysis";
import type { WebsiteAnalysis } from "../../analysis";
import { WebsiteAnalysisError } from "../../analysis-errors";
import type { WebsiteFacts } from "../../facts";
import { GeminiWebsiteAnalysisError } from "./errors";
import {
  GEMINI_BATCH_RESPONSE_FORMAT,
  GEMINI_RESPONSE_FORMAT,
  GEMINI_WEBSITE_ANALYSIS_PROMPT,
  GEMINI_WEBSITE_BATCH_PROMPT,
} from "./prompt";

export const GEMINI_MODELS = Object.freeze([
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
] as const);

export const GEMINI_WEBSITE_BATCH_SIZE = 5;

export type GeminiModel = (typeof GEMINI_MODELS)[number];

export type GeminiWebsiteAnalysisOptions = Readonly<{
  fetch?: typeof fetch;
}>;

export type GeminiWebsiteAnalysisResult = Readonly<{
  analysis: WebsiteAnalysis;
  provider: "gemini";
  model: GeminiModel;
  attemptedModels: readonly GeminiModel[];
}>;

export type GeminiWebsiteBatchOptions = Readonly<{
  fetch?: typeof fetch;
  firstRequestReserved: true;
  reserveNextRequest: () => Promise<boolean>;
}>;

export type GeminiWebsiteBatchItem =
  | Readonly<{
      ok: true;
      facts: WebsiteFacts;
      result: GeminiWebsiteAnalysisResult;
    }>
  | Readonly<{
      ok: false;
      facts: WebsiteFacts;
      error: WebsiteAnalysisError;
    }>;

export type GeminiWebsiteBatchResult = Readonly<{
  requestExhausted: boolean;
  items: readonly GeminiWebsiteBatchItem[];
  model: GeminiModel | null;
  attemptedModels: readonly GeminiModel[];
}>;

const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1/interactions";
const GEMINI_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

function selectFacts(facts: WebsiteFacts) {
  return {
    evidenceId: facts.evidenceId,
    leadId: facts.leadId,
    leadVersion: facts.leadVersion,
    requestedUrl: facts.requestedUrl,
    finalUrl: facts.finalUrl,
    title: facts.title,
    metaDescription: facts.metaDescription,
    documentLanguage: facts.documentLanguage,
    hasViewport: facts.hasViewport,
    h1Count: facts.h1Count,
    headingCount: facts.headingCount,
    imageCount: facts.imageCount,
    imagesWithoutAlt: facts.imagesWithoutAlt,
    formCount: facts.formCount,
    internalLinkCount: facts.internalLinkCount,
    externalLinkCount: facts.externalLinkCount,
    visibleText: facts.visibleText,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCandidate(payload: unknown): unknown {
  if (!isRecord(payload) || payload.status !== "completed" || !Array.isArray(payload.steps)) {
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
  let output: Record<string, unknown> | undefined;
  for (const step of payload.steps) {
    if (isRecord(step) && step.type === "model_output") output = step;
  }
  if (output === undefined || !Array.isArray(output.content) || output.content.length !== 1) {
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
  const part = output.content[0];
  if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
  try {
    return JSON.parse(part.text);
  } catch {
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
}

async function requestModel(
  model: GeminiModel,
  facts: WebsiteFacts,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<{ type: "transport" } | { type: "candidate"; candidate: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MILLISECONDS);
  let response: Response;
  try {
    response = await fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        input: `${GEMINI_WEBSITE_ANALYSIS_PROMPT}\n\n${JSON.stringify(selectFacts(facts))}`,
        store: false,
        stream: false,
        response_format: GEMINI_RESPONSE_FORMAT,
      }),
      signal: controller.signal,
    });
  } catch {
    return { type: "transport" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status > 299) {
    throw new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR");
  }
  try {
    return { type: "candidate", candidate: readCandidate(await response.json()) };
  } catch (error) {
    if (error instanceof GeminiWebsiteAnalysisError) throw error;
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
}

export async function analyzeWebsiteWithGemini(
  facts: WebsiteFacts,
  config: GeminiWebsiteAnalysisConfig,
  options?: GeminiWebsiteAnalysisOptions,
): Promise<GeminiWebsiteAnalysisResult> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;
  const attempted: GeminiModel[] = [];
  for (const model of GEMINI_MODELS) {
    attempted.push(model);
    const outcome = await requestModel(model, facts, config.apiKey, fetchImpl);
    if (outcome.type === "transport") continue;
    const analysis = validateWebsiteAnalysis(facts, outcome.candidate);
    return Object.freeze({
      analysis,
      provider: "gemini",
      model,
      attemptedModels: Object.freeze([...attempted]),
    });
  }
  throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
}

function batchIdentityKey(candidate: unknown): string | undefined {
  if (!isRecord(candidate)) return undefined;
  const evidenceId = candidate.evidenceId;
  const leadId = candidate.leadId;
  const leadVersion = candidate.leadVersion;
  if (
    typeof evidenceId !== "number" ||
    typeof leadId !== "string" ||
    typeof leadVersion !== "number"
  ) {
    return undefined;
  }
  return `${evidenceId}\u0000${leadId}\u0000${leadVersion}`;
}

function hasExactOwnKeys(value: object, keys: readonly string[]): boolean {
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  if (names.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readAnalyses(candidate: unknown): readonly unknown[] {
  if (
    !isRecord(candidate) ||
    !hasExactOwnKeys(candidate, ["analyses"]) ||
    !Array.isArray(candidate.analyses)
  ) {
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
  return candidate.analyses;
}

function failedBatchItem(website: WebsiteFacts, error: WebsiteAnalysisError): GeminiWebsiteBatchItem {
  return Object.freeze({
    ok: false,
    facts: website,
    error,
  });
}

function mapBatchItems(
  websites: readonly WebsiteFacts[],
  analyses: readonly unknown[],
  model: GeminiModel,
  attemptedModels: readonly GeminiModel[],
): GeminiWebsiteBatchItem[] {
  const grouped = new Map<string, unknown[]>();
  for (const element of analyses) {
    const key = batchIdentityKey(element);
    if (key === undefined) continue;
    const matches = grouped.get(key);
    if (matches === undefined) grouped.set(key, [element]);
    else matches.push(element);
  }
  return websites.map((website) => {
    const key = `${website.evidenceId}\u0000${website.leadId}\u0000${website.leadVersion}`;
    const matches = grouped.get(key) ?? [];
    if (matches.length !== 1) {
      return failedBatchItem(website, new WebsiteAnalysisError("INVALID_ANALYSIS"));
    }
    try {
      const analysis = validateWebsiteAnalysis(website, matches[0]);
      return Object.freeze({
        ok: true as const,
        facts: website,
        result: Object.freeze({
          analysis,
          provider: "gemini" as const,
          model,
          attemptedModels,
        }),
      });
    } catch (error) {
      if (error instanceof WebsiteAnalysisError) return failedBatchItem(website, error);
      throw error;
    }
  });
}

async function requestBatch(
  model: GeminiModel,
  websites: readonly WebsiteFacts[],
  apiKey: string,
  fetchImpl: typeof fetch,
  onFetch: () => void,
): Promise<{ type: "transport" } | { type: "candidate"; candidate: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MILLISECONDS);
  let response: Response;
  try {
    onFetch();
    response = await fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        model,
        input: `${GEMINI_WEBSITE_BATCH_PROMPT}\n${JSON.stringify(websites.map(selectFacts))}`,
        store: false,
        stream: false,
        response_format: GEMINI_BATCH_RESPONSE_FORMAT,
      }),
      signal: controller.signal,
    });
  } catch {
    return { type: "transport" };
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status > 299) {
    throw new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR");
  }
  try {
    return { type: "candidate", candidate: readCandidate(await response.json()) };
  } catch (error) {
    if (error instanceof GeminiWebsiteAnalysisError) throw error;
    throw new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  }
}

export async function analyzeWebsitesWithGemini(
  websites: readonly WebsiteFacts[],
  config: GeminiWebsiteAnalysisConfig,
  options: GeminiWebsiteBatchOptions,
): Promise<GeminiWebsiteBatchResult> {
  if (websites.length < 1 || websites.length > GEMINI_WEBSITE_BATCH_SIZE) {
    throw new RangeError("Gemini website batch size must be from 1 through 5.");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const attempted: GeminiModel[] = [];
  for (const model of GEMINI_MODELS) {
    if (attempted.length > 0) {
      const reserved = await options.reserveNextRequest();
      if (!reserved) {
        const attemptedModels = Object.freeze([...attempted]);
        return Object.freeze({
          requestExhausted: true,
          items: Object.freeze(websites.map((website) => (
            failedBatchItem(website, new WebsiteAnalysisError("INVALID_ANALYSIS"))
          ))),
          model: null,
          attemptedModels,
        });
      }
    }
    const outcome = await requestBatch(model, websites, config.apiKey, fetchImpl, () => {
      attempted.push(model);
    });
    if (outcome.type === "transport") continue;
    const attemptedModels = Object.freeze([...attempted]);
    return Object.freeze({
      requestExhausted: false,
      items: Object.freeze(mapBatchItems(websites, readAnalyses(outcome.candidate), model, attemptedModels)),
      model,
      attemptedModels,
    });
  }
  throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
}
