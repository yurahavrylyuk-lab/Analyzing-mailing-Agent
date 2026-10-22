# DQ-025 GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an autonomous free-tier crawl runner in which GitHub Actions executes the existing Node pinned-HTTPS crawler while an authenticated Cloudflare Worker provides only D1 candidate-selection and evidence-persistence operations.

**Architecture:** GitHub Actions runs the runtime-neutral DQ-024 crawl loop. Selection and persistence cross a narrow authenticated Worker gateway backed by D1; collection remains the existing DQ-006/DQ-020 Node transport. Cloudflare deployment stays manually controlled and no website crawl occurs inside the Worker.

**Tech Stack:** TypeScript, Node.js, GitHub Actions, Cloudflare Workers Free, Cloudflare D1, Wrangler, Miniflare.

**Spec:** `docs/superpowers/specs/2026-10-22-dq-025-github-actions-crawl-runner-design.md`

## Global Constraints

- Start from `main` at `91a645e130bcd2565be7a23389a69dc85e4cb517`. Create `feature/dq-025-github-actions-crawl-runner`. Do not commit on `main`.
- Implement the approved spec. Do not redesign it.
- Flow: GitHub Actions → `npm run crawl:cloud` → `runBoundedSinglePageCrawlWithDependencies`. `select` calls `POST /internal/crawl/select` → `selectD1CrawlCandidates`. `collect` stays `collectSinglePageCrawlEvidence` → `fetchCrawlPage` → DQ-006 → Node pinned HTTP/HTTPS. `persist` calls `POST /internal/crawl/evidence` → `persistD1CrawlEvidence`. The Worker does not crawl websites.
- `select` stays `(maxAttempts: number) => Promise<readonly BusinessLead[]>`. The Worker returns the complete `BusinessLead` snapshots from `selectD1CrawlCandidates()`. The runner validates them as existing `BusinessLead` values.
- Do not add `CrawlCandidate`, a `{ id, version, websiteUrl }` DTO, a synthetic `BusinessLead`, a run-loop type parameter, a collector signature change, or a DQ-024 contract change.
- Worker routes are only `POST /internal/crawl/select` and `POST /internal/crawl/evidence`. Header is `Authorization: Bearer <token>` with one space. Authenticate before reading a protected body and before D1. Secret name is `CRAWL_GATEWAY_TOKEN`. Compare with `timingSafeEqual` from `node:crypto` on equal-length UTF-8 bytes. A different length fails. A missing or empty Worker secret fails closed with 401.
- Worker env type is only `DB: D1CrawlDatabase` and `CRAWL_GATEWAY_TOKEN?: string`. Use `nodejs_compat` because `normalizeSinglePageCrawlEvidence` uses `Buffer.from`. Do not edit `utf8ByteLength`.
- Responses, with no `message` field: 401 `{"error":"unauthorized"}`, 404 `{"error":"not_found"}`, 405 `{"error":"method_not_allowed"}`, 400 `{"error":"invalid_request"}`, 500 `{"error":"internal_error"}`, 200 success. Never reflect the bearer token, SQL, D1 errors, native causes, stack traces, HTML, DNS details, request URLs, or authorization headers. Evidence success is exactly `{"persisted":true}`.
- `maxAttempts` is a safe integer from 1 through 60. The cloud default is 10. Request body cap is 3 MiB (`3_145_728` bytes). Content type is `application/json` or `application/json; charset=utf-8`.
- `LEAD_NOT_FOUND` and `INVALID_EVIDENCE` are 400. `SELECTION_FAILED`, `LeadPersistenceError`, `PERSISTENCE_FAILED`, and every other throw are 500.
- One gateway `fetch` per operation. No retry. Non-2xx, bad JSON, and unexpected JSON throw `Crawl gateway request failed.` and do not copy the response body.
- Runner output is counts and the stop enum only. Exit 0 on `completed`, 130 on `cancelled`, 1 on configuration or run failure. Configuration stderr is `Crawl gateway configuration is invalid.` Run-failure stderr is `Crawl run failed.` Cancellation stderr is `Crawl run was cancelled.`
- Schedule is cron `17 6 * * *` with `timezone: "Europe/Warsaw"` (06:17 Europe/Warsaw daily). The IANA timezone handles DST. Do not encode winter or summer UTC offsets. `permissions: contents: read`. Concurrency group `crawl` with `cancel-in-progress: false`.
- GitHub receives `CRAWL_GATEWAY_URL` and `CRAWL_GATEWAY_TOKEN` as repository secrets, plus literal `CRAWL_MAX_ATTEMPTS: "10"`. No Cloudflare API token, Wrangler deploy, Docker, Container, or Worker Cron in the crawl workflow. Do not change `.github/workflows/ci.yml`.
- Reuse `migrations/0001_delta_qoralis_crawl.sql` directly. No new migration file, no `wrangler d1 migrations apply`, no D1 migrations directory, no schema-migration abstraction, and no application-owned migration tracking. No new table, index, trigger, lock, or retry store. D1 binding name is `DB`. Database name is `delta-qoralis-crawl`. The Builder's `database_id` is the fail-closed placeholder `REPLACE_BEFORE_DEPLOY`. That value is not a production id and must not be deployed.
- Do not add a dependency. Do not add Wrangler, Workers types, Axios, a YAML parser, a router, JWT, or OAuth. Do not add a health endpoint.
- Do not modify `src/crawler/run-loop.ts`, `src/crawler/fetch-page.ts`, `src/crawler/node-transport.ts`, `src/crawler/single-page-evidence.ts`, `src/crawler/migration.ts`, `src/crawler/evidence-domain.ts`, or `src/crawler/index.ts`. A change to `src/crawler/index.ts` is a stop condition. Stop and report it. Do not add the export.
- Existing local crawler tests keep passing. Do not weaken DQ-006 or DQ-020.
- Tests use `node:test` and `node:assert/strict`, compiled by `npm test` (`scripts/run-tests.cjs`). No live website and no live Worker. Inject `fetch` and the collector. Miniflare stays the existing `4.20260730.0` devDependency, `d1Persist: false`, no outbound network.
- Do not copy prices or quota integers into runtime code.
- Repository implementation complete is not production activation complete. The implementation PR must not mark DQ-025 Completed or Phase 2 Completed. `README.md` stays unchanged; a README edit needs separate human approval.
- The Builder does not run `wrangler login`, `wrangler d1 create`, `wrangler d1 execute`, `wrangler secret put`, `wrangler deploy`, or GitHub secret changes. The Builder does not replace `REPLACE_BEFORE_DEPLOY` with a guessed database id.
- Each task is committed only after Analyst APPROVED for that task. Do not push until Task 6 validation passes and a human authorizes the pull request. Do not merge in this plan.

## Review Focus

These five failure classes are the ones a happy-path test would miss. Each has one named test in its owning task.

