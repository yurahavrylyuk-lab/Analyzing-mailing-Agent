# DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway

Status: design, human-approved, not implemented.

The title "Worker Pinned Transport and Scheduled Runner" is obsolete. Decision 0015 recorded that older title as blocked because a Worker cannot pin an HTTPS socket to an approved address, keep the logical hostname as SNI, and verify that certificate. This design removes that blocker by leaving website transport on the existing Node crawler. The Worker does not open a public-website socket. No new table is required.

## 1. Context

HEAD `91a645e130bcd2565be7a23389a69dc85e4cb517` on `main` already has a bounded crawl loop, a D1 crawl store, and the DQ-006 / DQ-020 pinned fetch. Phase 2 is current and is not completed. Discovery still writes local SQLite through `npm run discover`. There is no Worker, no Wrangler config, no production D1 database, and no crawl workflow. `.github/workflows/ci.yml` runs typecheck and tests on pull requests and pushes to `main`.

`normalizeSinglePageCrawlEvidence` measures UTF-8 size with Node `Buffer.from` in `src/crawler/evidence-domain.ts`. That function is on the D1 persist path. A Workers compatibility date of `2026-10-22` enables Node.js `Buffer` by default. The pinned Miniflare `4.20260730.0` is older than that default, and the existing D1 tests already run the store functions in the Node test process, where `Buffer` exists. Reusing that function is the smallest safe option. A second evidence validator is not required.

## 2. Goal

Run one bounded public-website crawl per day at $0/month target cost, without a Mac in the loop, and without weakening DQ-006 or DQ-020.

GitHub Actions checks out the repository and runs Node. Node asks a Cloudflare Worker for eligible leads, fetches each website with the existing pinned crawler, and posts the resulting evidence back to the Worker. The Worker authenticates and is the only component that talks to D1. The Worker does not crawl public websites.

A lead that is already in production D1 can be crawled by the schedule, and the evidence row lands in that same D1 database.

## 3. Non-goals

- Cloud discovery, and any change to `npm run discover` or its local SQLite database.
- Phase 3 analysis, qualification, contact discovery, outreach, or email.
- A second crawler, a second crawl schema, or a replacement for `migrations/0001_delta_qoralis_crawl.sql`.
- Worker Cron, Cloudflare Containers, direct D1 REST from GitHub, a Cloudflare API token in the crawl workflow, queues, Durable Objects, KV, R2, a distributed lock, a scheduler table, a run-history table, a retry table, or an automatic Cloudflare deployment pipeline.
- Generic REST, a public lead API, delete or update routes, SQL from the client, JWT, or OAuth.
- A health endpoint. Workers deploy and GitHub Actions job status do not need one.

## 4. Current repository foundations

Reuse these modules by direct path. Do not re-export them from `src/crawler/index.ts`.

| Piece | Location | DQ-025 use |
| --- | --- | --- |
| Async run loop | `runBoundedSinglePageCrawlWithDependencies` in `src/crawler/run-loop.ts` | One call per cloud run. `select` and `persist` may return promises. The loop awaits `persist` and does not read the stored id. Bounds are 1 through 60. |
| Node collector | `collectSinglePageCrawlEvidence` in `src/crawler/single-page-evidence.ts` | Unchanged. It reads `id`, `version`, and a present `websiteObservation.url`, then calls `fetchCrawlPage`. |
| Pinned transport | `fetchCrawlPage` → DQ-006 → `src/crawler/node-transport.ts` | Used only by the GitHub Node process. |
| D1 store | `selectD1CrawlCandidates` and `persistD1CrawlEvidence` in `src/crawler/d1-crawl-store.ts` | Called only inside the Worker. |
| Eligibility | `CRAWL_CANDIDATE_WHERE_SQL` in `src/crawler/candidate-filter.ts` | Unchanged. Fetched evidence blocks the same current URL. A non-`CANCELLED` failure blocks that same URL. `CANCELLED` alone stays eligible. A changed URL becomes eligible. |
| Evidence check | `normalizeSinglePageCrawlEvidence` | Unchanged. `INVALID_EVIDENCE`, `LEAD_NOT_FOUND`, and `PERSISTENCE_FAILED` already have fixed messages and do not carry driver text. |
| Cloud schema | `migrations/0001_delta_qoralis_crawl.sql` | The only production migration. Tables `business_leads` and `single_page_crawl_evidence`, index `business_leads_discovery_identity_idx`, and the two append-only evidence triggers. |
| Local Node entry | `runBoundedSinglePageCrawl` in `src/crawler/run.ts` | Stays the SQLite entry. The cloud runner must not call it. |
| CI | `.github/workflows/ci.yml` | Unchanged. Node 22, `npm ci`, `npm run typecheck`, `npm test`, `contents: read`. |
| Process entry pattern | `src/cli/discover.ts` and `scripts/run-discovery.cjs` | Copy the AbortController, SIGINT, and compile-then-run script shape. |
| Config style | `src/config/env.ts` | Copy the small required-string checks. Do not call `loadConfig`. That loader requires a SQLite `DATABASE_URL`. |

