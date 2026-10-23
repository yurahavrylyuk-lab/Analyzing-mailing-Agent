# DQ-036 Manual Authenticated Website Analysis Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manually invokable authenticated analysis route to the existing production Worker that safely invokes the existing DQ-035 D1 website-analysis pipeline.

**Architecture:** Add `POST /internal/analysis/run` inside the existing `delta-qoralis-crawl-gateway` handler. The route checks `ANALYSIS_GATEWAY_TOKEN`, accepts only `{ maxItems }` for an integer from 0 through 50, builds `{ provider: "gemini", apiKey }` from `GEMINI_API_KEY`, and calls `runD1WebsiteAnalysisPipeline` once. Crawl routes and DQ-035 internals stay unchanged.

**Tech Stack:** TypeScript, Node test runner, Cloudflare Worker, D1, Miniflare, Gemini REST integration through existing DQ-032 adapter.

**Spec:** `docs/superpowers/specs/2026-10-23-dq-036-manual-authenticated-website-analysis-runtime-design.md`

## Global Constraints

Every task includes this section.

- Delta Qoralis is the company. Analyzing and Mailing Agent is the agent. Do not describe the agent as Delta Qoralis. The Worker name `delta-qoralis-crawl-gateway` stays. Do not rename it and do not create a second Worker.
- Implement only the approved spec and this plan. Do not edit the spec, this plan, `docs/PLAN.md`, or `docs/BACKLOG.md`. Do not start DQ-037 or any later slice.
- Builder execution creates `feature/dq-036-manual-authenticated-website-analysis-runtime` from the approved plan commit on `design/dq-036-manual-authenticated-website-analysis-runtime`. Do not implement on `main` or on the design branch.
- Do not commit, push, or open a pull request during Builder execution. Each task's commit command is the review boundary. Leave the work uncommitted until the Analyst records APPROVED.
- One existing handler: `handleCrawlGatewayRequest` in `src/crawl-gateway/worker.ts`. The default `fetch` still calls it with `request` and `env` only. No router, HTTP framework, service container, generic authentication service, repository, factory, dependency-injection framework, or middleware.
- Keep the new route code in `worker.ts` as private functions. Do not add a second source module.
- Crawl routes remain `POST /internal/crawl/select` and `POST /internal/crawl/evidence`, authorized only with `CRAWL_GATEWAY_TOKEN`. Analysis is authorized only with `ANALYSIS_GATEWAY_TOKEN`. Neither token authorizes the other route.
- Analysis authentication matches the current crawl check: `Bearer ` prefix, UTF-8 byte-length check, then `timingSafeEqual`. A configured token that is missing, not a string, or length 0 fails closed. Do not trim tokens. A private shared comparison used by both checks is allowed. Do not export it.
- Request safety stays on `hasJsonContentType`, `hasAllowedContentLength`, `readJsonBody`, and `hasExactlyKeys`. Accepted content types remain exactly `application/json` and `application/json; charset=utf-8`. `MAX_BODY_BYTES` stays `3145728`. A missing `content-length` stays allowed. A present `content-length` must match `^(?:0|[1-9][0-9]*)$` and be at most `3145728`. Do not add a parser.
- The analysis body has exactly one own key, `maxItems`. Accept only `typeof maxItems === "number" && Number.isInteger(maxItems) && maxItems >= 0 && maxItems <= 50`. `0`, `1`, and `50` are valid. Do not accept numeric strings. Do not add a `NaN` token. `JSON.parse` does not produce `NaN`.
- Do not call `loadConfig()`. Validate `GEMINI_API_KEY` locally with the same rule as private `parseWebsiteAnalysisConfig`: not a string or `undefined` is missing, length 0 is invalid, and `/[\s\u0000-\u001f\u007f-\u009f]/u` is invalid. A valid key becomes `Object.freeze({ provider: "gemini", apiKey })`. Do not trim the key. Do not throw `WebsiteAnalysisConfigurationError` across HTTP.
- Check order for the analysis path: unknown path or non-empty query string returns 404; non-POST returns 405; analysis auth returns 401; content type, length, JSON, and `maxItems` return 400; Gemini config returns 500; then the pipeline runs once. A missing token is 401 even when the Gemini key is missing. An invalid `maxItems` is 400 even when the Gemini key is missing. An invalid Gemini key does not call the pipeline, including when `maxItems` is 0.
- Call `runD1WebsiteAnalysisPipeline(env.DB, geminiConfig, maxItems)` with three arguments. Do not pass `analysisRunOptions` or `storedAt`. Do not reproduce selection SQL, `evidenceFromRow`, facts extraction, Gemini transport, model fallback, the 90-second retry, analysis validation, persistence, `storedAt`, or summary arithmetic. Do not return a local zero summary for `maxItems` 0. DQ-035 already returns before D1 and before Gemini in that case.
- Pass `env.DB` through with no cast. `D1CrawlDatabase` and `D1WebsiteAnalysisPipelineDatabase` are the same structural `prepare` shape. If `tsc` rejects that argument, give `CrawlGatewayEnv["DB"]` one private structural type in `worker.ts` that `selectD1CrawlCandidates`, `persistD1CrawlEvidence`, and `runD1WebsiteAnalysisPipeline` all accept. Do not change `src/crawler/d1-crawl-store.ts` or the pipeline file, and do not import a Cloudflare SDK type.
- Success is HTTP 200 and a new object with only `selected`, `succeeded`, `failed`, `retried`, and `persisted`, in that order, copied from the pipeline result. Fixed failures stay on the existing helpers: 404 `{ "error": "not_found" }`, 405 `{ "error": "method_not_allowed" }`, 401 `{ "error": "unauthorized" }`, 400 `{ "error": "invalid_request" }`, 500 `{ "error": "internal_error" }`. A pipeline throw, including `D1WebsiteAnalysisPipelineError`, is 500. Do not map that error's code to 400. Do not put `error.message`, SQL, HTML, findings, the prompt, either token, or the Gemini key in a response. Do not log them.
- The optional test seam is `dependencies?: CrawlGatewayDependencies` on `handleCrawlGatewayRequest`. `runPipeline` defaults to `runD1WebsiteAnalysisPipeline`. Production `fetch` does not pass `dependencies`. No mocking framework.
- Tests use `node:test` and `node:assert/strict`. No real Gemini, no production D1, and no outbound network. Do not add an npm script. This shell is zsh, so targeted commands use `exit_code`, not `status`. `.test-build/` is gitignored.
- Do not modify `wrangler.toml`, `package.json`, `package-lock.json`, `tsconfig.json`, `migrations/`, `.github/`, `src/config/env.ts`, `src/website-analysis/**`, or the existing crawl test files. New Worker fields stay optional so those tests still typecheck. No secret values in `wrangler.toml`. No second D1 binding, scheduler, cron, or GitHub Actions analysis workflow.
- Exclusions: second Worker, Worker rename, automatic analysis, 50/day accounting, daily Gemini budget, usage, token, cost, or latency ledger, failure-history persistence, analysis-attempt history, cross-run retry accounting, locks, leases, claims, queues, background worker, new Gemini retry behavior, new Gemini models, new provider abstraction, Groq, Cloudflare Workers AI, OpenRouter, qualification, lead scoring, contact discovery, DNC changes, outreach, mailing, email sending, SQLite website-analysis persistence, and any architecture for DQ-037 through DQ-040.
- Secret configuration and deployment are not Builder work. Do not run `wrangler secret`, deploy, or call production.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one has the named test in the owning task.

