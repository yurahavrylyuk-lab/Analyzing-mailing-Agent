import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { GeminiWebsiteAnalysisConfig } from "../../src/config/env";
import { WebsiteAnalysisError } from "../../src/website-analysis";
import type { WebsiteFacts } from "../../src/website-analysis/facts";
import {
  GeminiWebsiteAnalysisError,
  analyzeWebsiteWithGemini,
} from "../../src/website-analysis/providers/gemini";

const API_KEY = "synthetic-gemini-key";
const RAW_HTML = "<html raw=\"do-not-send\">secret-page</html>";
const EXPECTED_PROMPT = [
  "Analyze only the supplied website facts.",
  "Use only these categories: design, usability, seo, accessibility, conversion.",
  "Use only these severities: low, medium, high.",
  "Each finding must include observation, evidence, and recommendation.",
  "Do not invent facts.",
  "Do not infer from screenshots or visuals that the supplied facts do not support.",
  "Do not make qualification decisions.",
  "Do not recommend contacts.",
  "Do not generate outreach.",
  "Do not assign scores.",
  "Do not add semantic fields beyond evidenceId, leadId, leadVersion, summary, and findings.",
].join("\n");
const EXPECTED_RESPONSE_FORMAT = {
  type: "text",
  mime_type: "application/json",
  schema: {
    type: "object",
    properties: {
      evidenceId: { type: "integer" },
      leadId: { type: "string" },
      leadVersion: { type: "integer" },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: ["design", "usability", "seo", "accessibility", "conversion"] },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            observation: { type: "string" },
            evidence: { type: "string" },
            recommendation: { type: "string" },
          },
          required: ["category", "severity", "observation", "evidence", "recommendation"],
        },
      },
    },
    required: ["evidenceId", "leadId", "leadVersion", "summary", "findings"],
  },
};

function facts(): WebsiteFacts {
  return {
    evidenceId: 7,
    leadId: "lead-7",
    leadVersion: 2,
    requestedUrl: "https://example.test/start",
    finalUrl: "https://example.test/final",
    title: "Example",
    metaDescription: "A page",
    documentLanguage: "en",
    hasViewport: true,
    h1Count: 1,
    headingCount: 3,
    imageCount: 2,
    imagesWithoutAlt: 1,
    formCount: 0,
    internalLinkCount: 4,
    externalLinkCount: 1,
    visibleText: "Visible page text",
  };
}

function geminiConfig(): GeminiWebsiteAnalysisConfig {
  return { provider: "gemini", apiKey: API_KEY };
}

function candidate() {
  return {
    evidenceId: 7,
    leadId: "lead-7",
    leadVersion: 2,
    summary: "The page has a title and visible text.",
    findings: [{
      category: "seo",
      severity: "medium",
      observation: "The title is short.",
      evidence: "Title is Example.",
      recommendation: "Expand the title.",
    }],
  };
}

function interactionResponse(status: number, text: string, body = ""): Response {
  const payload = body.length > 0 ? body : JSON.stringify({
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  });
  return new Response(payload, { status, headers: { "content-type": "application/json" } });
}