`selectD1CrawlCandidates` returns a full `BusinessLead` via `leadFromRow`. `POST /internal/crawl/select` serializes those snapshots. The runner validates them as existing `BusinessLead` values and passes that array to the existing loop. `collectSinglePageCrawlEvidence` consumes them unchanged. Fields the collector does not currently read stay on the snapshot. There is no gateway lead type. `persistD1CrawlEvidence` returns `StoredSinglePageCrawlEvidence`, including the new integer id and, for a fetched row, `bodyText`. The evidence HTTP response does not return that id or that HTML.

`src/crawler/d1-crawl-store.ts` reaches `Buffer` through `evidence-domain.ts`. Its import of `database-lead-repository.ts` uses a type-only database import, so `better-sqlite3` is not on that graph. `src/crawler/index.ts` and `src/crawler/run.ts` do pull the Node fetch stack or the SQLite repository. The Worker entry must import `src/crawler/d1-crawl-store.ts` and must not import `src/crawler/index.ts`, `src/crawler/run.ts`, `src/crawler/fetch-page.ts`, `src/crawler/node-transport.ts`, or `src/db`.

## 5. Runtime architecture

```text
GitHub Actions schedule or workflow_dispatch
  → npm run crawl:cloud
    → Worker POST /internal/crawl/select
      → D1 selectD1CrawlCandidates
    → collectSinglePageCrawlEvidence
      → fetchCrawlPage
        → DQ-006
        → Node pinned HTTP/HTTPS
    → Worker POST /internal/crawl/evidence
      → D1 persistD1CrawlEvidence
```

Ownership:

- GitHub Actions owns the schedule, the Node process, and the existing pinned website transport.
- The Worker owns bearer authentication, candidate selection, and evidence persistence.
- D1 owns `business_leads` and `single_page_crawl_evidence`.

One workflow run calls `runBoundedSinglePageCrawlWithDependencies` once. `select` runs once. Each snapshot is collected and then persisted before the next snapshot. There is no application retry.

Proposed files, and no others beyond their tests, `package.json` script, and `wrangler.toml`:

- `src/crawl-gateway/worker.ts` — Worker `fetch` handler.
- `src/crawl-cloud/config.ts` — gateway URL, token, and max attempts.
- `src/crawl-cloud/gateway-client.ts` — select and persist HTTP adapters.
- `src/crawl-cloud/command.ts` — one run and a counts-only summary.
- `src/cli/crawl-cloud.ts` — process entry.
- `scripts/run-crawl-cloud.cjs` — same shape as `scripts/run-discovery.cjs`, entry `src/cli/crawl-cloud.js`.
- `.github/workflows/crawl.yml`
- `wrangler.toml`

`package.json` gains one script: `"crawl:cloud": "node scripts/run-crawl-cloud.cjs"`. Do not add Wrangler, Workers types, or a YAML parser. The Worker env is typed locally as `{ readonly DB: D1CrawlDatabase; readonly CRAWL_GATEWAY_TOKEN?: string }` using the existing `D1CrawlDatabase` type. `Request` and `Response` come from the Node 22 types already used by `npm run typecheck`.

## 6. Trust and security boundaries

`CRAWL_GATEWAY_TOKEN` is the only shared secret. It is one opaque bearer value. It is stored as a Cloudflare Worker secret and as a GitHub Actions repository secret. The header is `Authorization: Bearer <token>` with one space.

The scheduled crawler does not receive a Cloudflare global API key, account API token, D1 credentials, or Wrangler credentials. The GitHub Actions job receives `CRAWL_GATEWAY_URL` and `CRAWL_GATEWAY_TOKEN`. The API token used to deploy the Worker is a human deploy credential and is not part of crawler runtime.