1. **Cross-use of the two tokens.** A crawl Bearer token must not run analysis, and an analysis Bearer token must not run crawl selection. Tests: `CRAWL_GATEWAY_TOKEN does not authorize the analysis route` in Task 1, and `ANALYSIS_GATEWAY_TOKEN does not authorize a crawl route` in Task 3.
2. **Missing Worker analysis token.** An absent or empty `ANALYSIS_GATEWAY_TOKEN` fails closed even when the presented header looks well formed. Test: `a missing or empty configured analysis token fails closed` in Task 1.
3. **Malformed or excess request body.** An extra field, malformed JSON, and a body above the existing cap are rejected before Gemini config and before the pipeline. Test: `malformed, oversized, and extra-field analysis bodies are rejected` in Task 1.
4. **Invalid Gemini key leaking into a response.** Whitespace or a control character makes the key invalid, the fixed 500 body does not contain that key, and the pipeline is not called. Test: `an invalid Gemini key returns a fixed 500 and does not echo the key` in Task 1.
5. **Pipeline exception leaking implementation details.** A thrown error whose message contains the Gemini key and the pipeline's own message becomes the fixed 500 body, not HTTP 400. Test: `a thrown pipeline error becomes a fixed 500 without the thrown text` in Task 2.

## File structure

Modify:

- `src/crawl-gateway/worker.ts` — extend `CrawlGatewayEnv`, add the analysis path, separate analysis auth, local Gemini-key validation, one pipeline call, and the safe summary. Crawl behavior stays.

Create:

- `tests/unit/crawl-gateway-analysis.test.ts` — offline handler tests for the analysis route, the token split, Gemini config, the pipeline seam, and crawl regression around that split.

Test without modifying:

- `tests/unit/crawl-gateway-worker.test.ts` — existing crawl HTTP regression.
- `tests/integration/crawl-gateway-d1.test.ts` — existing Miniflare crawl regression. It applies only `migrations/0001_delta_qoralis_crawl.sql` and must keep passing with the new optional env fields absent.

Do not create a Worker, a Wrangler environment, a route module, or a config framework.

## Public contract

`src/crawl-gateway/worker.ts` exports the widened env, the seam type, and the same handler. The default export stays a two-argument `fetch`.

```ts
export type CrawlGatewayEnv = Readonly<{
  DB: D1CrawlDatabase;
  CRAWL_GATEWAY_TOKEN?: string;
  ANALYSIS_GATEWAY_TOKEN?: string;
  GEMINI_API_KEY?: string;
}>;

export type CrawlGatewayDependencies = Readonly<{
  runPipeline?: typeof runD1WebsiteAnalysisPipeline;
}>;

export async function handleCrawlGatewayRequest(
  request: Request,
  env: CrawlGatewayEnv,
  dependencies?: CrawlGatewayDependencies,
): Promise<Response>;
```

Imports added to `worker.ts`:

```ts
import type { GeminiWebsiteAnalysisConfig } from "../config/env";
import { runD1WebsiteAnalysisPipeline } from "../website-analysis/d1-analysis-pipeline";
```

Do not import `loadConfig`, the Gemini provider, or `D1WebsiteAnalysisPipelineError`. The HTTP catch is generic.

Private names inside `worker.ts`:

- `ANALYSIS_PATH` is `"/internal/analysis/run"`.
- `tokensMatch(configured: string, presented: string): boolean` copies the current UTF-8 length check and `timingSafeEqual` call.
- `isAuthorized` remains the crawl check and reads only `env.CRAWL_GATEWAY_TOKEN`.
- `isAnalysisAuthorized(request: Request, env: CrawlGatewayEnv): boolean` reads only `env.ANALYSIS_GATEWAY_TOKEN`.
- `geminiConfigFromEnv(env: CrawlGatewayEnv): GeminiWebsiteAnalysisConfig | undefined` applies the key rule above.
- `isMaxItems(value: unknown): value is number` applies the integer rule above.

`CrawlGatewayDependencies` may be introduced in Task 2. Task 1 keeps the current two-argument handler.

## Test command

Targeted analysis command, from the repository root:

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/crawl-gateway-analysis.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

Existing crawl unit command, used as regression after each task:

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/crawl-gateway-worker.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

Existing crawl integration command, used in Task 3:

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/integration/crawl-gateway-d1.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

