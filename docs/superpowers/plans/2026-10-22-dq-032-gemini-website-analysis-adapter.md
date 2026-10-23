# DQ-032 Gemini Website Analysis Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analyze one `WebsiteFacts` value with Gemini using direct REST and transport-only Flash-model fallback, then validate it through DQ-031.

**Architecture:** Keep one small Gemini-specific adapter under `website-analysis`. Central config enables or disables it. A fixed prompt and structured response shape guide Gemini, while DQ-031 remains the final validator. No generic AI framework or DQ-033 orchestration is added.

**Tech Stack:** TypeScript, Node.js built-in `fetch`/`AbortController`, `node:test`, existing DQ-031 validator.

**Spec:** `docs/superpowers/specs/2026-10-22-dq-032-gemini-website-analysis-adapter-design.md`

## Global Constraints

- Implement only the approved spec and this plan. Do not edit the spec or this plan. Do not start DQ-033.
- Builder execution creates `feature/dq-032-gemini-website-analysis-adapter` from the approved plan commit on `design/dq-032-gemini-website-analysis-adapter`. Do not implement on `main` or on the design branch.
- Builder execution leaves the final implementation unstaged and uncommitted for Analyst review. The commit commands in each task are checkpoints for after APPROVED. Do not run them during Builder execution. Do not push, open a pull request, or merge in this plan.
- One `WebsiteFacts` value goes to the Gemini Interactions API, then immediate transport-only model fallback, then one structured candidate, then `validateWebsiteAnalysis()`, then one `WebsiteAnalysis` plus minimal Gemini provenance.
- The public operation is exactly `analyzeWebsiteWithGemini(facts: WebsiteFacts, config: GeminiWebsiteAnalysisConfig, options?: GeminiWebsiteAnalysisOptions): Promise<GeminiWebsiteAnalysisResult>`.
- `GeminiWebsiteAnalysisOptions` is `Readonly<{ fetch?: typeof fetch }>`. That is the only injected seam. It is not a factory, registry, container, or timeout configuration.
- `GeminiModel` is exactly `"gemini-3.8-flash" | "gemini-3.6-flash" | "gemini-3.5-flash-lite" | "gemini-3.1-flash-lite"`, attempted in that order. Do not send `gemini-3.5-flash` or `gemini-3.7-flash`. One attempt per model. No same-model retry.
- `GeminiWebsiteAnalysisResult` is `Readonly<{ analysis: WebsiteAnalysis; provider: "gemini"; model: GeminiModel; attemptedModels: readonly GeminiModel[] }>`. Freeze the result root and a new `attemptedModels` array. DQ-031 already freezes `analysis`. Do not add tokens, cost, latency, request id, interaction id, timestamps, or fallback depth.
- Extend `loadConfig`. Do not add a second loader. `WebsiteAnalysisConfig` is `{ provider: "disabled" }` or `GeminiWebsiteAnalysisConfig`. `GeminiWebsiteAnalysisConfig` is `{ provider: "gemini"; apiKey: string }`.
- Environment variables are `WEBSITE_ANALYSIS_PROVIDER` and `GEMINI_API_KEY`. Missing provider and exact `disabled` are disabled. Exact `gemini` plus a valid key is enabled. Exact `gemini` plus a missing or invalid key is a configuration error. Any other provider string is a configuration error. Do not case-fold.
- Key validity matches Geoapify: empty, whitespace, or a control character is invalid, using the existing `whitespaceOrControlCharacterPattern` in `src/config/env.ts`. A disabled provider ignores an unused Gemini key. A key alone never activates Gemini. Config objects stay frozen. Parsing performs no network I/O.
- Configuration errors use a new `WebsiteAnalysisConfigurationError` in `src/config/errors.ts`, same style as `DiscoveryConfigurationError`, not coupled to it, and not used for transport failures. Messages name the variable, use fixed text, do not include the rejected provider input, and never include the API key.
- Direct REST only. `POST https://generativelanguage.googleapis.com/v1/interactions` with header `x-goog-api-key`. Body is single-turn and non-streaming, `store: false`, `stream: false`, and has no `previous_interaction_id`. No Google GenAI SDK and no HTTP library.
- Each request aborts after `30_000` milliseconds through `AbortController` and `setTimeout`. A fetch rejection, including that abort, is transport failure. A completed response with a status code is an HTTP response. Status 200–299 is success. Every other status is `GEMINI_HTTP_ERROR` and stops the chain. Do not read a non-2xx body into the error.
- Send only these `WebsiteFacts` fields: `evidenceId`, `leadId`, `leadVersion`, `requestedUrl`, `finalUrl`, `title`, `metaDescription`, `documentLanguage`, `hasViewport`, `h1Count`, `headingCount`, `imageCount`, `imagesWithoutAlt`, `formCount`, `internalLinkCount`, `externalLinkCount`, `visibleText`. No raw HTML, database lookup, private contacts, internal notes, or secrets in the prompt.
- One fixed prompt. Categories are design, usability, seo, accessibility, and conversion. Severities are low, medium, and high. Each finding needs observation, evidence, and recommendation. The prompt prohibits invented facts, unsupported visual inference, qualification, contact recommendations, outreach, scores, and extra semantic fields.
- `response_format` shapes those fields only. Do not put `minItems`, `maxItems`, `minLength`, `maxLength`, `additionalProperties`, an 8-total cap, a 3-per-category cap, or identity correctness in the provider schema. Always pass the parsed candidate through `validateWebsiteAnalysis`. Propagate `WebsiteAnalysisError` unchanged. Do not wrap it and do not fall back.
- Runtime codes are `GEMINI_TRANSPORT_UNAVAILABLE`, `GEMINI_HTTP_ERROR`, and `GEMINI_INVALID_RESPONSE`. Transport-unavailable is thrown only after all four models fail with no HTTP response. Invalid response is a 2xx payload that cannot yield the structured candidate. Fixed messages do not interpolate the API key, status text, raw body, Gemini content, or prompt.
- The 90-second deferred retry is DQ-033. Do not implement it. Do not add a multi-website batch, sequential batch runner, retry scheduler, 50/day limit, daily timezone accounting, persistence, D1, SQLite, migrations, analysis tables, Groq, Workers AI, OpenRouter, a cross-provider router, qualification, scoring, contacts, do-not-contact execution, email, a scheduler, GitHub Actions, queues, background workers, an AI SDK, token accounting, cost accounting, or latency metrics.
- No new npm dependency. Do not modify `package.json` or `package-lock.json`. No new npm script. No source-text grep test. No fake-timer library. No production clock abstraction.
- Tests use `node:test` and `node:assert/strict`. Extend `tests/unit/config-env.test.ts`. Add `tests/unit/gemini-website-analysis.test.ts`. The targeted command mirrors `scripts/run-tests.cjs`. Run it from the repository root. `.test-build/` is gitignored. This repo's shell is zsh, where `status` is read-only, so the command uses `exit_code`.

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/FILE.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

