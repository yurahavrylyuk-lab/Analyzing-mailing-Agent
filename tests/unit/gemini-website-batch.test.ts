import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { GeminiWebsiteAnalysisConfig } from "../../src/config/env";
import { WebsiteAnalysisError } from "../../src/website-analysis/analysis-errors";
import type { WebsiteFacts } from "../../src/website-analysis/facts";
import {
  GEMINI_MODELS,
  GEMINI_WEBSITE_BATCH_PROMPT,
  GEMINI_WEBSITE_BATCH_SIZE,
  GeminiWebsiteAnalysisError,
  analyzeWebsitesWithGemini,
} from "../../src/website-analysis/providers/gemini";

const API_KEY = "synthetic-gemini-key";

function geminiConfig(): GeminiWebsiteAnalysisConfig {
  return { provider: "gemini", apiKey: API_KEY, dailyRequestLimit: 10 };
}

function facts(evidenceId: number, leadId = `lead-${evidenceId}`, leadVersion = evidenceId): WebsiteFacts {
  return {
    evidenceId,
    leadId,
    leadVersion,
    requestedUrl: `https://example.test/${evidenceId}`,
    finalUrl: `https://example.test/${evidenceId}/final`,
    title: `Title ${evidenceId}`,
    metaDescription: "A page",
    documentLanguage: "en",
    hasViewport: true,
    h1Count: 1,
    headingCount: 2,
    imageCount: 1,
    imagesWithoutAlt: 0,
    formCount: 0,
    internalLinkCount: 1,
    externalLinkCount: 0,
    visibleText: `Visible ${evidenceId}`,
  };
}

function analysisFor(website: WebsiteFacts, category = "seo") {
  return {
    evidenceId: website.evidenceId,
    leadId: website.leadId,
    leadVersion: website.leadVersion,
    summary: `Summary ${website.evidenceId}`,
    findings: [{
      category,
      severity: "low",
      observation: "Observed.",
      evidence: "Visible text.",
      recommendation: "Keep it.",
    }],
  };
}

function completed(text: string, status = 200): Response {
  return new Response(JSON.stringify({
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text }] }],
  }), { status });
}

function scriptedFetch(responses: readonly (Response | Error)[]) {
  const bodies: unknown[] = [];
  const headers: Headers[] = [];
  const events: string[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    events.push("fetch");
    assert.equal(String(url), "https://generativelanguage.googleapis.com/v1/interactions");
    assert.equal(init?.method, "POST");
    const requestHeaders = new Headers(init?.headers);
    headers.push(requestHeaders);
    assert.equal(requestHeaders.get("content-type"), "application/json");
    assert.equal(requestHeaders.get("x-goog-api-key"), API_KEY);
    const body = JSON.parse(String(init?.body)) as {
      store: boolean;
      stream: boolean;
      input: string;
    };
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    bodies.push(body);
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error("unexpected extra Gemini request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, bodies, events, calls: () => index };
}

function options(
  fetchImpl: typeof fetch,
  reserveNextRequest: () => Promise<boolean> = async () => true,
) {
  return { fetch: fetchImpl, firstRequestReserved: true as const, reserveNextRequest };
}

test("one website is sent as a one-element analyses request", async () => {
  const website = facts(1);
  const { fetchImpl, bodies, calls } = scriptedFetch([
    completed(JSON.stringify({ analyses: [analysisFor(website)] })),
  ]);
  let reserves = 0;
  const result = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => {
    reserves += 1;
    return true;
  }));
  assert.equal(calls(), 1);
  assert.equal(reserves, 0);
  assert.equal(result.requestExhausted, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.ok, true);
  const body = bodies[0] as { input: string };
  assert.equal(body.input.startsWith(GEMINI_WEBSITE_BATCH_PROMPT), true);
  const input = JSON.parse(body.input.slice(GEMINI_WEBSITE_BATCH_PROMPT.length + 1)) as unknown[];
  assert.equal(input.length, 1);
  assert.equal((input[0] as { evidenceId: number }).evidenceId, 1);
});

test("five websites are sent in one request", async () => {
  const websites = [1, 2, 3, 4, 5].map((id) => facts(id));
  const { fetchImpl, bodies, calls } = scriptedFetch([
    completed(JSON.stringify({ analyses: websites.map((website) => analysisFor(website)) })),
  ]);
  await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
  assert.equal(calls(), 1);
  assert.equal(GEMINI_WEBSITE_BATCH_SIZE, 5);
  const body = bodies[0] as { input: string };
  const input = JSON.parse(body.input.slice(body.input.indexOf("["))) as unknown[];
  assert.equal(input.length, 5);
  assert.equal(JSON.stringify(input).includes("\"evidenceId\":50"), false);
});