`package.json` has no DQ-036 script. `npm test` is `node scripts/run-tests.cjs`. `npm run typecheck` is `tsc --noEmit`. Use those only in Task 3.

The new test file imports `handleCrawlGatewayRequest` and `CrawlGatewayEnv` from `../../src/crawl-gateway/worker`, and `D1CrawlDatabase` from `../../src/crawler/d1-crawl-store`. Use these sentinels. Assert that no response text contains `crawl-token-do-not-reflect`, `analysis-token-do-not-reflect`, or `gemini-key-do-not-reflect`.

```ts
const CRAWL_TOKEN = "crawl-token-do-not-reflect";
const ANALYSIS_TOKEN = "analysis-token-do-not-reflect";
const GEMINI_KEY = "gemini-key-do-not-reflect";
const ANALYSIS_URL = "https://gateway.example/internal/analysis/run";
const SELECT_URL = "https://gateway.example/internal/crawl/select";
```

Copy the fake `D1CrawlDatabase` shape from `tests/unit/crawl-gateway-worker.test.ts`: `prepare` returns a statement whose `bind` returns the statement, and `all`, `first`, and `run` use the supplied behavior. Count `prepare` calls. Copy `readResponse` from that file so every response asserts `content-type: application/json; charset=utf-8` and `cache-control: no-store`.

Build each env object at the call site. Do not give a helper a default analysis token or Gemini key.

### Task 1: Analysis route, separate auth, request validation, and Gemini config

**Files:**
- Create: `tests/unit/crawl-gateway-analysis.test.ts`
- Modify: `src/crawl-gateway/worker.ts`
- Test: `tests/unit/crawl-gateway-analysis.test.ts`
- Test: `tests/unit/crawl-gateway-worker.test.ts`

**Interfaces:**
- Consumes: current two-argument `handleCrawlGatewayRequest`, `CrawlGatewayEnv`, `isAuthorized`, `hasJsonContentType`, `hasAllowedContentLength`, `readJsonBody`, `hasExactlyKeys`, and the fixed response helpers.
- Produces: `ANALYSIS_GATEWAY_TOKEN` and `GEMINI_API_KEY` on `CrawlGatewayEnv`; analysis auth; `geminiConfigFromEnv`; a valid `maxItems` 0 request calls the real `runD1WebsiteAnalysisPipeline` and returns the zero summary. The handler is still two arguments at the end of this task.

- [ ] **Step 1: Write the failing tests**

Add the tests below to `tests/unit/crawl-gateway-analysis.test.ts`. Use `node:test` and `node:assert/strict`. A valid analysis request uses `POST`, `content-type: application/json`, `authorization: Bearer ${ANALYSIS_TOKEN}`, and `JSON.stringify({ maxItems })`.

Representative assertion:

```ts
assert.equal(response.status, 401);
assert.equal(response.text, '{"error":"unauthorized"}');
assert.equal(response.text.includes(ANALYSIS_TOKEN), false);
assert.equal(response.text.includes(GEMINI_KEY), false);
assert.equal(prepareCount(), 0);
```

Route and auth tests:

- `unknown analysis paths return 404`: `POST /internal/analysis` and `GET /internal/nope` both return `{"error":"not_found"}`. `prepareCount()` is 0.
- `a query string on the analysis path returns 404`: `POST ${ANALYSIS_URL}?x=1` returns 404 before method or auth can succeed.
- `a non-POST analysis request returns 405`: `GET ${ANALYSIS_URL}` with a valid analysis Bearer token returns `{"error":"method_not_allowed"}`.
- `a missing presented analysis token returns 401`: no `authorization` header.
- `a wrong analysis token returns 401`: `Bearer not-the-analysis-token`.
- `a lowercase bearer scheme returns 401`: `bearer ${ANALYSIS_TOKEN}`.
- `CRAWL_GATEWAY_TOKEN does not authorize the analysis route`: env has both tokens set to different sentinels, the header is `Bearer ${CRAWL_TOKEN}`, and the body is `{ maxItems: 0 }`. Status is 401 and `prepareCount()` is 0.
- `a missing or empty configured analysis token fails closed`: one case omits `ANALYSIS_GATEWAY_TOKEN`, one sets it to `""`, and one sets it to `1 as unknown as string` through the env object. Each presents `Bearer ${ANALYSIS_TOKEN}` and `{ maxItems: 0 }`. Each status is 401.
- `authentication and request validation precede Gemini configuration`: omit `GEMINI_API_KEY`. A missing authorization header returns 401. A present analysis token with `{ maxItems: -1 }` returns 400 `{"error":"invalid_request"}`. Neither case calls `prepare`.

