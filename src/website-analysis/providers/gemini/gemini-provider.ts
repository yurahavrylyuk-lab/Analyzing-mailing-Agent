import type { GeminiWebsiteAnalysisConfig } from "../../../config/env";
import { validateWebsiteAnalysis } from "../../analysis";
import type { WebsiteAnalysis } from "../../analysis";
import type { WebsiteFacts } from "../../facts";
import { GeminiWebsiteAnalysisError } from "./errors";
import { GEMINI_RESPONSE_FORMAT, GEMINI_WEBSITE_ANALYSIS_PROMPT } from "./prompt";

export const GEMINI_MODELS = Object.freeze([
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
] as const);

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
