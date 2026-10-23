# DQ-036 Manual Authenticated Website Analysis Runtime

## Status

```text
design, human-approved, not implemented
```

## Context

Delta Qoralis is the company. Analyzing and Mailing Agent is the agent. This design does not rename the agent to the company, and it does not rename the deployed Worker.

The Worker infrastructure name `delta-qoralis-crawl-gateway` stays. Its entry is `src/crawl-gateway/worker.ts`, configured by `wrangler.toml` with `main = "src/crawl-gateway/worker.ts"`, `compatibility_date = "2026-10-22"`, `compatibility_flags = ["nodejs_compat"]`, and one D1 binding `DB` for database `delta-qoralis-crawl`. `wrangler.toml` contains no secrets.

`handleCrawlGatewayRequest(request, env)` is the exported handler. The default `fetch` calls it. Existing routes are `POST /internal/crawl/select` and `POST /internal/crawl/evidence`. Both require `Authorization: Bearer` matching `CRAWL_GATEWAY_TOKEN`. Comparison uses `timingSafeEqual` after a length check. A missing or empty configured token fails closed. JSON responses use `content-type: application/json; charset=utf-8` and `cache-control: no-store`. The fixed bodies are `{ "error": "not_found" }`, `{ "error": "method_not_allowed" }`, `{ "error": "unauthorized" }`, `{ "error": "invalid_request" }`, and `{ "error": "internal_error" }`. An unknown path, including any query string, is 404 before the method check. A known path with a non-POST method is 405. Accepted content types are exactly `application/json` and `application/json; charset=utf-8`. Bodies are capped at `MAX_BODY_BYTES` (`3145728`), both by `content-length` and by the read text. Crawl selection accepts exactly `{ maxAttempts }` for integers 1 through 60.

`CrawlGatewayEnv` is `DB` plus optional `CRAWL_GATEWAY_TOKEN`. `DB` is the structural `D1CrawlDatabase` from `src/crawler/d1-crawl-store.ts`. The module does not import a Cloudflare SDK type.

DQ-035 `runD1WebsiteAnalysisPipeline(database, config, maxItems, options?)` already selects fetched evidence, reconstructs it, extracts facts, calls DQ-033 once, persists successes, and returns a frozen `{ selected, succeeded, failed, retried, persisted }`. `maxItems === 0` returns that zero summary before D1 selection and before Gemini. `GeminiWebsiteAnalysisConfig` is `{ provider: "gemini", apiKey: string }` from `src/config/env.ts`. `parseWebsiteAnalysisConfig` rejects a missing `GEMINI_API_KEY`, an empty key, and a key containing whitespace or a control character under `/[\s\u0000-\u001f\u007f-\u009f]/u`. That parser is private and is reached only through `loadConfig()`, which also parses application, logging, SQLite, and discovery settings.

Current project docs leave DQ-036 through DQ-039 planned and unarchitected. This design covers DQ-036 only.

## Goal

DQ-036 is the smallest safe production-facing manual runtime that invokes the existing DQ-035 pipeline.

```text
manual authenticated HTTP POST
→ existing Cloudflare Worker delta-qoralis-crawl-gateway
→ analysis-route authentication
→ strict request validation
→ focused Gemini runtime configuration validation
→ runD1WebsiteAnalysisPipeline
→ safe JSON summary
```

The slice is orchestration and runtime exposure. It does not duplicate DQ-035 internals.

## Approved approach

Extend the existing deployed Worker. Do not create a second Worker.

The new route is `POST /internal/analysis/run`. It authenticates with its own secret, `ANALYSIS_GATEWAY_TOKEN`. It accepts a JSON object whose only key is `maxItems`, an integer from 0 through 50 inclusive. It validates `GEMINI_API_KEY` into `{ provider: "gemini", apiKey }` and calls:

```text
runD1WebsiteAnalysisPipeline(env.DB, geminiConfig, maxItems)
```

Success returns HTTP 200 and only the DQ-035 summary. Failures return the existing fixed error bodies.

Production activation is specified here and is not performed by this design.

## Alternatives considered