Request tests. Each uses the valid analysis token and a valid `GEMINI_KEY` unless the case says otherwise. Invalid cases return 400 `{"error":"invalid_request"}` and `prepareCount()` 0:

- `valid maxItems 0 returns the zero summary`: real handler, no seam. `prepareCount()` is 0. Status is 200. Text is exactly `{"selected":0,"succeeded":0,"failed":0,"retried":0,"persisted":0}`.
- `application/json; charset=utf-8 is accepted`: the same zero summary.
- `maxItems below 0, above 50, fractional, string, missing, null, or extra is rejected`: bodies `{ maxItems: -1 }`, `{ maxItems: 51 }`, `{ maxItems: 1.5 }`, `{ maxItems: "1" }`, `{}`, `{ maxItems: null }`, and `{ maxItems: 1, extra: true }`.
- `a null or array body is rejected`: raw bodies `null` and `[]`.
- `malformed, oversized, and extra-field analysis bodies are rejected`: raw body `{`; `content-type: text/plain` with `{ maxItems: 0 }`; `content-type: application/json;charset=utf-8`; `content-length: 3145729` with `request.text` replaced so the test records whether it was called, expecting that it was not called; `content-length: 01`; `request.text` resolves to a string of length `3145729`. The extra-field body from the previous test stays in this named test as well, so Review Focus item 3 has one concrete test.

Gemini tests. Use `maxItems: 1` and a fake database whose `all` would reject. `prepareCount()` must stay 0, which proves the real pipeline was not entered:

- `an invalid Gemini key returns a fixed 500 and does not echo the key`: cases are omit `GEMINI_API_KEY`, `""`, `" "`, `"\n"`, `"\u0001"`, `"\u007f"`, and `" gemini-key-do-not-reflect"`. Status is 500. Text is exactly `{"error":"internal_error"}`. The text does not include `gemini-key-do-not-reflect`.

Do not add a `NaN` JSON literal. Do not call Gemini.

- [ ] **Step 2: Run the analysis command to verify it fails**

Run the targeted analysis command.

Expected: FAIL. `POST /internal/analysis/run` is not a known path, so the current handler returns 404 `{"error":"not_found"}` where these tests expect 401, 400, 405, 500, or 200. The crawl unit command is not expected to fail.

- [ ] **Step 3: Write the minimal implementation**

In `src/crawl-gateway/worker.ts`:

- Add the two optional env fields and the two imports in the public contract.
- Add `tokensMatch`. Change `isAuthorized` so it still reads only `CRAWL_GATEWAY_TOKEN` and then uses `tokensMatch`. Add `isAnalysisAuthorized` for `ANALYSIS_GATEWAY_TOKEN` only.
- Treat `ANALYSIS_PATH` as a third known path. A non-empty `url.search` on any path remains 404 before the method check.
- After the POST check, call `isAnalysisAuthorized` for the analysis path and `isAuthorized` otherwise.
- After `readJsonBody`, the analysis path validates `isRecord`, `hasExactlyKeys(parsed, ["maxItems"])`, and `isMaxItems`. Failure returns `invalidRequest()`.
- Then call `geminiConfigFromEnv`. An `undefined` result returns `internalError()` and does not call the pipeline.
- Otherwise `try { const result = await runD1WebsiteAnalysisPipeline(env.DB, geminiConfig, parsed.maxItems); return jsonResponse(200, { selected: result.selected, succeeded: result.succeeded, failed: result.failed, retried: result.retried, persisted: result.persisted }); } catch { return internalError(); }`.
- Do not pass a fourth argument. Do not short-circuit `maxItems === 0`. Do not log. Leave crawl `handleSelect` and `handleEvidence` on their current paths.