Authenticate a protected route before reading its body and before calling D1. Compare the presented token with `timingSafeEqual` from `node:crypto` on equal-length UTF-8 bytes. A different length is a failed comparison. If the Worker secret is missing or empty, every protected POST is unauthorized and D1 is not called.

The Worker does not log or return the bearer token, the `Authorization` header, D1 driver messages, SQL, stack traces, HTML, DNS details, request URLs, or native error causes. `body_text` stays untrusted stored data.

`nodejs_compat` also makes `node:http` available in the Worker runtime. That availability is not permission to crawl. The Worker handler performs no `fetch` and does not import the crawl transport.

The select response is authenticated and is fetched over HTTPS only. The cloud runner does not print lead snapshots. Stdout and stderr stay counts only: no URLs, business names, lead ids, provenance, timestamps, HTML, authorization headers, token values, or raw Worker responses.

## 7. Worker gateway contract

Routes, exact path, no query string, no trailing slash:

- `POST /internal/crawl/select`
- `POST /internal/crawl/evidence`

Any other path, or either path with a query string, returns 404. Either path with a method other than `POST` returns 405. Path and method checks do not read the body and do not call D1. The two POST routes then require a valid bearer token before `request.json()`.

Request `Content-Type` is `application/json` or `application/json; charset=utf-8`. A body larger than 3 MiB is rejected before D1. That cap covers one evidence document whose HTML is already limited to `MAX_CRAWL_BODY_BYTES` (1,048,576) plus JSON encoding. Every response is `content-type: application/json; charset=utf-8` and `cache-control: no-store`.

Select body, exact key:

```json
{ "maxAttempts": 10 }
```

`maxAttempts` is a safe integer from 1 through 60, the same bounds `assertValidRequest` enforces in `run-loop.ts`. The Worker then calls `selectD1CrawlCandidates(env.DB, maxAttempts)`.

Select success is 200. The body has exactly one key, `candidates`. The array is the `readonly BusinessLead[]` returned by `selectD1CrawlCandidates()`, serialized as JSON. The Worker does not rename, drop, or invent fields. Zero rows is `{ "candidates": [] }`.

A manual snapshot has the fields `leadFromRow` returns for `sourceKind: "manual"`: `id`, `businessName`, `sourceKind`, `sourceReference`, `status`, `websiteObservation`, `createdAt`, `updatedAt`, and `version`. A discovered snapshot is that set plus `sourceProvider`, with `sourceKind: "discovery"`. `websiteObservation` is the existing domain value. This selector's SQL returns a present URL, so that value is `{ "presence": "present", "url": "<canonical url>" }`.

```json
{
  "candidates": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "businessName": "Example Business",
      "sourceKind": "manual",
      "sourceReference": "ref-1",
      "status": "recorded",
      "websiteObservation": {
        "presence": "present",
        "url": "https://example.com/"
      },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z",
      "version": 1
    }
  ]
}
```

That object is the existing `BusinessLead` snapshot. It is not a new gateway type.

Evidence body is one JSON object passed unchanged to `persistD1CrawlEvidence(env.DB, body)`. The existing normalizer is the only evidence check. Success is 200 and exactly `{ "persisted": true }`. The response has no stored id and no HTML. The run loop does not read the persist return value, so the id is not part of the HTTP contract.

Fixed responses, with no `message` field:

| Status | Body | When |
| --- | --- | --- |
| 401 | `{"error":"unauthorized"}` | Missing header, wrong scheme, wrong token, or unset Worker secret, on a protected POST |
| 404 | `{"error":"not_found"}` | Unknown path |
| 405 | `{"error":"method_not_allowed"}` | Known path, method other than POST |
| 400 | `{"error":"invalid_request"}` | Bad content type, bad JSON, extra keys, `maxAttempts` outside 1..60, `CrawlEvidencePersistenceError` `INVALID_EVIDENCE` or `LEAD_NOT_FOUND` |
| 500 | `{"error":"internal_error"}` | `CrawlRunError` `SELECTION_FAILED`, `LeadPersistenceError`, `PERSISTENCE_FAILED`, or any other thrown value |
| 200 | select or evidence success body | Store call succeeded |

`LEAD_NOT_FOUND` is domain input and stays 400. Driver and unexpected failures stay 500. Catch at the handler edge. Do not copy `error.message`.

`wrangler.toml`:

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