1. **Auth before the body and before D1.** A missing bearer on a body that throws when read must return 401, and `prepare` must not run. Test: `missing bearer does not read the body or call D1` in Task 1.
2. **Fixed failures that swallow driver text, HTML, and the token.** A thrown D1 error string and stored HTML must be absent from the response and from console output. Test: `selection and persistence failures stay fixed and do not reflect driver text html or the token` in Task 1.
3. **Partial BusinessLead acceptance.** A select payload missing `businessName` must be rejected, and the decoder must not invent the missing field. Test: `select decoder rejects a snapshot that omits businessName` in Task 2.
4. **Gateway failure leakage into the operator log.** A non-2xx body that contains the token and a URL must become exit 1 and exactly `Crawl run failed.`, with one `fetch` and no body in stdout or stderr. Test: `cloud command failure output hides the gateway body and token` in Task 4.
5. **Eligibility changes when selection moves behind HTTP.** `CANCELLED` alone stays eligible, and a changed URL becomes eligible, through the real handler and D1. Test: `CANCELLED-only evidence stays eligible and a changed URL is eligible` in Task 3.

## File structure

Create:

- `src/crawl-gateway/worker.ts` — Worker `fetch` and `handleCrawlGatewayRequest`.
- `src/crawl-cloud/config.ts` — `loadCrawlCloudConfig`.
- `src/crawl-cloud/gateway-client.ts` — `createCrawlGatewayClient`.
- `src/crawl-cloud/command.ts` — `runCrawlCloudCommand`.
- `src/cli/crawl-cloud.ts` — process entry.
- `scripts/run-crawl-cloud.cjs` — compile-and-run script.
- `.github/workflows/crawl.yml`
- `wrangler.toml`
- `tests/unit/crawl-gateway-worker.test.ts`
- `tests/unit/crawl-gateway-client.test.ts`
- `tests/integration/crawl-gateway-d1.test.ts`
- `tests/unit/crawl-cloud-command.test.ts`
- `tests/unit/crawl-workflow.test.ts`
- `docs/decisions/0016-github-actions-crawl-runner.md`

Modify:

- `package.json` — add script `crawl:cloud` only.
- `docs/PLAN.md`
- `docs/BACKLOG.md`
- `docs/HANDOFF.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/DATA_MODEL.md`
- `docs/PRODUCT.md` — correct the stale DQ-024 sentence only. The approved spec requires this. Do not add a crawl how-to.

Do not modify `README.md`, `package-lock.json`, `.github/workflows/ci.yml`, or the preserved crawler files. The first implementation commit also adds the already written spec and this plan.

## Preserved interfaces

```ts
export async function runBoundedSinglePageCrawlWithDependencies(
  request: SinglePageCrawlRunRequest,
  dependencies: SinglePageCrawlRunDependencies,
): Promise<SinglePageCrawlRunResult>;

export type SinglePageCrawlRunDependencies = Readonly<{
  select: (maxAttempts: number) => Awaitable<readonly BusinessLead[]>;
  collect: (lead: BusinessLead, signal: AbortSignal) => Promise<SinglePageCrawlEvidence>;
  persist: (evidence: SinglePageCrawlEvidence) => Awaitable<StoredSinglePageCrawlEvidence>;
}>;

export function collectSinglePageCrawlEvidence(
  lead: BusinessLead,
  signal: AbortSignal,
): Promise<SinglePageCrawlEvidence>;

export function fetchCrawlPage(
  input: unknown,
  signal: AbortSignal,
): Promise<CrawlPageResult>;

export async function selectD1CrawlCandidates(
  database: D1CrawlDatabase,
  maxAttempts: number,
): Promise<readonly BusinessLead[]>;

export async function persistD1CrawlEvidence(
  database: D1CrawlDatabase,
  input: unknown,
): Promise<StoredSinglePageCrawlEvidence>;
```

`leadFromRow` returns a manual lead with `id`, `businessName`, `sourceReference`, `status`, `websiteObservation`, `createdAt`, `updatedAt`, `version`, and `sourceKind: "manual"`. A discovered lead adds `sourceProvider` and uses `sourceKind: "discovery"`. `JSON.stringify` of that object is the select element. Tests compare fields, not the example key order in the spec.

`StoredSinglePageCrawlEvidence` is `SinglePageCrawlEvidence & { id: number }`. The loop awaits `persist` and does not read `id`. The HTTP evidence response therefore has no `id`.

---

### Task 1: Worker gateway HTTP contract

**Files:**
- Create: `src/crawl-gateway/worker.ts`
- Create: `tests/unit/crawl-gateway-worker.test.ts`
- Commit also: `docs/superpowers/specs/2026-10-22-dq-025-github-actions-crawl-runner-design.md`
- Commit also: `docs/superpowers/plans/2026-10-22-dq-025-github-actions-crawl-runner.md`

**Interfaces:**
- Consumes: `selectD1CrawlCandidates`, `persistD1CrawlEvidence`, `D1CrawlDatabase` from `src/crawler/d1-crawl-store.ts`; `CrawlEvidencePersistenceError` from `src/crawler/evidence-domain.ts`; `CrawlRunError` from `src/crawler/run-loop.ts`; `LeadPersistenceError` from `src/leads/errors.ts`; `timingSafeEqual` from `node:crypto`.
- Produces:

```ts
export type CrawlGatewayEnv = Readonly<{
  DB: D1CrawlDatabase;
  CRAWL_GATEWAY_TOKEN?: string;
}>;

export function handleCrawlGatewayRequest(
  request: Request,
  env: CrawlGatewayEnv,
): Promise<Response>;

const worker: { fetch(request: Request, env: CrawlGatewayEnv): Promise<Response> };
export default worker;
```