- [ ] **Step 4: Run tests to verify they pass**

Run the targeted analysis command. Expected: PASS.

Run the existing crawl unit command. Expected: PASS. Crawl routes still require `CRAWL_GATEWAY_TOKEN`, and their existing 401, 404, 405, and 400 bodies stay exact.

- [ ] **Step 5: Commit boundary**

```bash
git add src/crawl-gateway/worker.ts tests/unit/crawl-gateway-analysis.test.ts
git commit -m "feat: add authenticated analysis route boundary"
```

Builder execution does not run this commit. Leave the task uncommitted until the Analyst records APPROVED.

### Task 2: DQ-035 invocation, forwarded arguments, and safe result mapping

**Files:**
- Modify: `tests/unit/crawl-gateway-analysis.test.ts`
- Modify: `src/crawl-gateway/worker.ts`
- Test: `tests/unit/crawl-gateway-analysis.test.ts`
- Test: `tests/unit/crawl-gateway-worker.test.ts`

**Interfaces:**
- Consumes: Task 1's two-argument handler, `geminiConfigFromEnv`, and the real `runD1WebsiteAnalysisPipeline`.
- Produces: optional third argument `dependencies?: CrawlGatewayDependencies`. The call becomes `const runPipeline = dependencies?.runPipeline ?? runD1WebsiteAnalysisPipeline` and then `await runPipeline(env.DB, geminiConfig, maxItems)`. The default `fetch` stays two arguments.

- [ ] **Step 1: Write the failing tests**

Append these tests. Each valid case uses the analysis token, `GEMINI_KEY`, and a JSON object body.

```ts
const calls: Array<{
  database: unknown;
  config: { readonly provider: "gemini"; readonly apiKey: string };
  maxItems: number;
  options: unknown;
}> = [];

const summary = {
  selected: 4,
  succeeded: 3,
  failed: 1,
  retried: 2,
  persisted: 3,
  html: "<p>html-sentinel</p>",
  apiKey: GEMINI_KEY,
};

const runPipeline: typeof runD1WebsiteAnalysisPipeline = (
  database,
  config,
  maxItems,
  options,
) => {
  calls.push({ database, config, maxItems, options });
  return Promise.resolve(summary);
};
```

Import `typeof runD1WebsiteAnalysisPipeline` by importing the function from `../../src/website-analysis/d1-analysis-pipeline`. Assign `summary` to a variable before returning it so the extra `html` and `apiKey` fields are part of the runtime object without an excess-property error. Pass `{ runPipeline }` as the third argument.

- `the pipeline is called once with the forwarded DB, Gemini config, and maxItems`: separate requests for `maxItems` 0, 1, and 50. Each `calls` entry uses the same `database` reference as `env.DB`, `config` deep-equals `{ provider: "gemini", apiKey: GEMINI_KEY }`, `Object.isFrozen(config)` is true, `maxItems` equals the request value, and `options` is `undefined`. `calls.length` is 1 for that request. `prepareCount()` is 0 because the stub must not be bypassed by the real pipeline.
- `the pipeline result becomes the exact five-field summary`: status 200 and text exactly `{"selected":4,"succeeded":3,"failed":1,"retried":2,"persisted":3}`. The text does not include `html-sentinel` or `gemini-key-do-not-reflect`. `Object.keys(body)` deep-equals `["selected", "succeeded", "failed", "retried", "persisted"]`.
- `a thrown pipeline error becomes a fixed 500 without the thrown text`: the stub throws `new Error("boom gemini-key-do-not-reflect")`. Status is 500. Text is exactly `{"error":"internal_error"}`. Import `D1WebsiteAnalysisPipelineError` from `../../src/website-analysis/pipeline-errors` and repeat with `new D1WebsiteAnalysisPipelineError("INVALID_REQUEST")` and `new D1WebsiteAnalysisPipelineError("SELECTION_FAILED")`. Both stay 500, not 400. The text does not include `boom`, `gemini-key-do-not-reflect`, `D1 website analysis pipeline request is invalid.`, or `D1 website analysis selection failed.`.
- `an invalid Gemini key does not call the pipeline when maxItems is 0`: `GEMINI_API_KEY` is `" gemini-key-do-not-reflect"`, body is `{ maxItems: 0 }`, and the stub throws if called. Status is 500, `calls.length` is 0, and the text is the fixed internal error.
- `an invalid analysis request does not call the pipeline`: body `{ maxItems: 51 }` with a valid key. Status is 400 and `calls.length` is 0.