test("more than five websites is rejected before fetch", async () => {
  const websites = [1, 2, 3, 4, 5, 6].map((id) => facts(id));
  let fetches = 0;
  let reserves = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    throw new Error("fetch");
  };
  await assert.rejects(
    () => analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl, async () => {
      reserves += 1;
      return true;
    })),
    (error: unknown) => error instanceof RangeError,
  );
  assert.equal(fetches, 0);
  assert.equal(reserves, 0);
});

test("identity mapping ignores array position", async () => {
  const websites = [1, 2, 3].map((id) => facts(id));
  const { fetchImpl } = scriptedFetch([
    completed(JSON.stringify({
      analyses: [...websites].reverse().map((website) => analysisFor(website)),
    })),
  ]);
  const result = await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
  assert.deepEqual(result.items.map((item) => item.facts.evidenceId), [1, 2, 3]);
  for (const item of result.items) {
    assert.equal(item.ok, true);
    if (item.ok) assert.equal(item.result.analysis.evidenceId, item.facts.evidenceId);
  }
});

test("a missing analysis fails only that website", async () => {
  const websites = [1, 2, 3, 4, 5].map((id) => facts(id));
  const { fetchImpl } = scriptedFetch([
    completed(JSON.stringify({
      analyses: websites.filter((website) => website.evidenceId !== 3).map((website) => analysisFor(website)),
    })),
  ]);
  const result = await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
  const missing = result.items.find((item) => item.facts.evidenceId === 3);
  assert.equal(missing?.ok, false);
  assert.equal(result.items.filter((item) => item.ok).length, 4);
});

test("a duplicate analysis fails that website and persists neither copy", async () => {
  const websites = [1, 2, 3, 4].map((id) => facts(id));
  const duplicated = analysisFor(websites[0]!);
  const { fetchImpl } = scriptedFetch([
    completed(JSON.stringify({
      analyses: [duplicated, duplicated, ...websites.slice(1).map((website) => analysisFor(website))],
    })),
  ]);
  const result = await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
  assert.equal(result.items.find((item) => item.facts.evidenceId === 1)?.ok, false);
  assert.equal(result.items.filter((item) => item.ok).length, 3);
});

test("an unexpected identity persists nothing for that element", async () => {
  const websites = [1, 2].map((id) => facts(id));
  const { fetchImpl } = scriptedFetch([
    completed(JSON.stringify({
      analyses: [...websites.map((website) => analysisFor(website)), analysisFor(facts(99))],
    })),
  ]);
  const result = await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
  assert.equal(result.items.length, 2);
  assert.equal(result.items.every((item) => item.ok), true);
});

test("a mismatched evidence id lead id or lead version fails only that website", async () => {
  const websites = [1, 2].map((id) => facts(id));
  const mismatches = [
    { ...analysisFor(websites[0]!), evidenceId: 99 },
    { ...analysisFor(websites[0]!), leadId: "other-lead" },
    { ...analysisFor(websites[0]!), leadVersion: 99 },
  ];
  for (const mismatched of mismatches) {
    const { fetchImpl } = scriptedFetch([
      completed(JSON.stringify({
        analyses: [mismatched, analysisFor(websites[1]!)],
      })),
    ]);
    const result = await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
    const failed = result.items[0];
    assert.equal(failed?.ok, false);
    if (failed !== undefined && !failed.ok) {
      assert.ok(failed.error instanceof WebsiteAnalysisError);
    }
    assert.equal(result.items[1]?.ok, true);
    if (result.items[1]?.ok) {
      assert.equal(result.items[1].result.analysis.evidenceId, 2);
      assert.equal(result.items[1].result.analysis.leadId, "lead-2");
    }
  }
});

test("four valid analyses persist when one sibling is invalid", async () => {
  const websites = [1, 2, 3, 4, 5].map((id) => facts(id));
  const { fetchImpl, calls } = scriptedFetch([
    completed(JSON.stringify({
      analyses: websites.map((website, index) => analysisFor(website, index === 4 ? "not-a-category" : "seo")),
    })),
  ]);
  const result = await analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl));
  assert.equal(calls(), 1);
  assert.equal(result.items.filter((item) => item.ok).length, 4);
  const invalid = result.items[4];
  assert.equal(invalid?.ok, false);
  if (invalid !== undefined && !invalid.ok) {
    assert.ok(invalid.error instanceof WebsiteAnalysisError);
    assert.equal(invalid.error.code, "INVALID_ANALYSIS");
  }
});