Replace `FILE` with `config-env` or `gemini-website-analysis`. Final verification is `npm test`, `npm run typecheck`, and `git diff --check`.
- During this planning task, do not edit `docs/PLAN.md` or `docs/BACKLOG.md`. At later integration, Task 3 synchronizes them. Until that implementation is ready, DQ-032 stays Planned and Phase 3 stays Current.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one is owned by the named test.

1. **429 and 5xx are HTTP responses and must not fall back.** Test: `HTTP 429 does not fall back to another model` and `HTTP 500 does not fall back to another model` in Task 2.
2. **A 30-second no-response timeout does fall back.** The test forces the 30_000 millisecond timer to abort immediately and does not wait 30 seconds. Test: `30-second no-response abort advances to the next model` in Task 3.
3. **A DQ-031 validation failure propagates unchanged and does not fall back.** Test: `propagates a DQ-031 validation failure without fallback` in Task 3.
4. **`attemptedModels` records the exact ordered attempts, including success.** Test: `records every transport attempt through gemini-3.1-flash-lite` in Task 3.
5. **`GEMINI_API_KEY` cannot leak through configuration or runtime errors.** Tests: `rejects an empty, whitespace, or control Gemini key without echoing it` in Task 1, and `runtime errors do not echo the API key, prompt, or response body` in Task 2.