`compatibility_date` `2026-10-22` enables Node `Buffer` by default. The explicit `nodejs_compat` flag records that choice and covers an older Wrangler. Do not set `no_nodejs_compat` or `no_nodejs_compat_v2`. If the human's Wrangler rejects the flag as redundant for this date, keep the date and remove the flag. Do not edit `utf8ByteLength`. There is no cron trigger in this file. The human replaces `REPLACE_BEFORE_DEPLOY` with the id printed by D1 creation before the first deploy. The Builder does not invent a database id.

## 8. GitHub Node runner

`npm run crawl:cloud` is the only cloud entry.

Configuration, read from the environment and rejected before any HTTP call:

- `CRAWL_GATEWAY_URL`: required absolute `https` origin. No username, password, query, hash, or path other than empty or `/`.
- `CRAWL_GATEWAY_TOKEN`: required, nonempty, and free of whitespace and control characters. Same character rule as the Geoapify key check in `src/config/env.ts`.
- `CRAWL_MAX_ATTEMPTS`: optional. Unset means 10. A present value must be a safe integer from 1 through 60.

Invalid configuration writes `Crawl gateway configuration is invalid.` to stderr, writes nothing that contains the URL or token, and exits 1.

The process entry creates one `AbortController`, registers SIGINT the way `src/cli/discover.ts` does, and passes that signal into the command. The command calls `runBoundedSinglePageCrawlWithDependencies` once with:

- `select`: `POST` `{ "maxAttempts" }` to `{origin}/internal/crawl/select` with the bearer header and the abort signal. Require 200 and a body whose only key is `candidates`. Validate each element as an existing `BusinessLead` snapshot and pass that array to the run loop.
- `collect`: `collectSinglePageCrawlEvidence`, unchanged.
- `persist`: `POST` the evidence object to `{origin}/internal/crawl/evidence`. Require 200 and exact `{ "persisted": true }`.

The select decoder validates the returned objects as existing `BusinessLead` snapshots before the run loop sees them. A manual object has exactly `id`, `businessName`, `sourceKind`, `sourceReference`, `status`, `websiteObservation`, `createdAt`, `updatedAt`, and `version`, with `sourceKind` equal to `"manual"`. A discovered object has those fields plus `sourceProvider`, with `sourceKind` equal to `"discovery"`. `id` passes `isBusinessLeadId`. `version` is a safe integer greater than or equal to 1. `status` is `recorded`, `reviewing`, or `archived`. `websiteObservation` is `{ presence: "unknown" }`, `{ presence: "missing" }`, or `{ presence: "present", url }` whose `url` is already canonical under `normalizeWebsiteUrl`. `createdAt` and `updatedAt` are the canonical UTC timestamps already stored on leads. A discovery `sourceProvider` matches the existing provider rule. The decoder supplies no missing field. The validated array is the `readonly BusinessLead[]` passed to `runBoundedSinglePageCrawlWithDependencies`. Do not add a `CrawlCandidate` type, a run-loop type parameter, or a collector signature change. Do not add a serialization library. The runner does not print these snapshots.

A non-2xx gateway response, invalid JSON, or an unexpected JSON shape throws inside the adapter. The thrown message is the fixed sentence `Crawl gateway request failed.` The response body is not copied. `fetch` is called once per gateway operation. There is no HTTP retry.

The persist adapter returns the evidence object it posted. `run-loop.ts` only awaits that promise. The adapter does not invent a D1 row id. A type assertion to `StoredSinglePageCrawlEvidence` is allowed at that return because the loop discards it. Tests cover the HTTP body, not a fabricated id.

Stdout on a result returned by the loop is counts and the stop enum only:

```text
status: completed
reason: candidates_exhausted
selected: 0
attempted: 0
fetched: 0
failed: 0
persisted: 0
```

`reason` is `budget_exhausted`, `candidates_exhausted`, or `cancelled`. Exit 0 when `stop.status` is `completed`. Exit 130 when the loop returns `cancelled`, with stderr `Crawl run was cancelled.` Any thrown failure, including a gateway failure, exits 1 with stderr `Crawl run failed.` If the signal is already aborted when that throw is observed, exit 130 with the cancellation sentence instead of the failure sentence. Do not append `error.message`.

The runner does not open SQLite, import `src/db`, call `loadConfig`, read `DATABASE_URL`, talk to D1, execute SQL, run discovery, analyze pages, qualify leads, discover contacts, or send outreach.

## 9. GitHub Actions workflow

Create `.github/workflows/crawl.yml`. Do not edit `.github/workflows/ci.yml`.

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