1. Extend the existing Worker `delta-qoralis-crawl-gateway`. Selected. The Worker, D1 binding, request-safety helpers, and constant-time Bearer check already exist. One manual route reuses them. That matches the project rule that the system should stay simple and run as it is supposed to run.

2. A separate analysis Worker. Rejected for this stage. It would add another deployable, another binding setup, and another operational surface before a manual route has been proven.

3. GitHub Actions plus an analysis gateway. Deferred. DQ-036 is a manual runtime only. Scheduled execution is a later slice.

4. Daily-budget accounting first. Deferred. A budget ledger is a later slice. This route does not count usage, tokens, cost, or days.

## Architecture

Keep the direct Worker-handler style. `handleCrawlGatewayRequest` remains the single exported request function. The default `fetch` still calls it with `request` and `env` only.

Add the analysis path beside the two crawl paths. Reuse `jsonResponse`, `notFound`, `methodNotAllowed`, `unauthorized`, `invalidRequest`, `internalError`, `isRecord`, `hasExactlyKeys`, `hasJsonContentType`, `hasAllowedContentLength`, and `readJsonBody`.

A narrowly scoped plain helper is allowed if it keeps `worker.ts` readable. The helper, if created, lives under `src/crawl-gateway/` and is an ordinary function. Do not add a router framework, generic HTTP framework, service container, generic authentication service, repository abstraction, factory framework, dependency-injection framework, or middleware stack.

The production call does not pass DQ-035 options. `storedAt`, model fallback, the 90-second retry, and persistence stay inside DQ-035.

Tests that must observe the pipeline without calling Gemini may pass one optional dependency into `handleCrawlGatewayRequest`. The production `fetch` does not pass it.

```ts
type CrawlGatewayDependencies = Readonly<{
  runPipeline?: typeof runD1WebsiteAnalysisPipeline;
}>;
```

The default `runPipeline` is `runD1WebsiteAnalysisPipeline`. This is a test seam, not a service container. It exists because the current handler has no way to show that `env.DB`, the Gemini config, and `maxItems` were forwarded, or to turn a thrown pipeline error into the fixed 500 body, without invoking real Gemini.

## Existing Worker compatibility

These crawl behaviors stay unchanged:

- `POST /internal/crawl/select`
- `POST /internal/crawl/evidence`
- `CRAWL_GATEWAY_TOKEN` Bearer authentication, including fail-closed when that token is missing or empty
- select body `{ maxAttempts }` for integers 1 through 60
- evidence persistence request and `{ persisted: true }` response
- crawl error bodies and status codes
- D1 binding name `DB`
- Worker name `delta-qoralis-crawl-gateway`
- `wrangler.toml` name, main, compatibility date, compatibility flags, and D1 binding

`ANALYSIS_GATEWAY_TOKEN` does not authorize crawl routes. `CRAWL_GATEWAY_TOKEN` does not authorize the analysis route. Tests for the existing crawl routes keep passing when the new optional env fields are absent.

Do not edit `wrangler.toml` to store a token or API key. This design does not require a Wrangler config change.

## HTTP contract

`POST /internal/analysis/run`

- `Authorization: Bearer <ANALYSIS_GATEWAY_TOKEN>`
- `Content-Type: application/json` or `Content-Type: application/json; charset=utf-8`
- Body: a JSON object with exactly one own key, `maxItems`

`maxItems` must be a JSON number that is an integer and satisfies `0 <= maxItems <= 50`. `0`, `1`, and `50` are valid. Negative, greater than 50, and fractional numbers are invalid.

These requests are HTTP 400 `{ "error": "invalid_request" }`:

- negative, greater than 50, or fractional `maxItems`
- a string, `null`, array, or other non-number `maxItems`
- a missing `maxItems`
- any extra own key
- malformed JSON
- a content type other than the two accepted JSON types
- a present `content-length` that does not match `^(?:0|[1-9][0-9]*)$`, or a length above `3145728`
- a body whose JavaScript string length or UTF-8 byte length is above `3145728`

A missing `content-length` stays valid. That is the current `hasAllowedContentLength` rule: absence is allowed, and a present value must be a decimal integer without leading zeros and at most `3145728`.