function scriptedFetch(responses: readonly (Response | Error)[]) {
  const urls: string[] = [];
  const methods: string[] = [];
  const bodies: unknown[] = [];
  const headers: Headers[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    urls.push(String(url));
    methods.push(init?.method ?? "");
    headers.push(new Headers(init?.headers));
    bodies.push(JSON.parse(String(init?.body)));
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error("unexpected extra Gemini request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, urls, methods, bodies, headers };
}

test("posts one WebsiteFacts value to the Gemini Interactions API", async () => {
  const script = scriptedFetch([interactionResponse(200, JSON.stringify(candidate()))]);
  const result = await analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl });
  const body = script.bodies[0] as Record<string, unknown>;
  const input = String(body.input);
  const sent = JSON.parse(input.slice((EXPECTED_PROMPT + "\n\n").length)) as Record<string, unknown>;

  assert.equal(script.urls[0], "https://generativelanguage.googleapis.com/v1/interactions");
  assert.deepEqual(script.methods, ["POST"]);
  assert.equal(script.headers[0]?.get("x-goog-api-key"), API_KEY);
  assert.equal(script.headers[0]?.get("content-type"), "application/json");
  assert.equal(body.model, "gemini-3.8-flash");
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal("previous_interaction_id" in body, false);
  assert.deepEqual(Object.keys(body).sort(), ["input", "model", "response_format", "store", "stream"]);
  assert.deepEqual(body.response_format, EXPECTED_RESPONSE_FORMAT);
  assert.equal(input.startsWith(EXPECTED_PROMPT + "\n\n"), true);
  assert.deepEqual(Object.keys(sent), [
    "evidenceId", "leadId", "leadVersion", "requestedUrl", "finalUrl", "title",
    "metaDescription", "documentLanguage", "hasViewport", "h1Count", "headingCount",
    "imageCount", "imagesWithoutAlt", "formCount", "internalLinkCount",
    "externalLinkCount", "visibleText",
  ]);
  assert.equal(sent.visibleText, "Visible page text");
  assert.equal(input.includes(RAW_HTML), false);
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-3.8-flash");
  assert.deepEqual(result.attemptedModels, ["gemini-3.8-flash"]);
  assert.equal(result.analysis.evidenceId, 7);
  assert.equal(result.analysis.summary, "The page has a title and visible text.");
  assert.equal(result.analysis.findings.length, 1);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.attemptedModels));
  assert.ok(Object.isFrozen(result.analysis));
});

async function assertHttpStops(status: number) {
  const script = scriptedFetch([
    interactionResponse(status, "", `{"error":"${API_KEY}","prompt":"${EXPECTED_PROMPT}"}`),
    interactionResponse(200, JSON.stringify(candidate())),
  ]);
  await assert.rejects(
    () => analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiWebsiteAnalysisError);
      assert.equal(error.code, "GEMINI_HTTP_ERROR");
      assert.equal(error.message, "Gemini returned an HTTP error.");
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      return true;
    },
  );
  assert.deepEqual(script.bodies.map((body) => (body as { model: string }).model), ["gemini-3.8-flash"]);
}

test("HTTP 400 does not fall back to another model", async () => {
  await assertHttpStops(400);
});

test("HTTP 401 does not fall back to another model", async () => {
  await assertHttpStops(401);
});

test("HTTP 403 does not fall back to another model", async () => {
  await assertHttpStops(403);
});

test("HTTP 429 does not fall back to another model", async () => {
  await assertHttpStops(429);
});

test("HTTP 500 does not fall back to another model", async () => {
  await assertHttpStops(500);
});

test("HTTP 503 does not fall back to another model", async () => {
  await assertHttpStops(503);
});

test("a malformed success response does not fall back", async () => {
  const badBodies = [
    "not-json",
    JSON.stringify({ status: "completed", steps: [] }),
    JSON.stringify({
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "I cannot analyze this website." }] }],
    }),
  ];
  for (const body of badBodies) {
    const script = scriptedFetch([
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      interactionResponse(200, JSON.stringify(candidate())),
    ]);
    await assert.rejects(
      () => analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof GeminiWebsiteAnalysisError);
        assert.equal(error.code, "GEMINI_INVALID_RESPONSE");
        assert.equal(error.message, "Gemini response is invalid.");
        assert.equal(JSON.stringify(error).includes(body), false);
        return true;
      },
    );
    assert.equal(script.bodies.length, 1);
  }
});

test("runtime errors do not echo the API key, prompt, or response body", async () => {
  const secretBody = `transport failed ${API_KEY} ${EXPECTED_PROMPT} ${RAW_HTML}`;
  const script = scriptedFetch([new Error(secretBody)]);
  await assert.rejects(
    () => analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiWebsiteAnalysisError);
      assert.equal(error.code, "GEMINI_TRANSPORT_UNAVAILABLE");
      assert.equal(error.message, "Gemini transport is unavailable.");
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      assert.equal(JSON.stringify(error).includes(EXPECTED_PROMPT), false);
      assert.equal(JSON.stringify(error).includes(RAW_HTML), false);
      return true;
    },
  );
});