## File structure

Create:

- `src/website-analysis/providers/gemini/gemini-provider.ts` — the public function, one POST, the 30-second abort, candidate reading, and the four-model loop.
- `src/website-analysis/providers/gemini/prompt.ts` — the fixed prompt text and the `response_format` object.
- `src/website-analysis/providers/gemini/errors.ts` — the three runtime codes and `GeminiWebsiteAnalysisError`.
- `src/website-analysis/providers/gemini/index.ts` — re-exports only.
- `tests/unit/gemini-website-analysis.test.ts` — adapter behavior.

Modify:

- `src/config/errors.ts` — add `WebsiteAnalysisConfigurationError`.
- `src/config/env.ts` — parse `websiteAnalysis` inside `loadConfig`.
- `src/config/index.ts` — export the new config types and error.
- `tests/unit/config-env.test.ts` — cover the new provider and update full-config expectations.
- `src/website-analysis/index.ts` — re-export the public adapter.
- `docs/PLAN.md` and `docs/BACKLOG.md` — Task 3 integration only, not this planning task.

`http.ts` from the design sketch is intentionally combined into `gemini-provider.ts`. This adapter makes one JSON POST. It does not need Geoapify's streaming reader, content-type policy, or byte cap, so a separate HTTP file would only move that one call.

## Locked algorithms

Task 2 owns `selectFacts`, `readCandidate`, and `requestModel`. Task 3 owns the loop. Do not replace either with a retry library or a provider framework.

### Selected facts

```ts
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
```

### Candidate reading

A 2xx payload yields a candidate only when `status` is `"completed"`, the last step of type `"model_output"` has exactly one content part, that part has `type: "text"` and a string `text`, and `JSON.parse(text)` succeeds. Ignore earlier non-output steps. Ignore `id`, `usage`, `created`, and `updated`. Any other 2xx shape, including a refusal sentence in that text part, throws `GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE")`. Do not catch `WebsiteAnalysisError` here. `validateWebsiteAnalysis` runs only after this function returns.

```ts
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
```

### One request

`requestModel` returns `{ type: "transport" }` when `fetch` rejects or the abort fires. It throws `GEMINI_HTTP_ERROR` for a completed status outside 200–299 without reading that body into the error. It throws `GEMINI_INVALID_RESPONSE` when `response.json()` fails or `readCandidate` fails. It returns `{ type: "candidate"; candidate: unknown }` otherwise. The timeout is cleared in `finally`.

```ts
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1/interactions";
const GEMINI_REQUEST_TIMEOUT_MILLISECONDS = 30_000;

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
```

### Four-model loop

Push a model only when its attempt starts. Copy that array before freezing it. `validateWebsiteAnalysis` is outside the transport catch, so `WebsiteAnalysisError` propagates. HTTP and invalid-response errors also propagate. Continue only on `{ type: "transport" }`.

```ts
const attempted: GeminiModel[] = [];
for (const model of GEMINI_MODELS) {
  attempted.push(model);
  const outcome = await requestModel(model, facts, config.apiKey, fetchImpl);
  if (outcome.type === "transport") continue;
  const analysis = validateWebsiteAnalysis(facts, outcome.candidate);
  return Object.freeze({
    analysis,
    provider: "gemini" as const,
    model,
    attemptedModels: Object.freeze([...attempted]),
  });
}
throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
```

`GEMINI_MODELS` is exactly `["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]`.

---

### Task 1: Central website-analysis configuration

**Files:**
- Modify: `src/config/errors.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/index.ts`
- Test: `tests/unit/config-env.test.ts`

**Interfaces:**
- Consumes: `loadConfig(environment: EnvironmentVariables): AppConfig` and `whitespaceOrControlCharacterPattern`.
- Produces: `WebsiteAnalysisConfig`, `GeminiWebsiteAnalysisConfig`, `WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES`, `WebsiteAnalysisConfigurationError`, and `AppConfig.websiteAnalysis`.