`NaN` is not a JSON number. `JSON.parse` does not produce `NaN` from a JSON text, so the route does not add a special NaN token. A non-number JSON value is already invalid.

A path that is not one of the three known paths, or any known path with a non-empty query string, stays HTTP 404 `{ "error": "not_found" }`. `GET` or any other non-POST method on `/internal/analysis/run` is HTTP 405 `{ "error": "method_not_allowed" }`.

Check order for the analysis route:

1. Unknown path or non-empty query string returns 404.
2. Non-POST on the analysis path returns 405.
3. Analysis authentication runs. Failure returns 401.
4. Content type, content length, JSON parsing, and the exact `maxItems` object run. Failure returns 400.
5. Gemini runtime configuration is validated. Failure returns 500.
6. The pipeline is invoked once.

Authentication and request validation happen before Gemini configuration. A missing analysis token is 401 even when `GEMINI_API_KEY` is missing. An invalid `maxItems` is 400 even when `GEMINI_API_KEY` is missing.

## Authentication

`ANALYSIS_GATEWAY_TOKEN` is a distinct secret. Do not reuse `CRAWL_GATEWAY_TOKEN`. Crawl automation must not gain authority to trigger paid Gemini analysis.

Analysis authentication follows the current gateway quality:

- Read `env.ANALYSIS_GATEWAY_TOKEN`.
- If it is not a string, or its length is 0, fail closed with 401.
- Require an `authorization` header that starts with `Bearer `.
- Compare the configured token and the presented token with `timingSafeEqual` only when their UTF-8 byte lengths are equal.
- Unequal lengths, a missing header, a non-Bearer header, or a mismatched token return 401.
- Do not put the presented token or the configured token in the response.

Crawl routes continue to call the existing crawl check against `CRAWL_GATEWAY_TOKEN` only. Do not replace that check with a shared authenticator service.

## Worker environment

The structural Worker environment after DQ-036 is:

```ts
type CrawlGatewayEnv = Readonly<{
  DB: D1CrawlDatabase;
  CRAWL_GATEWAY_TOKEN?: string;
  ANALYSIS_GATEWAY_TOKEN?: string;
  GEMINI_API_KEY?: string;
}>;
```

`DB` remains the existing D1 binding. Do not import a Cloudflare SDK type. The same `env.DB` value is passed to the existing crawl functions and to `runD1WebsiteAnalysisPipeline`. `D1CrawlDatabase` and `D1WebsiteAnalysisPipelineDatabase` are the same structural `prepare` shape. If TypeScript cannot pass one directly to the other, use one local structural binding type that both existing functions accept. Do not add a repository or a second database.

`CRAWL_GATEWAY_TOKEN`, `ANALYSIS_GATEWAY_TOKEN`, and `GEMINI_API_KEY` are runtime secrets. They are optional on the type because a missing secret must fail closed at the route that needs it. They are not written into `wrangler.toml`.

## Gemini configuration

Do not call `loadConfig()`. It parses unrelated application and SQLite settings that do not belong in this Worker.

Validate `env.GEMINI_API_KEY` with the same rule `parseWebsiteAnalysisConfig` already uses:

- `undefined` is missing
- length 0 is invalid
- a match of `/[\s\u0000-\u001f\u007f-\u009f]/u` is invalid

A valid key becomes exactly:

```ts
{ provider: "gemini", apiKey }
```

That value is `GeminiWebsiteAnalysisConfig`. Freeze it if that stays consistent with the existing config object. Do not trim the key, do not log it, and do not copy it into the HTTP response. Do not throw `WebsiteAnalysisConfigurationError` across the HTTP boundary. Invalid or missing configuration becomes the fixed 500 body.

No generic configuration framework. Do not redesign the Gemini adapter, its model list, or its prompt.

Validate this configuration only after the analysis request is authenticated and structurally valid, and before calling the pipeline.

## Pipeline integration

For a valid authenticated request with a valid Gemini config, call the real pipeline once:

```text
runD1WebsiteAnalysisPipeline(env.DB, geminiConfig, maxItems)
```