Replace `console.error` for the thrown-pipeline test and assert it was not called. Restore it afterward. The handler must not log the thrown value.

- [ ] **Step 2: Run the analysis command to verify it fails**

Run the targeted analysis command.

Expected: FAIL while compiling, with `TS2554` because `handleCrawlGatewayRequest` accepts two arguments. Do not weaken the tests by removing the third argument.

- [ ] **Step 3: Write the minimal implementation**

Add `CrawlGatewayDependencies` and the optional third parameter. Replace the direct pipeline call with:

```ts
const runPipeline = dependencies?.runPipeline ?? runD1WebsiteAnalysisPipeline;
const result = await runPipeline(env.DB, geminiConfig, maxItems);
```

Keep the Task 1 `try/catch`, the five-field object, and the rule that Gemini validation happens before `runPipeline` is selected or called. Do not call the stub on 401, 400, or invalid Gemini config. Do not change `fetch`.

- [ ] **Step 4: Run tests to verify they pass**

Run the targeted analysis command. Expected: PASS, including every Task 1 test.

Run the existing crawl unit command. Expected: PASS.

- [ ] **Step 5: Commit boundary**

```bash
git add src/crawl-gateway/worker.ts tests/unit/crawl-gateway-analysis.test.ts
git commit -m "feat: invoke DQ-035 from the analysis route"
```

Builder execution does not run this commit. Leave the task uncommitted until the Analyst records APPROVED.

### Task 3: Crawl regression and final verification

**Files:**
- Modify: `tests/unit/crawl-gateway-analysis.test.ts`
- Test: `tests/unit/crawl-gateway-worker.test.ts`
- Test: `tests/integration/crawl-gateway-d1.test.ts`
- Modify: `src/crawl-gateway/worker.ts` only when a regression test fails

**Interfaces:**
- Consumes: Task 2's three-argument handler and the unchanged default export.
- Produces: no new production function. `fetch(request, env)` remains the production entry and does not receive `CrawlGatewayDependencies`.

- [ ] **Step 1: Write the failing regression tests**

Append:

- `ANALYSIS_GATEWAY_TOKEN does not authorize a crawl route`: env contains `CRAWL_GATEWAY_TOKEN`, a different `ANALYSIS_GATEWAY_TOKEN`, and `GEMINI_KEY`. `POST ${SELECT_URL}` with `Bearer ${ANALYSIS_TOKEN}`, `content-type: application/json`, and body `{ maxAttempts: 1 }`. Status is 401, text is `{"error":"unauthorized"}`, and `prepareCount()` is 0. The text contains neither sentinel.
- `crawl select still succeeds with its own token while analysis secrets are present`: same env, header `Bearer ${CRAWL_TOKEN}`, and fake `all` returning `{ results: [] }`. Status is 200 and the body deep-equals `{ candidates: [] }`. The text contains neither the analysis token nor the Gemini key.
- `worker fetch runs maxItems 0 without a pipeline override`: import the default export and call `worker.fetch(request, env)` with two arguments. Body `{ maxItems: 0 }`, valid analysis token, valid Gemini key. Status is 200 and the text is the zero summary. `worker.fetch.length` is 2.
- `wrangler.toml does not gain analysis secrets`: read `wrangler.toml`. It includes `name = "delta-qoralis-crawl-gateway"` and `binding = "DB"`. It does not include `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, or `CRAWL_GATEWAY_TOKEN`.
- `the worker does not call loadConfig`: read `src/crawl-gateway/worker.ts`. The source does not include `loadConfig`. It includes `ANALYSIS_GATEWAY_TOKEN` and `runD1WebsiteAnalysisPipeline`.

Duplicate the empty-result select setup from `tests/unit/crawl-gateway-worker.test.ts`. Do not import unexported helpers. Do not modify that file or the integration file.

- [ ] **Step 2: Run the analysis command to verify the regression signal**

Run the targeted analysis command.

Expected RED when the token split is wrong: `ANALYSIS_GATEWAY_TOKEN does not authorize a crawl route` is not 401, or `prepareCount()` is not 0. Expected RED when production entry drifted: `worker fetch runs maxItems 0 without a pipeline override` is not the zero summary. On a correct Task 1 and Task 2 result, these new tests pass on first run. Do not change production code merely to make an already passing regression test fail.

- [ ] **Step 3: Repair only a failed regression**

If the analysis token authorizes crawl, restore the crawl branch to `isAuthorized` and `CRAWL_GATEWAY_TOKEN` only. If `fetch` no longer delegates with two arguments, make it call `handleCrawlGatewayRequest(request, env)` again. Do not add a shared authorizer that accepts either secret. Do not edit `wrangler.toml`.

- [ ] **Step 4: Run final verification**

Run the targeted analysis command. Expected: PASS.

Run the existing crawl unit command. Expected: PASS.

Run the existing crawl integration command. Expected: PASS.

Run:

```bash
npm test
```

Expected: PASS. This is `node scripts/run-tests.cjs`, which compiles to `.test-build` and runs every compiled test. It removes `.test-build` afterward.

```bash
npm run typecheck
```

Expected: PASS. This is `tsc --noEmit`.

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 5: Commit boundary**

```bash
git add tests/unit/crawl-gateway-analysis.test.ts src/crawl-gateway/worker.ts
git commit -m "test: lock analysis and crawl route separation"
```

If `worker.ts` has no Task 3 change, stage only the test file. Builder execution does not run this commit. Leave the task uncommitted until the Analyst records APPROVED.

## Deferred production activation

This is not a Builder task. After review, merge, and a later human decision, activation is:

1. Configure `ANALYSIS_GATEWAY_TOKEN` and `GEMINI_API_KEY` as secrets on the existing Worker `delta-qoralis-crawl-gateway`. Use a different value from `CRAWL_GATEWAY_TOKEN`. Do not write either secret into `wrangler.toml` or git.
2. Deploy that same Worker. Do not create or rename a Worker.
3. Manually `POST /internal/analysis/run` with `{ "maxItems": 0 }` and `Authorization: Bearer` the analysis token. Expect HTTP 200 and `{"selected":0,"succeeded":0,"failed":0,"retried":0,"persisted":0}`.

A later production call with `maxItems` greater than 0 is allowed only when suitable fetched evidence exists and a human explicitly wants end-to-end Gemini verification. Paid analysis is not required to finish implementation. The Builder does not configure secrets, deploy, or perform either call.

## Explicit exclusions

DQ-036 implementation does not add a scheduler, cron trigger, GitHub Actions analysis workflow, automatic analysis, 50/day accounting, a budget or usage ledger, failure history, analysis-attempt history, cross-run retry accounting, a lock, lease, claim, queue, or background worker. It does not add Gemini retry behavior, models, or a provider abstraction. It does not add Groq, Cloudflare Workers AI, OpenRouter, qualification, lead scoring, contact discovery, DNC changes, outreach, mailing, email sending, or SQLite website-analysis persistence. It does not define DQ-037, DQ-038, DQ-039, or DQ-040.