- [ ] **Step 1: Write the failing config tests**

Add this import beside `DiscoveryConfigurationError`:

```ts
import {
  DiscoveryConfigurationError,
  WebsiteAnalysisConfigurationError,
  loadConfig,
} from "../../src/config";
```

In `uses development defaults for an empty environment`, add `websiteAnalysis: { provider: "disabled" }` to the expected object and `assert.ok(Object.isFrozen(config.websiteAnalysis))` beside the discovery freeze. In `parses valid environment and log level values`, add the same `websiteAnalysis` field to the expected object.

Append these tests:

```ts
test("missing website analysis provider is disabled", () => {
  const websiteAnalysis = loadConfig({}).websiteAnalysis;
  assert.deepEqual(websiteAnalysis, { provider: "disabled" });
  assert.equal("apiKey" in websiteAnalysis, false);
  assert.ok(Object.isFrozen(websiteAnalysis));
});

test("explicit disabled website analysis ignores a malformed Gemini key", () => {
  for (const apiKey of ["", "   ", "bad key", "bad\u0000key", "synthetic-unused-gemini-key"]) {
    const config = loadConfig({
      WEBSITE_ANALYSIS_PROVIDER: "disabled",
      GEMINI_API_KEY: apiKey,
    });
    assert.deepEqual(config.websiteAnalysis, { provider: "disabled" });
    assert.equal("apiKey" in config.websiteAnalysis, false);
    if (apiKey.length > 0) assert.equal(JSON.stringify(config).includes(apiKey), false);
  }
});

test("a Gemini key alone does not activate website analysis", () => {
  const config = loadConfig({ GEMINI_API_KEY: "synthetic-gemini-key" });
  assert.deepEqual(config.websiteAnalysis, { provider: "disabled" });
  assert.equal(JSON.stringify(config).includes("synthetic-gemini-key"), false);
});

test("gemini plus a valid key is enabled and frozen", () => {
  const apiKey = "synthetic.Gemini_key-42";
  const config = loadConfig({
    WEBSITE_ANALYSIS_PROVIDER: "gemini",
    GEMINI_API_KEY: apiKey,
  });
  assert.deepEqual(config.websiteAnalysis, { provider: "gemini", apiKey });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.websiteAnalysis));
});

test("gemini requires its own key", () => {
  assert.throws(
    () => loadConfig({ WEBSITE_ANALYSIS_PROVIDER: "gemini", GEOAPIFY_API_KEY: "other-key" }),
    (error: unknown) => {
      assert.ok(error instanceof WebsiteAnalysisConfigurationError);
      assert.equal(error.code, "MISSING_GEMINI_API_KEY");
      assert.equal(error.message, "GEMINI_API_KEY is required when website analysis provider is gemini.");
      assert.equal(error.message.includes("other-key"), false);
      return true;
    },
  );
});

test("rejects an empty, whitespace, or control Gemini key without echoing it", () => {
  const invalidKeys = ["", "   ", " padded", "padded ", "two words", "line\nbreak", "tab\tkey", "nul\u0000key", "delete\u007fkey"];
  for (const apiKey of invalidKeys) {
    assert.throws(
      () => loadConfig({ WEBSITE_ANALYSIS_PROVIDER: "gemini", GEMINI_API_KEY: apiKey }),
      (error: unknown) => {
        assert.ok(error instanceof WebsiteAnalysisConfigurationError);
        assert.equal(error.code, "INVALID_GEMINI_API_KEY");
        assert.equal(error.message, "GEMINI_API_KEY is invalid.");
        if (apiKey.length > 0) {
          assert.equal(error.message.includes(apiKey), false);
          assert.equal(JSON.stringify(error).includes(apiKey), false);
        }
        return true;
      },
    );
  }
});

test("rejects an unknown website analysis provider without echoing it", () => {
  for (const provider of ["", "   ", " gemini", "gemini ", "Gemini", "GEMINI", "not-gemini", "groq", "unknown-provider-sentinel"]) {
    assert.throws(
      () => loadConfig({ WEBSITE_ANALYSIS_PROVIDER: provider, GEMINI_API_KEY: "bad key" }),
      (error: unknown) => {
        assert.ok(error instanceof WebsiteAnalysisConfigurationError);
        assert.equal(error.code, "INVALID_PROVIDER");
        assert.equal(error.message, "Invalid WEBSITE_ANALYSIS_PROVIDER. Expected disabled or gemini.");
        assert.equal(error.message.includes("bad key"), false);
        assert.equal(error.message.includes("unknown-provider-sentinel"), false);
        assert.equal(error.message.includes("not-gemini"), false);
        assert.equal(error.message.includes("Gemini"), false);
        return true;
      },
    );
  }
});

test("website analysis configuration parsing does not call fetch", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network access is forbidden during configuration parsing");
  }) as typeof fetch;
  try {
    loadConfig({ WEBSITE_ANALYSIS_PROVIDER: "gemini", GEMINI_API_KEY: "synthetic-offline-key" });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the config test to verify it fails**

Run the targeted command with `FILE` set to `config-env`.

Expected: FAIL before `node --test`. TypeScript reports `TS2305` because `WebsiteAnalysisConfigurationError` is not exported from `src/config`.

- [ ] **Step 3: Add the configuration parser**

Append to `src/config/errors.ts`, leaving `DiscoveryConfigurationError` unchanged:

```ts
export const WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES = [
  "INVALID_PROVIDER",
  "MISSING_GEMINI_API_KEY",
  "INVALID_GEMINI_API_KEY",
] as const;