Do not pass `analysisRunOptions` or `storedAt` from the HTTP request. Production therefore uses DQ-035's default clock and the real `runWebsiteAnalysis`.

Do not reproduce selection SQL, `evidenceFromRow`, `extractWebsiteFacts`, Gemini transport, model fallback, the 90-second retry, analysis validation, `persistD1WebsiteAnalysis`, `storedAt` generation, or summary arithmetic.

`maxItems` 0 is valid. The route still validates Gemini configuration, then calls the pipeline with `0`. DQ-035 returns the frozen zero summary without selecting evidence and without calling Gemini. That is the preferred low-risk production smoke test: it proves the route, the analysis token, request validation, Gemini config presence, the D1 binding as an argument, and that DQ-035 can be invoked.

## Response and error semantics

Success is HTTP 200. The JSON object has only:

```text
selected
succeeded
failed
retried
persisted
```

Those numbers are the DQ-035 result. Do not add candidates, findings, HTML, evidence ids, or a message field. This is an operational trigger, not an audit-detail API.

Fixed failures, with no raw underlying error:

| Condition | Status | Body |
| --- | --- | --- |
| Unrecognized path | 404 | `{ "error": "not_found" }` |
| Known path, wrong method | 405 | `{ "error": "method_not_allowed" }` |
| Wrong or missing analysis token | 401 | `{ "error": "unauthorized" }` |
| Malformed or invalid request | 400 | `{ "error": "invalid_request" }` |
| Missing or invalid Gemini runtime configuration | 500 | `{ "error": "internal_error" }` |
| Pipeline or other runtime failure | 500 | `{ "error": "internal_error" }` |

Existing crawl responses stay unchanged.

Do not expose the Gemini API key, either gateway token, the prompt, website HTML, visible text, analysis findings, the raw provider response, SQL, D1 implementation detail, stack traces, or `error.message`. A `D1WebsiteAnalysisPipelineError` is still the fixed 500 body. The route does not translate that error's code into 400, because request validation already happened.

## Testing strategy

Add focused tests around `handleCrawlGatewayRequest`. A new integration file may sit beside `tests/integration/crawl-gateway-d1.test.ts` and reuse its Miniflare shape: `modules: true`, `d1Persist: false`, no outbound service. Do not call real Gemini. Do not use production D1.

Use the `runPipeline` seam when a test must count calls, inspect forwarded arguments, replace the summary, or throw. The production `fetch` path is not given that seam. `maxItems` 0 may also call the real `runD1WebsiteAnalysisPipeline`, because that path returns before Gemini.

The tests must cover:

- `POST /internal/analysis/run` is accepted with a valid analysis token, valid Gemini key, and valid `maxItems`
- an unknown path returns 404
- `GET` or another non-POST on the analysis path returns 405
- `POST /internal/crawl/select` and `POST /internal/crawl/evidence` still succeed with `CRAWL_GATEWAY_TOKEN` and keep their current response shape
- a valid `ANALYSIS_GATEWAY_TOKEN` is accepted on the analysis route
- a missing presented analysis token returns 401
- a wrong presented analysis token returns 401
- `CRAWL_GATEWAY_TOKEN` does not authorize the analysis route
- `ANALYSIS_GATEWAY_TOKEN` does not authorize a crawl route
- a missing or empty configured `ANALYSIS_GATEWAY_TOKEN` fails closed with 401
- `maxItems` 0, 1, and 50 are valid
- negative, 51, fractional, string, missing, extra field, `null`, malformed JSON, and a wrong content type are 400
- a missing `GEMINI_API_KEY` on an otherwise valid analysis request is the safe 500
- an empty or whitespace-or-control `GEMINI_API_KEY` is the safe 500
- a valid key is the `GeminiWebsiteAnalysisConfig` forwarded to the pipeline
- the analysis token and Gemini API key are absent from every response body
- `env.DB`, the Gemini config, and `maxItems` are forwarded
- the pipeline is called exactly once for one valid request
- the pipeline result is returned as the exact five-field summary
- a thrown pipeline error becomes the safe 500 and the thrown message is absent
- `maxItems` 0 invokes the pipeline with `0` and returns the success summary