test("an unparseable envelope fails the whole batch", async () => {
  for (const text of ['{"analysis":[]}', "[]"]) {
    const websites = [1, 2].map((id) => facts(id));
    const { fetchImpl, calls } = scriptedFetch([completed(text)]);
    await assert.rejects(
      () => analyzeWebsitesWithGemini(websites, geminiConfig(), options(fetchImpl)),
      (error: unknown) => error instanceof GeminiWebsiteAnalysisError && error.code === "GEMINI_INVALID_RESPONSE",
    );
    assert.equal(calls(), 1);
  }
});

test("a completed HTTP error fails the whole batch without fallback", async () => {
  const { fetchImpl, calls } = scriptedFetch([new Response("nope", { status: 400 })]);
  await assert.rejects(
    () => analyzeWebsitesWithGemini([facts(1)], geminiConfig(), options(fetchImpl)),
    (error: unknown) => error instanceof GeminiWebsiteAnalysisError && error.code === "GEMINI_HTTP_ERROR",
  );
  assert.equal(calls(), 1);
});

test("a transport failure tries the next model only after reserveNextRequest returns true", async () => {
  const website = facts(1);
  const { fetchImpl, events } = scriptedFetch([
    new Error("down"),
    completed(JSON.stringify({ analyses: [analysisFor(website)] })),
  ]);
  const result = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => {
    events.push("reserve");
    return true;
  }));
  assert.deepEqual(events, ["fetch", "reserve", "fetch"]);
  assert.deepEqual(result.attemptedModels, [GEMINI_MODELS[0], GEMINI_MODELS[1]]);
  assert.equal(result.items[0]?.ok, true);
  if (result.items[0]?.ok) {
    assert.equal(result.items[0].result.model, GEMINI_MODELS[1]);
    assert.deepEqual(result.items[0].result.attemptedModels, result.attemptedModels);
  }
});

test("provenance lists only models whose fetch ran", async () => {
  const website = facts(1);
  const { fetchImpl } = scriptedFetch([
    completed(JSON.stringify({ analyses: [analysisFor(website)] })),
  ]);
  const result = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl));
  assert.deepEqual(result.attemptedModels, [GEMINI_MODELS[0]]);
});

test("the first fetch does not call reserveNextRequest", async () => {
  const website = facts(1);
  const { fetchImpl, calls } = scriptedFetch([
    completed(JSON.stringify({ analyses: [analysisFor(website)] })),
  ]);
  let reserves = 0;
  const result = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => {
    reserves += 1;
    return true;
  }));
  assert.equal(reserves, 0);
  assert.equal(calls(), 1);
  assert.deepEqual(result.attemptedModels, [GEMINI_MODELS[0]]);
});

test("fallback reserves the next request before the second fetch", async () => {
  const website = facts(1);
  const { fetchImpl, events } = scriptedFetch([
    new Error("down"),
    completed(JSON.stringify({ analyses: [analysisFor(website)] })),
  ]);
  const result = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => {
    events.push("reserve");
    return true;
  }));
  assert.deepEqual(events, ["fetch", "reserve", "fetch"]);
  assert.deepEqual(result.attemptedModels, [GEMINI_MODELS[0], GEMINI_MODELS[1]]);
});

test("request exhaustion before fallback performs no further fetch", async () => {
  const website = facts(1);
  const { fetchImpl, calls } = scriptedFetch([
    new Error("down"),
    completed(JSON.stringify({ analyses: [analysisFor(website)] })),
  ]);
  const result = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => false));
  assert.equal(calls(), 1);
  assert.equal(result.requestExhausted, true);
  assert.deepEqual(result.attemptedModels, [GEMINI_MODELS[0]]);
});

test("an unsuccessful fetch still consumes the already reserved first unit", async () => {
  const events: string[] = [];
  const fetchImpl: typeof fetch = async () => {
    events.push("fetch");
    return new Response("nope", { status: 500 });
  };
  await assert.rejects(
    () => analyzeWebsitesWithGemini([facts(1)], geminiConfig(), options(fetchImpl, async () => {
      events.push("reserve");
      return true;
    })),
    (error: unknown) => error instanceof GeminiWebsiteAnalysisError && error.code === "GEMINI_HTTP_ERROR",
  );
  assert.deepEqual(events, ["fetch"]);
});

test("a retry call has its own attempted model list", async () => {
  const website = facts(1);
  const envelope = JSON.stringify({ analyses: [analysisFor(website)] });
  const { fetchImpl } = scriptedFetch([
    new Error("down"),
    completed(envelope),
    completed(envelope),
  ]);
  const first = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => true));
  const second = await analyzeWebsitesWithGemini([website], geminiConfig(), options(fetchImpl, async () => true));
  assert.deepEqual(first.attemptedModels, [GEMINI_MODELS[0], GEMINI_MODELS[1]]);
  assert.deepEqual(second.attemptedModels, [GEMINI_MODELS[0]]);
});