`worker.fetch` returns `handleCrawlGatewayRequest(request, env)`.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feature/dq-025-github-actions-crawl-runner
```

- [ ] **Step 2: Write the failing tests**

Use a fake `D1CrawlDatabase` whose `prepare` increments a counter and whose `all`, `first`, and `run` can be set per test. A body probe is a `Request` whose `text()` throws `Error("body-was-read")`.

Token sentinel: `gateway-token-do-not-reflect`. HTML sentinel: `<p>html-sentinel</p>`. Driver sentinel: `D1_ERROR secret-sql`. Lead id: `00000000-0000-4000-8000-000000000001`.

Snake-case row passed to `leadFromRow` through the real `selectD1CrawlCandidates`:

```ts
const manualRow = {
  id: "00000000-0000-4000-8000-000000000001",
  business_name: "Distinctive Business Name",
  source_kind: "manual",
  source_provider: null,
  source_reference: "ref-distinctive",
  status: "recorded",
  website_presence: "present",
  website_url: "https://example.com/",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
  version: 3,
};
```

Assert every response has `content-type` `application/json; charset=utf-8` and `cache-control` `no-store`.

Tests and assertions:

- `missing bearer returns 401 and does not call D1`: no `Authorization` on `POST /internal/crawl/select` with `{ "maxAttempts": 1 }`. Status 401. Body exactly `{"error":"unauthorized"}`. `prepare` count is 0.
- `wrong bearer returns 401 and does not call D1`: `Authorization: Bearer wrong-token`. Same 401 body. `prepare` count is 0. Response text does not include `gateway-token-do-not-reflect` or `wrong-token`.
- `lowercase bearer scheme returns 401`: `Authorization: bearer gateway-token-do-not-reflect`. Status 401. `prepare` count is 0.
- `unset worker secret returns 401`: env token `undefined` and header `Bearer gateway-token-do-not-reflect`. Status 401. `prepare` count is 0.
- `missing bearer does not read the body or call D1`: body probe, no Authorization. Status 401. The probe throw does not escape. `prepare` count is 0.
- `unknown route returns 404`: `POST /internal/other`. Body exactly `{"error":"not_found"}`. `prepare` count is 0.
- `select path with a query returns 404`: `POST /internal/crawl/select?x=1`. Status 404. `prepare` count is 0.
- `trailing slash returns 404`: `POST /internal/crawl/select/`. Status 404.
- `wrong method returns 405`: `GET /internal/crawl/select`. Body exactly `{"error":"method_not_allowed"}`. `prepare` count is 0.
- `malformed select returns 400`: valid bearer, body `{ "maxAttempts": 1, "extra": true }`, and a second case body `{ "maxAttempts": "10" }`, and `0`, `61`, `1.5`. Each status 400, body exactly `{"error":"invalid_request"}`, `prepare` count is 0.
- `missing content type returns 400`: valid bearer, no `content-type`. Status 400. `prepare` count is 0.
- `oversized body returns 400 and does not call D1`: `content-length: 3145729`. Status 400. `prepare` count is 0. `text()` is not called.
- `json charset is accepted`: `content-type: application/json; charset=utf-8` with a valid select body reaches `prepare`.
- `valid bearer select returns the full BusinessLead snapshot`: `all()` returns `{ results: [manualRow] }`. Status 200. Parsed body has only key `candidates`. The one element equals `{ id, businessName: "Distinctive Business Name", sourceReference: "ref-distinctive", status: "recorded", websiteObservation: { presence: "present", url: "https://example.com/" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", version: 3, sourceKind: "manual" }`. It has no `sourceProvider`. Response text includes `Distinctive Business Name` because that field is part of the authenticated JSON body. `console.log`, `console.info`, `console.warn`, and `console.error` are not called.
- `empty select returns an empty candidate array`: `all()` returns `{ results: [] }`. Parsed body equals `{ candidates: [] }`.
- `malformed evidence returns 400`: body `{ "outcome": "fetched" }`. Status 400. `prepare` count is 0.
- `lead not found returns 400`: a valid failed-evidence object whose lead is absent (`first()` returns `null`). Status 400. Body exactly `{"error":"invalid_request"}`. Response text does not include the lead id.
- `valid evidence returns persisted true without html or id`: `first()` returns `{ present: 1 }` then a stored row `evidenceFromRow` accepts, and `run()` returns `{ meta: { changes: 1, last_row_id: 1 } }`. Request `bodyText` is `<p>html-sentinel</p>`. Status 200. Body exactly `{"persisted":true}`. Response text does not include `html-sentinel`, the lead id, or `gateway-token-do-not-reflect`.
- `selection and persistence failures stay fixed and do not reflect driver text html or the token`: select `all()` throws `Error("D1_ERROR secret-sql")`. Status 500. Body exactly `{"error":"internal_error"}`. Response text does not include `D1_ERROR`, `secret-sql`, or the token. Then evidence `run()` throws `Error("D1_ERROR secret-sql")` after a present lead, with `bodyText` `<p>html-sentinel</p>`. Status 500. Same fixed body. Response text does not include `html-sentinel`, `D1_ERROR`, `secret-sql`, or the token. Console methods are not called.
- `worker source does not import the crawl transport`: read `src/crawl-gateway/worker.ts` and assert it does not contain `fetch-page`, `node-transport`, `node:http`, `node:https`, `from "../db"`, `from "../crawler/index"`, or `from "../crawler/run"`. Assert it contains `selectD1CrawlCandidates`, `persistD1CrawlEvidence`, and `timingSafeEqual`.

Valid evidence request body, with `byteLength` equal to `Buffer.byteLength("<p>html-sentinel</p>", "utf8")`:

```ts
{
  outcome: "fetched",
  leadId: "00000000-0000-4000-8000-000000000001",
  leadVersion: 1,
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  statusCode: 200,
  contentType: "text/html",
  bodyText: "<p>html-sentinel</p>",
  byteLength,
  redirectCount: 0,
  attemptedAt: "2026-10-22T00:00:00.000Z",
}
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npm test`

Expected: FAIL because `src/crawl-gateway/worker.ts` does not exist.

- [ ] **Step 4: Implement the handler**

The tests and this order determine the body. Do not add another function export.

1. If `pathname` is not exactly `/internal/crawl/select` or `/internal/crawl/evidence`, or `search` is not empty, return 404. Do not read the body. Do not touch `env.DB`.
2. If `method` is not `POST`, return 405. Do not read the body. Do not touch `env.DB`.
3. If `CRAWL_GATEWAY_TOKEN` is missing or empty, or the header is not `Bearer <token>` with one space, or `timingSafeEqual` fails, return 401. Do not read the body. Do not touch `env.DB`.
4. Require the content type. Require `content-length` to be absent or a base-10 integer from 0 through `3_145_728`. Read `request.text()`. If its length exceeds `3_145_728`, return 400. `JSON.parse` failure returns 400.
5. Select: the parsed value must have exactly key `maxAttempts`, a safe integer from 1 through 60. Call `selectD1CrawlCandidates(env.DB, maxAttempts)`. Return 200 and `JSON.stringify({ candidates })`. `CrawlRunError`, `LeadPersistenceError`, and any other throw return 500.
6. Evidence: pass the parsed value unchanged to `persistD1CrawlEvidence(env.DB, parsed)`. `INVALID_EVIDENCE` and `LEAD_NOT_FOUND` return 400. `PERSISTENCE_FAILED` and any other throw return 500. Success returns 200 and `{"persisted":true}`.
7. Do not call `console.log`, `console.info`, `console.warn`, `console.error`, or `fetch`. Do not add a health route.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test`

Expected: PASS, including the existing crawler tests.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit after Analyst APPROVED**

```bash
git add docs/superpowers/specs/2026-10-22-dq-025-github-actions-crawl-runner-design.md \
  docs/superpowers/plans/2026-10-22-dq-025-github-actions-crawl-runner.md \
  src/crawl-gateway/worker.ts \
  tests/unit/crawl-gateway-worker.test.ts
git commit -m "feat: add crawl gateway worker"
```

Do not push.

---

### Task 2: Gateway HTTP client

**Files:**
- Create: `src/crawl-cloud/config.ts`
- Create: `src/crawl-cloud/gateway-client.ts`
- Create: `tests/unit/crawl-gateway-client.test.ts`

**Interfaces:**
- Consumes: `isBusinessLeadId`, `LEAD_STATUSES`, `normalizeWebsiteUrl` from `src/leads/domain.ts`; `SinglePageCrawlEvidence` from `src/crawler/single-page-evidence.ts`; `StoredSinglePageCrawlEvidence` from `src/crawler/evidence-domain.ts`; `fetch`.
- Produces:

```ts
export type CrawlCloudConfig = Readonly<{
  gatewayUrl: string;
  token: string;
  maxAttempts: number;
}>;

export class CrawlCloudConfigurationError extends Error {
  readonly name = "CrawlCloudConfigurationError";
  constructor();
}

export function loadCrawlCloudConfig(
  environment: Readonly<Record<string, string | undefined>>,
): CrawlCloudConfig;

export class CrawlGatewayError extends Error {
  readonly name = "CrawlGatewayError";
  constructor();
}

export type CrawlGatewayClient = Readonly<{
  select(maxAttempts: number, signal: AbortSignal): Promise<readonly BusinessLead[]>;
  persist(
    evidence: SinglePageCrawlEvidence,
    signal: AbortSignal,
  ): Promise<StoredSinglePageCrawlEvidence>;
}>;

export function createCrawlGatewayClient(
  config: CrawlCloudConfig,
  fetchImpl: typeof fetch,
): CrawlGatewayClient;

function decodeBusinessLeadSnapshots(input: unknown): readonly BusinessLead[];
```

`decodeBusinessLeadSnapshots` is internal to `src/crawl-cloud/gateway-client.ts`. Do not export it. `select` passes the parsed `candidates` value to it. The function requires an array, validates every element as a complete existing `BusinessLead`, and returns frozen snapshots. It throws `new CrawlGatewayError()` and nothing else. It does not use `as BusinessLead` or `as BusinessLead[]`. There is no `CrawlCandidate`, no second lead DTO, and no schema library.

`CrawlCloudConfigurationError` message is exactly `Crawl gateway configuration is invalid.` `CrawlGatewayError` message is exactly `Crawl gateway request failed.` Neither constructor accepts a caller string.

- [ ] **Step 1: Write the failing tests**

Config fixture: `{ gatewayUrl: "https://gateway.example", token: "gateway-token-do-not-reflect", maxAttempts: 10 }`.

Manual snapshot:

```ts
const manualLead = {
  id: "00000000-0000-4000-8000-000000000001",
  businessName: "Distinctive Business Name",
  sourceKind: "manual",
  sourceReference: "ref-distinctive",
  status: "recorded",
  websiteObservation: { presence: "present", url: "https://example.com/" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 3,
};
```

Discovered snapshot: the same fields plus `sourceKind: "discovery"` and `sourceProvider: "fixture_directory"`.

Tests and assertions:

- `loadCrawlCloudConfig reads the gateway origin token and attempt count`: env URL `https://gateway.example/`, token `gateway-token-do-not-reflect`, `CRAWL_MAX_ATTEMPTS` unset. Result equals the fixture with `gatewayUrl` `https://gateway.example/`. `CRAWL_MAX_ATTEMPTS=60` yields `maxAttempts` 60. `CRAWL_MAX_ATTEMPTS=10` yields 10.
- `loadCrawlCloudConfig rejects missing and unsafe values`: missing URL, missing token, empty token, token `bad token`, URL `http://gateway.example`, URL `https://user:pass@gateway.example`, URL `https://gateway.example/crawl`, URL `https://gateway.example?x=1`, `CRAWL_MAX_ATTEMPTS` `0`, `61`, `1.5`, `01`, and `10 `. Each throws `CrawlCloudConfigurationError`. `error.message` is the fixed sentence and does not include `gateway.example`, `bad token`, or `user`.
- `select posts bearer and maxAttempts and returns the same BusinessLead fields`: one injected `fetch` resolves 200 and `{ candidates: [manualLead] }`. The request URL is `https://gateway.example/internal/crawl/select`. Method is `POST`. `authorization` is `Bearer gateway-token-do-not-reflect`. `content-type` is `application/json`. Body is `{"maxAttempts":10}`. The returned array deep-equals `[manualLead]`. `Object.isFrozen` is true for the array, the lead, and `websiteObservation`. `fetch` was called once.
- `decodeBusinessLeadSnapshots accepts a valid manual BusinessLead`: the select result deep-equals `[manualLead]` and has no `sourceProvider`.
- `decodeBusinessLeadSnapshots accepts a valid discovered BusinessLead`: the discovered fixture round-trips, including `sourceProvider: "fixture_directory"`. The result is frozen.
- `decodeBusinessLeadSnapshots rejects a missing required field`: candidates are the manual fixture without `businessName`. The call rejects with `CrawlGatewayError`. The message is the fixed sentence. It does not include `Distinctive`, `example.com`, or the token. No returned object contains a filled `businessName`.
- `decodeBusinessLeadSnapshots rejects an unexpected field`: manual fixture plus `websiteUrl`. Rejects with `CrawlGatewayError`. The message does not include `websiteUrl` or `https://example.com/`.
- `decodeBusinessLeadSnapshots rejects a malformed website observation`: `{ presence: "present" }` without `url`, `{ presence: "unknown", url: "https://example.com/" }`, and `{ presence: "missing" }` plus an extra key. Each rejects with `CrawlGatewayError`. The message does not include `example.com`.
- `decodeBusinessLeadSnapshots rejects malformed id version and timestamps`: `id` `not-a-uuid`, `version` `1.5`, `version` `0`, `createdAt` `2026-01-01`, and `updatedAt` `2026-01-02T00:00:00.000`. Each rejects with `CrawlGatewayError`. The message does not include the bad value.
- `decodeBusinessLeadSnapshots rejects a bad source-kind relationship`: `sourceKind: "manual"` together with `sourceProvider`, `sourceKind: "discovery"` without `sourceProvider`, and `sourceProvider: "Bad-Provider"`. Each rejects with `CrawlGatewayError`.
- `decodeBusinessLeadSnapshots rejects the whole response when one element is bad`: candidates are `[manualLead, manualLead without businessName]`. The call rejects with `CrawlGatewayError`. It does not return the valid first lead.
- `gateway client source names the decoder and does not cast the response`: read `src/crawl-cloud/gateway-client.ts` and assert it contains `function decodeBusinessLeadSnapshots`. Assert it does not contain `as BusinessLead`.
- `malformed select JSON is rejected`: 200 body `not-json`, and 200 body `{ "candidates": [], "extra": true }`. Each rejects with `CrawlGatewayError`. `fetch` calls for that operation equal 1.
- `non-2xx select fails once with a fixed error`: status 500, body `{"error":"internal_error","detail":"https://secret.example gateway-token-do-not-reflect"}`. Rejects with `CrawlGatewayError`. Message and `String(error)` do not include `secret.example`, `gateway-token-do-not-reflect`, or `internal_error`. `fetch` calls equal 1.
- `evidence post sends fetched keys and persist success has no id`: post this object, whose `byteLength` is `Buffer.byteLength("<p>html-sentinel</p>", "utf8")`:

```ts
{
  outcome: "fetched",
  leadId: "00000000-0000-4000-8000-000000000001",
  leadVersion: 1,
  requestedUrl: "https://example.com/",
  finalUrl: "https://example.com/",
  statusCode: 200,
  contentType: "text/html",
  bodyText: "<p>html-sentinel</p>",
  byteLength,
  redirectCount: 0,
  attemptedAt: "2026-10-22T00:00:00.000Z",
}
```

URL ends with `/internal/crawl/evidence`. Parsed request body equals that object and has exactly `outcome`, `leadId`, `leadVersion`, `requestedUrl`, `finalUrl`, `statusCode`, `contentType`, `bodyText`, `byteLength`, `redirectCount`, `attemptedAt`. Response `{ "persisted": true }`. The resolved value is that same evidence object and `"id" in result` is false.
- `evidence post sends failed keys`: failed object with exactly `outcome`, `leadId`, `leadVersion`, `requestedUrl`, `failure`, `attemptedAt`, and `failure: "TIMEOUT"`. The posted JSON equals that object.
- `non-2xx persist fails with a fixed error and does not include the body`: status 500 and body containing `html-sentinel` and the token. Rejects with `CrawlGatewayError`. The message does not include those sentinels. `fetch` calls equal 1.
- `persist rejects a response that echoes html or an id`: 200 body `{ "persisted": true, "id": 4 }` and 200 body `{ "persisted": true, "bodyText": "<p>html-sentinel</p>" }`. Both reject with `CrawlGatewayError`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`

Expected: FAIL because `src/crawl-cloud/gateway-client.ts` does not exist.

- [ ] **Step 3: Implement config and the client**

`loadCrawlCloudConfig` reads only `CRAWL_GATEWAY_URL`, `CRAWL_GATEWAY_TOKEN`, and `CRAWL_MAX_ATTEMPTS`. It does not call `loadConfig` and does not read `DATABASE_URL`.

URL rules: `new URL` succeeds, protocol is `https:`, username and password are empty, search and hash are empty, pathname is empty or `/`. Token rules: nonempty and no match of `/[\s\u0000-\u001f\u007f-\u009f]/u`. Attempt rules: unset means 10; otherwise the string matches `/^(?:[1-9]|[1-5][0-9]|60)$/`.

`select` posts `{ maxAttempts }` once. The 200 body has exactly key `candidates`. Pass that value to `decodeBusinessLeadSnapshots`. Do not write `response as BusinessLead[]` or `candidates as BusinessLead[]`.

`decodeBusinessLeadSnapshots` is the untrusted HTTP boundary. It accepts only an array. A non-array throws `new CrawlGatewayError()`. For every element it checks the complete existing `BusinessLead` shape, then returns `Object.freeze` of a new array whose elements are new frozen leads. Nested `websiteObservation` is a new frozen object. One bad element throws before any array is returned. The thrown error is only `CrawlGatewayError`, and its message stays the fixed sentence.

- Manual keys exactly: `id`, `businessName`, `sourceKind`, `sourceReference`, `status`, `websiteObservation`, `createdAt`, `updatedAt`, `version`, with `sourceKind` `"manual"`. A manual object that also has `sourceProvider` is rejected.
- Discovered keys: those plus `sourceProvider`, with `sourceKind` `"discovery"`. Discovery without `sourceProvider` is rejected.
- `id` passes `isBusinessLeadId`. `version` is a safe integer `>= 1`. `status` is in `LEAD_STATUSES`.
- `websiteObservation` is exactly `{ presence: "unknown" }`, `{ presence: "missing" }`, or `{ presence: "present", url }` where `normalizeWebsiteUrl(url) === url`. Any other presence, a present observation without `url`, or a URL on `unknown` or `missing` is rejected.
- `createdAt` and `updatedAt` are 24-character strings whose `new Date(value).toISOString()` equals the value.
- `businessName` and `sourceReference` are nonempty and equal to their trim.
- Discovery also requires `sourceProvider` to match `/^[a-z][a-z0-9_]*$/u` with Unicode length 1 through 64, `sourceReference` Unicode length at most 512, `businessName` Unicode length at most 300, and no control character in those three strings. Control characters are `/[\u0000-\u001f\u007f-\u009f]/u`.
- Do not fill a missing field. Do not add `CrawlCandidate` or another lead type.

`persist` posts the evidence object once. The 200 body has exactly `{ persisted: true }`. Return `evidence as StoredSinglePageCrawlEvidence` without adding `id`. Any other status, JSON failure, or shape throws `new CrawlGatewayError()`. There is no retry loop.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit after Analyst APPROVED**

```bash
git add src/crawl-cloud/config.ts src/crawl-cloud/gateway-client.ts \
  tests/unit/crawl-gateway-client.test.ts
git commit -m "feat: add crawl gateway client"
```

Do not push.

---

### Task 3: Worker and D1 eligibility

**Files:**
- Create: `tests/integration/crawl-gateway-d1.test.ts`
- Modify only if a test fails: `src/crawl-gateway/worker.ts`

**Interfaces:**
- Consumes: `handleCrawlGatewayRequest` and `CrawlGatewayEnv` from Task 1; `D1CrawlDatabase` through Miniflare `getD1Database("DB")`; `migrations/0001_delta_qoralis_crawl.sql`.
- Produces: no new production export. The handler already calls the real store.

- [ ] **Step 1: Write the failing integration tests**

Copy the Miniflare setup from `tests/integration/d1-crawl-store.test.ts`: `modules: true`, inline script that only returns `new Response("ok")`, `d1Databases: { DB: "delta-qoralis-test" }`, `d1Persist: false`, read and `exec` the migration, `dispose` in `finally`. Do not set an outbound service. Call `handleCrawlGatewayRequest` in the Node test process with that D1 object. Store code keeps using Node `Buffer`.

Helper `post(database, path, body)` sends `POST` with `content-type: application/json`, `Authorization: Bearer gateway-token-do-not-reflect`, and `JSON.stringify(body)`.

Insert leads with the same column list as `insertLead` in the existing D1 test. Use two present recorded leads, created at `2026-01-01T00:00:00.000Z` and `2026-01-02T00:00:00.000Z`, URLs `https://example.com/a` and `https://example.com/b`.

Tests and assertions:

- `migration applies through the handler`: after `exec`, select with `{ maxAttempts: 10 }` returns 200 and `{ candidates: [] }`.
- `select returns eligible leads in created_at id order`: both leads are returned in that order. Each candidate includes `businessName`, `sourceReference`, `websiteObservation.url`, `createdAt`, and `version` from the inserted row.
- `select respects maxAttempts`: three eligible leads and `{ maxAttempts: 2 }` returns two, the earlier pair.
- `fetched evidence blocks the same URL`: insert a `fetched` evidence row for the lead's current URL through SQL, then select. That lead id is absent.
- `non-CANCELLED failure blocks the same URL`: evidence `failure_code` `TIMEOUT` for the current URL. That lead id is absent.
- `CANCELLED-only evidence stays eligible and a changed URL is eligible`: one lead whose only evidence row is `failure_code` `CANCELLED` for its current URL is selected. A second lead with `fetched` evidence for `https://example.com/a` is absent; after `UPDATE business_leads SET website_url = "https://example.com/changed" WHERE id = ?`, select includes that lead and the candidate `websiteObservation.url` is `https://example.com/changed`.
- `evidence route writes fetched and failed rows`: `POST /internal/crawl/evidence` with one fetched object and one failed object (`failure: "TIMEOUT"`). Both responses are exactly `{"persisted":true}`. A following `SELECT outcome, failure_code, body_text FROM single_page_crawl_evidence` returns both outcomes. The HTTP responses do not contain `body_text`.
- `append-only triggers still reject update and delete`: after the write above, `UPDATE single_page_crawl_evidence SET outcome = outcome` and `DELETE FROM single_page_crawl_evidence` both reject.

- [ ] **Step 2: Run the new coverage**

Run: `npm test`

Expected: PASS if Task 1 already delegates to the real store. If a test fails, change only `src/crawl-gateway/worker.ts` so it keeps calling `selectD1CrawlCandidates` and `persistD1CrawlEvidence`. Do not copy eligibility SQL into the handler.

- [ ] **Step 3: Commit after Analyst APPROVED**

```bash
git add tests/integration/crawl-gateway-d1.test.ts src/crawl-gateway/worker.ts
git commit -m "test: cover crawl gateway eligibility on D1"
```

Do not push. If `worker.ts` is unchanged, commit the test file only.

---

### Task 4: Cloud crawl command

**Files:**
- Create: `src/crawl-cloud/command.ts`
- Create: `src/cli/crawl-cloud.ts`
- Create: `scripts/run-crawl-cloud.cjs`
- Create: `tests/unit/crawl-cloud-command.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `loadCrawlCloudConfig`, `CrawlCloudConfigurationError`, `CrawlCloudConfig` from `src/crawl-cloud/config.ts`; `createCrawlGatewayClient` from `src/crawl-cloud/gateway-client.ts`; `runBoundedSinglePageCrawlWithDependencies` and `SinglePageCrawlRunResult` from `src/crawler/run-loop.ts`; `collectSinglePageCrawlEvidence` from `src/crawler/single-page-evidence.ts`.
- Produces:

```ts
export type CrawlCloudCommandRequest = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  signal: AbortSignal;
}>;

export type CrawlCloudCommandResult = Readonly<{
  exitCode: 0 | 1 | 130;
  stdout: string;
  stderr: string;
}>;

export type CrawlCloudCommandDependencies = Readonly<{
  fetchImpl?: typeof fetch;
  collect?: (
    lead: BusinessLead,
    signal: AbortSignal,
  ) => Promise<SinglePageCrawlEvidence>;
}>;

export function runCrawlCloudCommand(
  request: CrawlCloudCommandRequest,
  dependencies?: CrawlCloudCommandDependencies,
): Promise<CrawlCloudCommandResult>;
```

```ts
export type CrawlCloudProcessIO = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  registerSigint: (handler: () => void) => () => void;
  fetchImpl?: typeof fetch;
  collect?: CrawlCloudCommandDependencies["collect"];
}>;

export function main(io?: CrawlCloudProcessIO): Promise<number>;
```

`main` follows `src/cli/discover.ts`: one `AbortController`, SIGINT calls `abort`, `main` writes `result.stdout` and `result.stderr`, and the `require.main === module` path sets `process.exitCode` without writing a caught error. There is no argv parser.

`package.json` scripts become:

```json
"discover": "node scripts/run-discovery.cjs",
"crawl:cloud": "node scripts/run-crawl-cloud.cjs"
```

`scripts/run-crawl-cloud.cjs` is `scripts/run-discovery.cjs` with the entry path `src/cli/crawl-cloud.js` instead of `src/cli/discover.js`.

- [ ] **Step 1: Write the failing tests**

Valid env:

```ts
const env = {
  CRAWL_GATEWAY_URL: "https://gateway.example",
  CRAWL_GATEWAY_TOKEN: "gateway-token-do-not-reflect",
};
```

Inject `fetchImpl` and `collect`. Do not call the network. The default `collect` is `collectSinglePageCrawlEvidence`; behavior tests pass a spy so no website fetch runs.

Tests and assertions:

- `missing gateway url exits 1 with the configuration sentence`: env without `CRAWL_GATEWAY_URL`. `exitCode` 1. `stdout` is `""`. `stderr` is `Crawl gateway configuration is invalid.\n`. `fetch` calls equal 0.
- `missing token exits 1`: env without `CRAWL_GATEWAY_TOKEN`. Same stderr. `fetch` calls equal 0.
- `invalid url exits 1 and does not print the url`: `CRAWL_GATEWAY_URL` is `http://user:secret-url-sentinel@gateway.example/crawl`. `stderr` is the configuration sentence. `stdout + stderr` does not include `secret-url-sentinel` or `gateway.example`.
- `token with whitespace exits 1 and does not print the token`: token `bad token sentinel`. Output does not include `bad token sentinel`.
- `default max attempts is 10`: select fetch records the posted body. It equals `{"maxAttempts":10}`. Response `{ candidates: [] }` makes `exitCode` 0.
- `max attempts 0 and 61 are configuration failures`: each exits 1 before `fetch`.
- `max attempts 60 is accepted`: `CRAWL_MAX_ATTEMPTS=60` posts `{"maxAttempts":60}`.
- `command runs select then collect then persist once`: select returns one candidate:

```ts
{
  id: "00000000-0000-4000-8000-000000000001",
  businessName: "Distinctive Business Name",
  sourceKind: "manual",
  sourceReference: "ref-distinctive",
  status: "recorded",
  websiteObservation: { presence: "present", url: "https://example.com/" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  version: 3,
}
```

`collect` returns `{ outcome: "failed", leadId: "00000000-0000-4000-8000-000000000001", leadVersion: 3, requestedUrl: "https://example.com/", failure: "TIMEOUT", attemptedAt: "2026-10-22T00:00:00.000Z" }`. Persist returns 200 `{ "persisted": true }`. Call order is select, collect, persist. `collect` receives those lead fields and the request signal. Persist body equals the evidence object.
- `main aborts on SIGINT`: `registerSigint` calls the handler before it returns. `main` passes `fetchImpl` through to the command. `fetchImpl` call count is 0. The resolved exit code is 130. Stderr is `Crawl run was cancelled.\n`. Stdout contains `status: cancelled` and `selected: 0`. Stdout and stderr do not include the token.
- `summary is counts only`: for that one failed persist, `stdout` is exactly:

```text
status: completed
reason: candidates_exhausted
selected: 1
attempted: 1
fetched: 0
failed: 1
persisted: 1
```

with a trailing newline. `stderr` is `""`. `exitCode` is 0. Output does not include `Distinctive`, `example.com`, the lead id, `ref-distinctive`, `2026-01-01`, or the token.

- `budget exhausted summary uses the loop reason`: select returns one lead and `CRAWL_MAX_ATTEMPTS=1`. `stdout` contains `reason: budget_exhausted`.
- `cancellation returns 130 and the cancellation sentence`: the request signal is already aborted. `exitCode` 130. `stderr` is `Crawl run was cancelled.\n`. `stdout` contains `status: cancelled` and `selected: 0`. `fetch` calls equal 0.
- `cancellation after a returned attempt keeps the counts`: select returns one lead, `collect` returns failed evidence with `failure: "CANCELLED"`, persist succeeds. `exitCode` 130. `stdout` contains `attempted: 1`, `failed: 1`, `persisted: 1`, and `status: cancelled`. `stderr` is the cancellation sentence.
- `cloud command failure output hides the gateway body and token`: select responds 500 with body `https://secret.example gateway-token-do-not-reflect <p>html-sentinel</p>`. `exitCode` 1. `stderr` is `Crawl run failed.\n`. `stdout` is `""`. Combined output does not include `secret.example`, `gateway-token-do-not-reflect`, `html-sentinel`, or `Error`. `fetch` calls equal 1.
- `command does not open local storage`: read `src/crawl-cloud/command.ts` and assert it contains `runBoundedSinglePageCrawlWithDependencies` and `collectSinglePageCrawlEvidence`. Assert it does not contain `runBoundedSinglePageCrawl(`, `loadConfig`, `createDatabase`, `better-sqlite3`, or `selectD1CrawlCandidates`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npm test`

Expected: FAIL because `src/crawl-cloud/command.ts` does not exist.

- [ ] **Step 3: Implement the command, CLI, and script**

`runCrawlCloudCommand`:

1. Call `loadCrawlCloudConfig`. `CrawlCloudConfigurationError` returns exit 1, empty stdout, and `Crawl gateway configuration is invalid.\n`.
2. Build the client with `dependencies.fetchImpl ?? fetch`.
3. Call `runBoundedSinglePageCrawlWithDependencies` once with the loaded `maxAttempts`, the request signal, `select` bound to `client.select`, `collect` bound to `dependencies.collect ?? collectSinglePageCrawlEvidence`, and `persist` bound to `client.persist`.
4. On a returned result, stdout is `status`, `reason`, `selected`, `attempted`, `fetched`, `failed`, `persisted`, then a blank line, joined by `\n` and ending in `\n`. Completed returns exit 0 and empty stderr. Cancelled returns exit 130 and `Crawl run was cancelled.\n`.
5. On a throw, if `request.signal.aborted`, return exit 130, empty stdout, and the cancellation sentence. Otherwise return exit 1, empty stdout, and `Crawl run failed.\n`. Do not append `error.message`.

`main` passes `io.fetchImpl` and `io.collect` into `runCrawlCloudCommand`. When `main` is invoked as the process entry, those fields are absent.

Do not import `src/db`, `src/config`, or `src/crawler/run.ts`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit after Analyst APPROVED**

```bash
git add src/crawl-cloud/command.ts src/cli/crawl-cloud.ts \
  scripts/run-crawl-cloud.cjs package.json \
  tests/unit/crawl-cloud-command.test.ts
git commit -m "feat: add cloud crawl command"
```

Do not push. `package-lock.json` must stay unmodified.

---

### Task 5: Workflow and Wrangler config

**Files:**
- Create: `.github/workflows/crawl.yml`
- Create: `wrangler.toml`
- Create: `tests/unit/crawl-workflow.test.ts`

**Interfaces:**
- Consumes: `npm run crawl:cloud` from Task 4. No TypeScript import.
- Produces: the workflow and Wrangler files below. No new function.

- [ ] **Step 1: Write the failing static test**

`tests/unit/crawl-workflow.test.ts` reads both files as UTF-8 text. No YAML parser.

Test `crawl workflow schedules 06:17 Europe/Warsaw and has no deploy credentials`:

- `crawl.yml` includes `cron: "17 6 * * *"`.
- It includes `timezone: "Europe/Warsaw"`.
- It includes `workflow_dispatch`, `contents: read`, `concurrency:`, `cancel-in-progress: false`, `npm ci`, and `npm run crawl:cloud`.
- It includes `CRAWL_GATEWAY_URL: ${{ secrets.CRAWL_GATEWAY_URL }}` and `CRAWL_GATEWAY_TOKEN: ${{ secrets.CRAWL_GATEWAY_TOKEN }}`.
- It includes `CRAWL_MAX_ATTEMPTS: "10"`.
- It does not include `CLOUDFLARE_API_TOKEN`, `docker`, `container`, `wrangler`, or `0 6 * * *`.

Test `wrangler config binds DB and does not store the gateway token`:

- `wrangler.toml` includes `name = "delta-qoralis-crawl-gateway"`.
- It includes `main = "src/crawl-gateway/worker.ts"`.
- It includes `compatibility_date = "2026-10-22"`.
- It includes `nodejs_compat`.
- It includes `binding = "DB"`, `database_name = "delta-qoralis-crawl"`, and `database_id = "REPLACE_BEFORE_DEPLOY"`.
- That `database_id` assertion records the fail-closed repository placeholder. The test does not treat `REPLACE_BEFORE_DEPLOY` as a production database id.
- It does not include `no_nodejs_compat`, `[triggers]`, `crons`, `CRAWL_GATEWAY_TOKEN`, or `migrations apply`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test`

Expected: FAIL because the two files do not exist.

- [ ] **Step 3: Add the two files**

Write `.github/workflows/crawl.yml` exactly:

```yaml
name: Crawl

on:
  schedule:
    # 06:17 Europe/Warsaw daily. timezone handles DST. Minute 17 avoids the start of the hour.
    - cron: "17 6 * * *"
      timezone: "Europe/Warsaw"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: crawl
  cancel-in-progress: false

jobs:
  crawl:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Crawl
        env:
          CRAWL_GATEWAY_URL: ${{ secrets.CRAWL_GATEWAY_URL }}
          CRAWL_GATEWAY_TOKEN: ${{ secrets.CRAWL_GATEWAY_TOKEN }}
          CRAWL_MAX_ATTEMPTS: "10"
        run: npm run crawl:cloud
```

Write `wrangler.toml` exactly:

```toml
name = "delta-qoralis-crawl-gateway"
main = "src/crawl-gateway/worker.ts"
compatibility_date = "2026-10-22"
compatibility_flags = [ "nodejs_compat" ]

[[d1_databases]]
binding = "DB"
database_name = "delta-qoralis-crawl"
database_id = "REPLACE_BEFORE_DEPLOY"
```

`REPLACE_BEFORE_DEPLOY` is intentionally non-deployable. The Builder creates this file and does not deploy it. Do not edit `.github/workflows/ci.yml`.

- [ ] **Step 4: Run the tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit after Analyst APPROVED**

```bash
git add .github/workflows/crawl.yml wrangler.toml tests/unit/crawl-workflow.test.ts
git commit -m "feat: add scheduled crawl workflow"
```

Do not push.

---

### Task 6: Documentation and repository validation

**Files:**
- Create: `docs/decisions/0016-github-actions-crawl-runner.md`
- Modify: `docs/PLAN.md`, `docs/BACKLOG.md`, `docs/HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DATA_MODEL.md`, `docs/PRODUCT.md`
- Do not modify: `README.md`, `docs/decisions/0015-d1-crawl-store-and-async-run-core.md`

**Interfaces:**
- Consumes: the implemented files from Tasks 1–5.
- Produces: documentation that says the code exists and production activation has not happened.

- [ ] **Step 1: Write the decision and replace the obsolete status**

Create `docs/decisions/0016-github-actions-crawl-runner.md` with status, context, decision, and consequences:

- Status: accepted for implementation. Production activation is not done.
- Context: DQ-024 left `runBoundedSinglePageCrawlWithDependencies` and the D1 store. The old DQ-025 title assumed the Worker would pin HTTPS. This decision leaves website transport on the Node crawler.
- Decision: GitHub Actions runs `npm run crawl:cloud` once per schedule. The Worker authenticates `CRAWL_GATEWAY_TOKEN` and calls `selectD1CrawlCandidates` and `persistD1CrawlEvidence`. The schedule is `17 6 * * *` with `timezone: "Europe/Warsaw"`. Schema remains `migrations/0001_delta_qoralis_crawl.sql`.
- Consequences: Phase 2 stays current until the ten production checks in the spec succeed. Discovery stays on local SQLite. Decision 0015 stays the DQ-024 record. Do not edit decision 0015.

In `docs/PLAN.md`, `docs/BACKLOG.md`, and `docs/HANDOFF.md`, replace the title `DQ-025 — Worker Pinned Transport and Scheduled Runner` and the "blocked and unstarted" sentences with:

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is implemented in the repository and is not production-complete. Production D1, the Worker deploy, the Worker secret, and the GitHub Actions crawl run are still human-controlled and have not been performed. Phase 2 — Website Crawling remains current and is not completed. Cloudflare autonomous crawling is not yet enabled. Phase 3 — Website Analysis remains planned.

In `docs/ARCHITECTURE.md`, replace the blocked DQ-025 paragraph with the same status plus the runtime split: GitHub Actions Node collects through `fetchCrawlPage`; the Worker only selects and persists; `normalizeSinglePageCrawlEvidence` keeps Node `Buffer` through `nodejs_compat`.

In `docs/SECURITY.md`, replace the sentence that DQ-025 remains blocked on Worker pinning. State that the crawl job has only `CRAWL_GATEWAY_URL` and `CRAWL_GATEWAY_TOKEN`, the Worker checks the bearer before D1, responses do not reflect tokens, SQL, driver text, or HTML, and the Worker does not fetch websites. State that autonomous crawling is not yet enabled.

In `docs/DATA_MODEL.md`, state that this change creates no production D1 database and no new table. The cloud schema remains `business_leads`, `single_page_crawl_evidence`, `business_leads_discovery_identity_idx`, and the two append-only evidence triggers in `migrations/0001_delta_qoralis_crawl.sql`. Discovery remains local SQLite.

In `docs/PRODUCT.md`, correct the stale claim that DQ-024 has not started. Use the same DQ-025 status sentence. Do not say Phase 2 is completed.

Leave `README.md` unchanged. It currently says `npm run discover` is the only operator entry and that there is no crawl command. That will be stale after this work. Do not fix it here. A README change needs separate human approval.

Do not write that autonomous crawling is enabled. Do not write that Phase 2 is completed. Do not describe a production database id or a real token.

- [ ] **Step 2: Run repository validation**

Run, in this order:

```bash
npm run typecheck
npm test
npm ls --depth=0
git diff --check
git status --short
git diff --stat
git diff --name-only
```

Expected:

- `npm run typecheck` exits 0.
- `npm test` exits 0.
- `npm ls --depth=0` lists the existing dependencies only: `better-sqlite3`, `ipaddr.js`, `@types/better-sqlite3`, `@types/node`, `miniflare`, `typescript`. No Wrangler, Axios, YAML parser, or Workers types package.
- `git diff --check` prints nothing.
- `git diff --name-only` against `HEAD` contains only this task's documentation files before the commit. It does not contain `.github/workflows/ci.yml`, `package-lock.json`, `README.md`, or any preserved crawler file.
- Search the branch diff for `CLOUDFLARE_API_TOKEN`, `no_nodejs_compat`, `[triggers]`, `docker`, and `container`. The only allowed absence is that those strings are not in `.github/workflows/crawl.yml` or `wrangler.toml`. `crawl.yml` may be absent from this uncommitted diff because Task 5 already committed it; search the files on disk too.
- Search `docs/PLAN.md`, `docs/BACKLOG.md`, `docs/HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DATA_MODEL.md`, and `docs/PRODUCT.md` for `DQ-025`. Each mention says production activation has not been performed. None say Phase 2 is completed or that autonomous crawling is enabled.
- `wrangler.toml` still contains `database_id = "REPLACE_BEFORE_DEPLOY"` and does not contain a bearer token value. This task does not replace the placeholder and does not deploy.
- `git status --short` shows only the documentation files for this task, unstaged or staged for the commit below. No secret file and no `.env`.

If a check fails, fix the owning file and make a new commit. Do not amend an earlier commit.

- [ ] **Step 3: Commit after Analyst APPROVED**

```bash
git add docs/decisions/0016-github-actions-crawl-runner.md \
  docs/PLAN.md docs/BACKLOG.md docs/HANDOFF.md docs/ARCHITECTURE.md \
  docs/SECURITY.md docs/DATA_MODEL.md docs/PRODUCT.md
git commit -m "docs: record DQ-025 gateway without production completion"
```

Do not push until a human authorizes the pull request. Do not merge. Do not deploy.

## Human activation, not Builder work

The Builder does not execute this section. After merge, and only after a separate human authorization, the human operator initializes production D1 from the existing standalone SQL file. DQ-024 produced that one crawl-only file and no application migration framework. Do not run `wrangler d1 migrations apply`. Do not add migration files, a `migrations` directory for Wrangler, a schema-migration abstraction, or Delta Qoralis-owned migration tracking.

1. `npx wrangler login`
2. Create the database: `npx wrangler d1 create delta-qoralis-crawl`. Record the printed database id.
3. Configure the real D1 binding in `wrangler.toml` before any deploy. Replace `REPLACE_BEFORE_DEPLOY` with that id. Keep `binding = "DB"` and `database_name = "delta-qoralis-crawl"`. Review that configuration change and keep the real database id in the repository configuration. The database id is configuration, not the bearer secret. Do not leave it as an undocumented local-only difference. Never deploy while `database_id = "REPLACE_BEFORE_DEPLOY"` remains.
4. Execute the existing file against remote D1:

```bash
npx wrangler d1 execute delta-qoralis-crawl --remote --file=migrations/0001_delta_qoralis_crawl.sql
```

5. Verify the remote schema with a read-only query:

```bash
npx wrangler d1 execute delta-qoralis-crawl --remote --command "SELECT name FROM sqlite_master ORDER BY name"
```

Confirm `business_leads`, `business_leads_discovery_identity_idx`, `single_page_crawl_evidence`, `single_page_crawl_evidence_prevent_update`, and `single_page_crawl_evidence_prevent_delete`.
6. `npx wrangler secret put CRAWL_GATEWAY_TOKEN`
7. `npx wrangler deploy`
8. Set GitHub repository secrets `CRAWL_GATEWAY_URL` and `CRAWL_GATEWAY_TOKEN`.
9. Run the Crawl workflow with `workflow_dispatch` and read the counts-only log.

Production activation is complete only when all ten spec checks have succeeded: production D1 exists, migration 0001 is applied, the Worker is deployed on Workers Free, the Worker secret is set, the GitHub URL and token are set, the manual run succeeds, the existing Node DQ-020 transport performs the website crawl, evidence is in production D1, a scheduled run can execute without the Mac, and no paid Container or paid service was required. Only a later, separate documentation change may then mark DQ-025 Completed, Phase 2 Completed, and Phase 3 Next. That change is not part of this plan and does not implement Phase 3.

There is no deployment CI job and no Cloudflare API token in the crawl workflow.