Crawl regression tests continue to use `CRAWL_GATEWAY_TOKEN` and do not require `GEMINI_API_KEY`.

## Production activation plan

This design does not deploy and does not set secrets.

After review and merge, a later human activation does three things:

1. Configure `ANALYSIS_GATEWAY_TOKEN` and `GEMINI_API_KEY` as secrets on the existing Worker `delta-qoralis-crawl-gateway`. Do not place them in `wrangler.toml` or in git.
2. Deploy that same Worker. Do not create or rename a Worker.
3. Manually verify `POST /internal/analysis/run` with `{ "maxItems": 0 }` and the analysis Bearer token. Expect HTTP 200 and the zero summary.

A later production call with `maxItems` greater than 0 may run only when suitable fetched evidence exists and a human explicitly wants end-to-end Gemini verification. Paid analysis is not an automatic requirement of the zero-work smoke test. `CRAWL_GATEWAY_TOKEN` remains the crawl secret and is not rotated by this slice.

## Security considerations

The analysis token and the crawl token are separate authorities. Equal values in production would collapse that separation, so activation uses two different secrets.

Comparison stays constant-time for equal-length inputs and does not compare unequal lengths with `timingSafeEqual`. Missing configuration fails closed.

Request bodies stay bounded by the existing `3145728` cap. Responses stay on the fixed JSON helpers and do not echo request data, secrets, HTML, or provider output.

The route can spend Gemini quota when `maxItems` is greater than 0 and eligible evidence exists. DQ-036 does not add a budget. The manual token and the zero-item smoke test are the controls for this slice.

## Failure behavior

Invalid callers learn only the fixed status and error code. They do not learn whether Gemini, D1, or the pipeline failed, except that 400 is reserved for a bad request and 401 is reserved for analysis authentication.

Gemini configuration failure and pipeline failure both use 500 `{ "error": "internal_error" }`. The Worker does not retry the pipeline. DQ-035 still owns its own per-website Gemini retry when a positive `maxItems` run reaches analysis.

`maxItems` 0 with a valid token and valid key does not select evidence and does not call Gemini. `maxItems` 0 with an invalid key returns 500 and does not call the pipeline.

Crawl failures stay on the crawl routes. An analysis failure does not change crawl authentication or crawl persistence.

## Explicit exclusions

DQ-036 does not add:

- a new Worker or a Worker rename
- a scheduler, cron, or GitHub Actions analysis workflow
- automatic analysis execution
- 50/day accounting, a daily Gemini budget, or a usage, token, cost, or latency ledger
- a failure-history table, analysis-attempt history, or cross-run retry tracking
- locks, leases, claims, reservation, a queue, or a background worker
- new Gemini retry logic, a new model chain, or a new provider abstraction
- Groq, Cloudflare Workers AI, or OpenRouter
- qualification, lead scoring, contact discovery, DNC execution changes, outreach, mailing, or email sending
- SQLite website-analysis persistence
- any architecture for DQ-037, DQ-038, DQ-039, or DQ-040

## Names aligned to source

- The handler is `handleCrawlGatewayRequest` in `src/crawl-gateway/worker.ts`. The default export's `fetch` calls it.
- Crawl paths are `/internal/crawl/select` and `/internal/crawl/evidence`.
- Authorization parsing is the existing `Bearer ` prefix plus `timingSafeEqual` from `node:crypto`.
- Request safety is `hasJsonContentType`, `hasAllowedContentLength`, `readJsonBody`, and `MAX_BODY_BYTES` of `3145728`.
- Exact object keys use `hasExactlyKeys`.
- Error helpers are `notFound`, `methodNotAllowed`, `unauthorized`, `invalidRequest`, and `internalError`.
- The pipeline is `runD1WebsiteAnalysisPipeline` and the result type is `D1WebsiteAnalysisPipelineResult`.
- Gemini config is `GeminiWebsiteAnalysisConfig`. The key rule matches private `parseWebsiteAnalysisConfig` in `src/config/env.ts`. The route does not call `loadConfig`.
- The D1 binding remains `DB`. The Worker name remains `delta-qoralis-crawl-gateway`.