test("transport failure on gemini-3.8-flash continues to gemini-3.6-flash", async () => {
  const script = scriptedFetch([
    new TypeError("network connection error"),
    interactionResponse(200, JSON.stringify(candidate())),
  ]);
  const result = await analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl });
  assert.deepEqual(script.bodies.map((body) => (body as { model: string }).model), [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
  ]);
  assert.equal(result.model, "gemini-3.6-flash");
  assert.deepEqual(result.attemptedModels, ["gemini-3.8-flash", "gemini-3.6-flash"]);
});

test("the first two transport failures continue to gemini-3.5-flash-lite", async () => {
  const script = scriptedFetch([
    new TypeError("dns failure"),
    new TypeError("tls failure"),
    interactionResponse(200, JSON.stringify(candidate())),
  ]);
  const result = await analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl });
  assert.deepEqual(result.attemptedModels, [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
  ]);
  assert.equal(result.model, "gemini-3.5-flash-lite");
});

test("records every transport attempt through gemini-3.1-flash-lite", async () => {
  const script = scriptedFetch([
    new TypeError("socket failure"),
    new TypeError("socket failure"),
    new TypeError("socket failure"),
    interactionResponse(200, JSON.stringify(candidate())),
  ]);
  const result = await analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl });
  assert.deepEqual(result.attemptedModels, [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ]);
  assert.equal(result.model, "gemini-3.1-flash-lite");
  assert.equal(result.provider, "gemini");
  assert.ok(Object.isFrozen(result.attemptedModels));
  assert.equal(script.bodies.length, 4);
});

test("all four transport failures throw GEMINI_TRANSPORT_UNAVAILABLE", async () => {
  const script = scriptedFetch([
    new TypeError("network"),
    new TypeError("dns"),
    new TypeError("tls"),
    new TypeError("socket"),
  ]);
  await assert.rejects(
    () => analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof GeminiWebsiteAnalysisError);
      assert.equal(error.code, "GEMINI_TRANSPORT_UNAVAILABLE");
      assert.equal(error.message, "Gemini transport is unavailable.");
      assert.equal(JSON.stringify(error).includes(API_KEY), false);
      return true;
    },
  );
  assert.deepEqual(script.bodies.map((body) => (body as { model: string }).model), [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
  ]);
});

test("30-second no-response abort advances to the next model", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
    const numericDelay = Number(delay);
    delays.push(numericDelay);
    return originalSetTimeout(handler, numericDelay === 30_000 ? 0 : delay);
  }) as typeof setTimeout;
  try {
    const models: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === "gemini-3.8-flash") {
        if (init?.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }
      return interactionResponse(200, JSON.stringify(candidate()));
    };
    const result = await analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: fetchImpl });
    assert.equal(delays.includes(30_000), true);
    assert.equal(delays.includes(90_000), false);
    assert.deepEqual(models, ["gemini-3.8-flash", "gemini-3.6-flash"]);
    assert.equal(result.model, "gemini-3.6-flash");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("propagates a DQ-031 validation failure without fallback", async () => {
  const invalid = { ...candidate(), summary: "" };
  const script = scriptedFetch([
    interactionResponse(200, JSON.stringify(invalid)),
    interactionResponse(200, JSON.stringify(candidate())),
  ]);
  await assert.rejects(
    () => analyzeWebsiteWithGemini(facts(), geminiConfig(), { fetch: script.fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof WebsiteAnalysisError);
      assert.equal(error.name, "WebsiteAnalysisError");
      assert.equal(error.code, "INVALID_ANALYSIS");
      assert.equal(error.message, "Website analysis is invalid.");
      assert.equal(error instanceof GeminiWebsiteAnalysisError, false);
      return true;
    },
  );
  assert.deepEqual(script.bodies.map((body) => (body as { model: string }).model), ["gemini-3.8-flash"]);
});