export type WebsiteAnalysisConfigurationErrorCode =
  (typeof WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES)[number];

const websiteAnalysisMessages: Readonly<Record<WebsiteAnalysisConfigurationErrorCode, string>> = {
  INVALID_PROVIDER: "Invalid WEBSITE_ANALYSIS_PROVIDER. Expected disabled or gemini.",
  MISSING_GEMINI_API_KEY: "GEMINI_API_KEY is required when website analysis provider is gemini.",
  INVALID_GEMINI_API_KEY: "GEMINI_API_KEY is invalid.",
};

export class WebsiteAnalysisConfigurationError extends Error {
  readonly name = "WebsiteAnalysisConfigurationError";

  constructor(readonly code: WebsiteAnalysisConfigurationErrorCode) {
    super(websiteAnalysisMessages[code]);
  }
}
```

In `src/config/env.ts`, import `WebsiteAnalysisConfigurationError`. Add:

```ts
export type WebsiteAnalysisConfig =
  | Readonly<{ provider: "disabled" }>
  | GeminiWebsiteAnalysisConfig;

export type GeminiWebsiteAnalysisConfig = Readonly<{
  provider: "gemini";
  apiKey: string;
}>;
```

Add `readonly websiteAnalysis: WebsiteAnalysisConfig` to `AppConfig`. Add `parseWebsiteAnalysisConfig` beside discovery parsing. It uses the existing `whitespaceOrControlCharacterPattern`. Missing or `"disabled"` returns `Object.freeze({ provider: "disabled" })` without inspecting `GEMINI_API_KEY`. `"gemini"` with `GEMINI_API_KEY === undefined` throws `MISSING_GEMINI_API_KEY`. An empty key, or a key matching the existing pattern, throws `INVALID_GEMINI_API_KEY`. Any other provider string throws `INVALID_PROVIDER`. A valid pair returns `Object.freeze({ provider: "gemini", apiKey })`. Call it from `loadConfig` and put `websiteAnalysis` on the frozen `AppConfig`.

Export the new codes, class, code type, `WebsiteAnalysisConfig`, and `GeminiWebsiteAnalysisConfig` from `src/config/index.ts`.

- [ ] **Step 4: Run the config test to verify it passes**

Run the same targeted command.

Expected: PASS. Existing discovery tests still pass.

- [ ] **Step 5: Commit checkpoint**

Documentation only. Do not run this during Builder execution.

```bash
git add src/config/errors.ts src/config/env.ts src/config/index.ts tests/unit/config-env.test.ts
git commit -m "feat: configure Gemini website analysis"
```

### Task 2: One-model request, prompt, and runtime errors

**Files:**
- Create: `src/website-analysis/providers/gemini/errors.ts`
- Create: `src/website-analysis/providers/gemini/prompt.ts`
- Create: `src/website-analysis/providers/gemini/gemini-provider.ts`
- Create: `src/website-analysis/providers/gemini/index.ts`
- Test: `tests/unit/gemini-website-analysis.test.ts`

**Interfaces:**
- Consumes: `GeminiWebsiteAnalysisConfig` from `src/config/env.ts`, `WebsiteFacts`, and `validateWebsiteAnalysis`.
- Produces: `GEMINI_MODELS`, `GeminiModel`, `GeminiWebsiteAnalysisOptions`, `GeminiWebsiteAnalysisResult`, `GeminiWebsiteAnalysisError`, `GEMINI_WEBSITE_ANALYSIS_ERROR_CODES`, and `analyzeWebsiteWithGemini`. Task 2 calls only `"gemini-3.8-flash"`. Task 3 replaces that single call with the four-model loop. `requestModel` stays as specified above.

- [ ] **Step 1: Write the failing one-model tests**

Create `tests/unit/gemini-website-analysis.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { GeminiWebsiteAnalysisConfig } from "../../src/config/env";
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
```

The provider schema asserted above has no `minItems`, `maxItems`, `minLength`, `maxLength`, or `additionalProperties`.

- [ ] **Step 2: Run the adapter test to verify it fails**

Run the targeted command with `FILE` set to `gemini-website-analysis`.

Expected: FAIL before `node --test`. TypeScript reports `TS2307` because `src/website-analysis/providers/gemini` does not exist.

- [ ] **Step 3: Implement one model**

Create `errors.ts` in the website-analysis runtime style: a frozen code array in the order `GEMINI_TRANSPORT_UNAVAILABLE`, `GEMINI_HTTP_ERROR`, `GEMINI_INVALID_RESPONSE`; messages `Gemini transport is unavailable.`, `Gemini returned an HTTP error.`, and `Gemini response is invalid.`; `readonly name = "GeminiWebsiteAnalysisError"`; `constructor(readonly code)`; no `cause`.

Create `prompt.ts` exporting `GEMINI_WEBSITE_ANALYSIS_PROMPT` and `GEMINI_RESPONSE_FORMAT` with the exact values the request test asserts.

Create `gemini-provider.ts` with `GEMINI_MODELS`, `GeminiModel`, `GeminiWebsiteAnalysisOptions`, `GeminiWebsiteAnalysisResult`, `selectFacts`, `readCandidate`, and `requestModel` as specified in Locked algorithms. `analyzeWebsiteWithGemini` uses `options?.fetch ?? globalThis.fetch`, calls `requestModel` only with `"gemini-3.8-flash"`, throws `GEMINI_TRANSPORT_UNAVAILABLE` when that one outcome is transport, calls `validateWebsiteAnalysis(facts, outcome.candidate)` on a candidate, and returns the frozen envelope whose `attemptedModels` is `Object.freeze(["gemini-3.8-flash"])`. Do not catch `WebsiteAnalysisError`.

Create `index.ts` re-exporting the public function, constants, error class, and types. Do not export `requestModel`.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run the same targeted command.

Expected: PASS. No request waits 30 seconds. The single transport-failure test passes because the only attempted model failed.

- [ ] **Step 5: Commit checkpoint**

Documentation only. Do not run this during Builder execution.

```bash
git add src/website-analysis/providers/gemini tests/unit/gemini-website-analysis.test.ts
git commit -m "feat: request one Gemini website analysis"
```

### Task 3: Transport-only fallback, DQ-031 propagation, and exports

**Files:**
- Modify: `src/website-analysis/providers/gemini/gemini-provider.ts`
- Modify: `src/website-analysis/index.ts`
- Modify: `tests/unit/gemini-website-analysis.test.ts`
- Modify at integration: `docs/PLAN.md`
- Modify at integration: `docs/BACKLOG.md`

**Interfaces:**
- Consumes: `requestModel`, `GEMINI_MODELS`, `validateWebsiteAnalysis`, and `WebsiteAnalysisError`.
- Produces: the same `analyzeWebsiteWithGemini` signature, now walking all four models. `src/website-analysis/index.ts` re-exports that function, `GEMINI_MODELS`, `GeminiWebsiteAnalysisError`, `GEMINI_WEBSITE_ANALYSIS_ERROR_CODES`, and the types `GeminiModel`, `GeminiWebsiteAnalysisOptions`, and `GeminiWebsiteAnalysisResult`.

- [ ] **Step 1: Write the failing chain tests**

Append to `tests/unit/gemini-website-analysis.test.ts`. Reuse `facts`, `candidate`, `geminiConfig`, `API_KEY`, `interactionResponse`, and `scriptedFetch` from that file. Import `WebsiteAnalysisError` from `../../src/website-analysis`.

```ts
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
```

- [ ] **Step 2: Run the adapter test to verify the new chain fails**

Run the targeted command with `FILE` set to `gemini-website-analysis`.

Expected: FAIL with exit code 1. `transport failure on gemini-3.8-flash continues to gemini-3.6-flash` rejects with `GEMINI_TRANSPORT_UNAVAILABLE` after one attempt. The Task 2 HTTP and malformed tests still pass.

- [ ] **Step 3: Implement the four-model loop**

Replace the single `"gemini-3.8-flash"` call in `analyzeWebsiteWithGemini` with the locked four-model loop. Keep `requestModel`, `readCandidate`, `selectFacts`, the prompt, and the error class. Do not add a retry counter, a 90-second timer, or a second provider.

Re-export the public function, `GEMINI_MODELS`, the runtime error, its code array, and the Gemini types from `src/website-analysis/index.ts`. Leave the existing facts and DQ-031 exports unchanged.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run the same targeted command.

Expected: PASS, including the Task 2 tests. The timeout test finishes without waiting 30 seconds.

- [ ] **Step 5: Synchronize the living docs**

Do this when the implementation is ready, before the Analyst's APPROVED commit. Do not do it during planning.

In `docs/PLAN.md` and `docs/BACKLOG.md`:

- Phase 3 stays Current and is not complete.
- DQ-032 becomes Completed. DQ-033 and later stay Planned. Split the combined DQ-032–039 backlog heading so DQ-032 is its own completed item and DQ-033–039 remain planned.
- The next planned step is the bounded multi-website analysis run: sequential processing, one deferred retry after at least 90 seconds, continue the remaining websites, and the daily run/budget policy. That run is not implemented.
- Say that one `WebsiteFacts` value can be analyzed with Gemini through direct REST. Single-website Gemini analysis exists.
- Say that multi-website analysis, the 90-second retry, the 50/day budget, persistence, qualification, contacts, and outreach do not exist yet.
- Do not describe a generic AI framework, provider registry, or cross-provider router. Groq, Cloudflare Workers AI, and OpenRouter stay unimplemented.

Remove the claims that the Gemini adapter is only planned and that no real AI website analysis exists. Those claims become false once this implementation is ready.

- [ ] **Step 6: Run final verification**

```bash
npm test
npm run typecheck
git diff --check
```

Expected: `npm test` passes with 0 failures and 0 skips, `npm run typecheck` passes, and `git diff --check` prints nothing.

- [ ] **Step 7: Commit checkpoint**

Documentation only. Do not run this during Builder execution. Leave every implementation and documentation change unstaged and uncommitted until the Analyst records APPROVED.

```bash
git add src/website-analysis/providers/gemini/gemini-provider.ts src/website-analysis/index.ts tests/unit/gemini-website-analysis.test.ts docs/PLAN.md docs/BACKLOG.md
git commit -m "feat: fall back across Gemini Flash models"
```

Expected unstaged paths before that later commit, and no others: the Task 1 config files, the Gemini provider files, both test files, `src/website-analysis/index.ts`, `docs/PLAN.md`, and `docs/BACKLOG.md`. `package.json` and `package-lock.json` stay unchanged. Do not push.