GitHub's current `on.schedule` syntax accepts an IANA `timezone` on the cron entry. The schedule is `17 6 * * *` with `timezone: "Europe/Warsaw"`, which is 06:17 Europe/Warsaw every day. GitHub warns that a schedule at the start of an hour can be delayed or dropped, so the minute is 17. `Europe/Warsaw` handles DST. This file does not encode a winter or summer UTC offset and does not add a second cron. Schedules run from the default branch.

`concurrency` allows one executing crawl. `cancel-in-progress: false` leaves the running job alone. GitHub may drop an older queued run in the same group before it starts. That queue behavior is enough. Do not add a D1 lock.

`CRAWL_MAX_ATTEMPTS` is a plain literal, not a secret. The two secrets are injected as environment variables on the crawl step. The workflow has no Cloudflare API token, no Docker, and no container job.

## 10. D1 deployment and state

One Cloudflare D1 database, name `delta-qoralis-crawl`, binding `DB`. Apply `migrations/0001_delta_qoralis_crawl.sql` as-is. Do not add a replacement migration. Do not add `audit_events`, `lead_contact_suppressions`, `schema_migrations`, a scheduler table, a run table, a retry table, or a lock table. Inspection of the loop, the store, and the eligibility predicate found no need for them. One GitHub concurrency group already keeps a single crawl running.

The Worker does not apply migrations. If the tables are absent, the store throws and the handler returns `internal_error`.

Eligibility remains the existing predicate. This design does not change which leads are selected or which evidence blocks them.

`npm run discover` still persists to local SQLite. DQ-025 does not copy those rows to D1 and does not chain discovery into the crawl. The production path is: a lead already present in production D1, then the GitHub Actions crawl, then evidence in production D1.

## 11. Error and failure semantics

One workflow invocation is one bounded run. Do not add an application retry helper, an HTTP retry, a Worker retry, a queue, or a retry table.

Gateway failures fail that run with exit 1 and the fixed stderr sentence. A later schedule is a new run. It sees whatever evidence was committed. A persisted `fetched` row or a persisted non-`CANCELLED` failure blocks that same URL. A run that dies before persist leaves the lead eligible. `CANCELLED` evidence is persisted by the existing loop and does not block the URL.

Cancellation still persists evidence the collector already returned, then stops. The cloud signal is the same `AbortSignal` the loop, the collector, and the gateway `fetch` already accept.

Worker 400 and 500 bodies stay the fixed JSON above. The Node adapters do not parse `error` in order to print it.

## 12. Testing strategy

Add tests next to the existing Node test runner. No live Worker, no live website, and no new test framework.

Worker gateway, handler invoked in process with a fake `D1CrawlDatabase` and a token binding:

- Missing token is 401, and `prepare` is not called.
- Wrong token is 401, and `prepare` is not called.
- Valid token is accepted.
- Auth runs before protected processing: a missing token does not read a body that would otherwise fail, and does not call D1.
- Unknown route is 404.
- Wrong method on a known route is 405.
- Malformed select is 400.
- Select success returns the complete `BusinessLead` snapshots from `selectD1CrawlCandidates()`, including a distinctive business name, provenance, status, website observation, and timestamps. The handler does not log that body.
- Malformed evidence is 400.
- Evidence success returns exactly `{ "persisted": true }` and does not return HTML or an id.
- Selection failure returns exactly `{"error":"internal_error"}`.
- Persistence failure returns exactly `{"error":"internal_error"}`.
- A distinctive token, a distinctive D1 error string, and distinctive HTML are absent from the response.

Worker plus D1, the existing Miniflare pattern in `tests/integration/d1-crawl-store.test.ts`: `modules: true`, `d1Persist: false`, binding `DB`, apply `migrations/0001_delta_qoralis_crawl.sql`, no outbound network. Call the real store through the handler, or call the store and the handler against that database. The store code continues to run in the Node test process, which already provides `Buffer` for this Miniflare version.

- The migration applies.
- Select sees eligible leads.
- Select respects `maxAttempts`.
- Fetched evidence blocks the same URL.
- A non-`CANCELLED` failed evidence row blocks the same URL.
- `CANCELLED` alone stays eligible.
- A changed URL is eligible.
- The evidence route writes fetched and failed evidence.
- Update and delete of `single_page_crawl_evidence` still fail, so the append-only triggers remain.

GitHub runner and HTTP adapters, with an injected `fetch` and an injected collector:

- Valid select JSON is a complete existing `BusinessLead` snapshot, and that same snapshot is what the run loop receives. A body that omits a `BusinessLead` field is rejected. The decoder adds no synthetic field.
- A malformed gateway response is rejected.
- A non-2xx select fails with the fixed sentence and does not include the response body.
- The evidence POST sends the fetched or failed object with the existing exact keys.
- A non-2xx persist fails with the fixed sentence.
- Select, then collect, then persist, stays one sequential loop.
- The token is absent from thrown messages, stdout, and stderr.
- The summary is the status, reason, and five counters.
- An aborted signal preserves the existing cancellation result.

Workflow check: one Node test reads `.github/workflows/crawl.yml` as text. Assert the schedule cron is `17 6 * * *`, `timezone` is `Europe/Warsaw`, and the file contains `workflow_dispatch`, `contents: read`, `concurrency`, `cancel-in-progress: false`, `npm ci`, and `npm run crawl:cloud`. Assert the file does not contain `CLOUDFLARE_API_TOKEN`, `docker`, or `container`. Do not add a YAML library.

`npm test` and `npm run typecheck` stay the validation commands. CI picks up the new tests without a workflow edit.

## 13. Deployment procedure

Deployment is manual and human-controlled. There is no GitHub job that runs Wrangler.

1. `wrangler login` as the human operator.
2. `wrangler d1 create delta-qoralis-crawl`.
3. Replace `REPLACE_BEFORE_DEPLOY` in `wrangler.toml` with the printed database id.
4. Apply `migrations/0001_delta_qoralis_crawl.sql` to that database.
5. Confirm the D1 binding name is `DB`.
6. `wrangler secret put CRAWL_GATEWAY_TOKEN` with the same value that will be stored in GitHub.
7. `wrangler deploy`.
8. In the GitHub repository settings, set secrets `CRAWL_GATEWAY_URL` (the deployed `https` origin) and `CRAWL_GATEWAY_TOKEN`.
9. Run the Crawl workflow once with `workflow_dispatch` and read the counts-only log.

Do not put the deploy token in the repository or in the crawl workflow.

## 14. Free-tier constraints

The target is GitHub Actions Free, Cloudflare Workers Free, and Cloudflare D1 Free. The design uses no Containers, Workers Paid requirement, Render, Railway, Fly.io, VPS, Koyeb, or paid scheduler.

It stays inside those free tiers only while this usage stays inside each provider's included limits: one short daily job, one select request, and at most `CRAWL_MAX_ATTEMPTS` evidence writes. The workflow default is 10, and the code ceiling is 60. Each fetched body is already capped at 1,048,576 bytes. Do not copy prices or quota integers into runtime code.

A public GitHub repository can also disable a scheduled workflow after prolonged inactivity. That is an operator check, not a code path.

## 15. Completion criteria

Merging the implementation does not complete Phase 2. Phase 2 — Website Crawling is completed only after all of the following have actually succeeded:

1. The production D1 database exists.
2. `migrations/0001_delta_qoralis_crawl.sql` is applied to it.
3. The Worker gateway is deployed on Workers Free.
4. The Worker secret is configured.
5. The GitHub Actions secret and URL are configured.
6. A manual `workflow_dispatch` production run succeeds.
7. The website crawl is performed by the existing Node DQ-020 transport.
8. The evidence rows are in production D1.
9. A scheduled run can execute without the Mac.
10. No paid Container or paid service was required.

After those ten are true, Phase 2 — Website Crawling is COMPLETED and Phase 3 — Website Analysis is NEXT.

## 16. Future work explicitly excluded

Do not implement these in DQ-025:

- Moving discovery from local SQLite to D1, or an automatic discover-then-crawl pipeline.
- Website analysis, qualification, contact discovery, outreach, and email.
- A public API, lead update or delete, audit writes from the crawl, or suppression checks inside selection.
- Retry, run history, monitoring, and an automatic Cloudflare deploy.
- Solving Worker HTTPS pinning. The Node transport remains the website client.

Later documentation, after this spec is approved and during implementation, should be updated to replace the obsolete blocked title and to describe this gateway. Do not edit them as part of the architecture task:

- `docs/PLAN.md`
- `docs/BACKLOG.md`
- `docs/HANDOFF.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY.md`
- `docs/DATA_MODEL.md`
- `docs/decisions/0016-github-actions-crawl-runner.md` (new decision; decision 0015 stays as the DQ-024 record)
- `docs/PRODUCT.md` (it still says DQ-024 has not started, which is already behind HEAD)

Leave `README.md` unchanged. This design does not require a README edit.
