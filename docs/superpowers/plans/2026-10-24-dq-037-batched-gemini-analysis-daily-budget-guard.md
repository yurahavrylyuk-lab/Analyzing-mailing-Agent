# DQ-037 Batched Gemini Analysis and Daily Budget Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Batch up to five website analyses into each Gemini request while enforcing a fixed 50-website-per-UTC-day admission cap and a configurable per-day Gemini HTTP request cap in authoritative D1 state.

**Architecture:** The production pipeline selects eligible evidence in the existing `attempted_at ASC, id ASC` order, admits each new `(utc_date, evidence_id)` at most once per UTC day, and reserves one Gemini request unit inside a single D1 `batch()` before every outbound Interactions `fetch`. `analyzeWebsitesWithGemini` sends at most five websites per request, validates each website by `evidenceId`, `leadId`, and `leadVersion`, and the pipeline persists the valid siblings from a partial batch. The one-website `runWebsiteAnalysis` path stays unchanged and is no longer the production pipeline's caller.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare D1/SQLite SQL, Gemini Interactions REST API, existing repository test runner.

**Spec:** `docs/superpowers/specs/2026-10-24-dq-037-batched-gemini-analysis-daily-budget-guard-design.md`

## Global Constraints

Every task includes this section.

- Delta Qoralis is the company. Analyzing and Mailing Agent is the agent. Do not describe the agent as Delta Qoralis. The Worker name `delta-qoralis-crawl-gateway` stays. Do not rename it and do not create a second Worker.
- Implement only the approved spec and this plan. Do not edit the spec, this plan, `docs/PLAN.md`, or `docs/BACKLOG.md`. Do not start DQ-038 or DQ-039.
- Builder execution creates `feature/dq-037-batched-gemini-analysis-daily-budget-guard` from this plan commit on `design/dq-037-batched-gemini-analysis-daily-budget-guard`. Do not implement on `main` or on the design branch.
- Do not commit, push, or open a pull request during Builder execution. Each task's commit command is the review boundary. Leave the work uncommitted until the Analyst records APPROVED. Do not squash, rebase, or commit unrelated refactors.
- Batch size is the fixed constant `GEMINI_WEBSITE_BATCH_SIZE = 5`. It is not configurable. One Gemini request never contains 50 websites. A batch may contain 1 through 5.
- The website cap is the fixed constant `DAILY_WEBSITE_CAP = 50` unique evidence IDs per UTC date. It is not configurable. The reset boundary is 00:00 UTC. The day key is `clock().toISOString().slice(0, 10)`. Do not use local `getFullYear`, `getMonth`, or `getDate`. There is no reset cron. Yesterday's rows are not deleted or zeroed.
- Admission identity is `(utc_date, evidence_id)`. The first committed admission of that pair is website usage +1. A later same-day invocation, model fallback, and the 90-second retry are website usage +0. A new UTC date and a new invocation of still-eligible evidence is website usage +1. A website that never enters a reserved batch consumes no slot.
- Every actual outbound Gemini HTTP request is request usage +1, including the first request, fallback, the 90-second retry, fallback during retry, and a later same-day re-attempt. Reserve before `fetch`. If that reservation does not commit, do not `fetch`. A committed unit is not refunded when `fetch` throws, times out, returns an HTTP error, or returns an unusable body.
- `GEMINI_DAILY_REQUEST_LIMIT` is a canonical base-10 integer from 1 through 10000 inclusive, with no sign, no leading zero, no decimal, no exponent, and no surrounding whitespace. There is no default. It is not a secret, not a schema column, and not a `CHECK`. 10000 is only the parse bound. Missing or invalid configuration fails closed.
- One migration, `migrations/0004_website_analysis_daily_usage.sql`, creates `website_analysis_daily_usage` and `website_analysis_daily_admissions` and the two triggers in Reservation algorithm. Do not add a second migration. The admission table has only `utc_date` and `evidence_id`. After every committed reservation, `websites_admitted` equals `COUNT(*)` from the admission table for that date.
- Quota is spent only by D1 `batch()`. Do not `SELECT` the counters and then `UPDATE` them from application memory. A failed statement rolls back every statement in that `batch()`, including admission inserts and both aggregate increments. Do not use a `WHERE` that succeeds while changing 0 rows.
- Selection order stays `attempted_at ASC, id ASC`. The evidence read uses `LIMIT maxItems`. It does not use the remaining website slots as `LIMIT`. `maxItems === 0` selects nothing.
- Candidate walk, one batch at a time: include an already-admitted candidate with zero website charge; include a new candidate only while remaining website slots cover every new ID in that batch; stop at size 5, at the remaining invocation room, or at the first new candidate that does not fit. Do not skip a new candidate that does not fit in order to reach a later already-admitted candidate. Do not charge or send the candidates that did not fit.
- Usage 49/50 and the next five candidates all new: the batch is only the first. The other four are not reserved, not sent, and not `selected`. Usage 49/50 with A and B already admitted and then new C, D, and E: the batch is A, B, and C. D and E stay untouched. Usage 50/50 and the next candidate already admitted, with a request unit left: that candidate may be analyzed, website usage +0, request usage +1. Usage 50/50 and the next candidate new: no batch, no `fetch`, no 51st admission.
- When request units remain and website slots are exhausted, still read up to `maxItems` eligible rows so an already-admitted row at the front can enter. When no request unit remains, do not select and do not `fetch`, even if the next website would need zero additional website slots. Stop with `request_cap`.
- Map batch output by `evidenceId`, `leadId`, and `leadVersion`, using the same strict types as `validateWebsiteAnalysis`. Do not coerce and do not assign by array position. Missing, duplicate, unexpected, or mismatched output is never persisted under another website. Four valid items and one invalid item: the four may persist; do not send the batch again because of that one sibling.
- Preserve the DQ-032 transport except where this slice changes it: `POST https://generativelanguage.googleapis.com/v1/interactions`, headers `content-type: application/json` and `x-goog-api-key`, `store: false`, `stream: false`, abort at 30_000 ms, `GEMINI_MODELS` in its current order, no Gemini SDK. Fallback only after a thrown `fetch` or abort, and only after the next request unit commits. A completed status outside 200–299 and an unparseable completed body do not try another model. Per-website validation failure does not try another model and does not defer the batch.
- `attemptedModels` contains only models whose HTTP request actually ran, successful model last. A shared batch response uses one responding model and one attempted-model list for that call. A retry call starts a new list. `retried` is true only when a retry-round Gemini HTTP request was actually sent.
- On a successful pipeline return, `selected` is the number of websites that entered a reserved Gemini batch in this invocation, including a same-day re-attempt that added no website slot. `selected = succeeded + failed`, `persisted = succeeded`, and `0 <= retried <= selected`. Quota-blocked untouched candidates are not `selected` and not `failed`. `selected` is not the daily admission count.
- `maxItems` stays an integer from 0 through 50 and is only the invocation bound. Daily quotas are separate. `maxItems === 0` validates the Gemini key and `GEMINI_DAILY_REQUEST_LIMIT`, reads the current UTC usage row, and must not select evidence, write admissions, alter daily usage, call Gemini, or persist an analysis. Its counters are 0. Its `stoppedReason` is `max_items`.
- An in-flight retry whose reservation `batch()` runs after 00:00 UTC inserts no admission row. It charges website +0 and request +1 on the new UTC date. A later new invocation of the same still-eligible evidence on that new date charges website +1 and request +1. These are different paths. The retry must not insert the evidence ID under the new date.
- Reservation exhaustion is a failed quota `batch()` or a next batch that cannot be composed. It is not a Gemini error and it is not `BUDGET_FAILED`. A corrupt usage read, a missing table, or a non-constraint D1 failure is `BUDGET_FAILED` with message `D1 website analysis budget ledger failed.` The Worker maps that throw to HTTP 500 `{ "error": "internal_error" }` and sends no further Gemini request. Analyses and units already committed stay committed.
- If a reservation `batch()` fails, do not `fetch` for that proposal. Re-read. A second reservation is allowed only when at least one evidence ID from that proposal is now already admitted, so the composition changed. If the same composition still cannot fit the website cap or the request cap, stop. Do not shrink that failed proposal and reserve the subset.
- `stoppedReason` precedence is `max_items`, then `request_cap`, then `website_cap`, then `no_evidence`. `websiteLimit` in the response is the literal 50.
- Keep `POST /internal/analysis/run`, `ANALYSIS_GATEWAY_TOKEN`, crawl routes, `CRAWL_GATEWAY_TOKEN`, and the body `{ "maxItems": N }`. The Worker does not call `loadConfig()` and does not consult `WEBSITE_ANALYSIS_PROVIDER`. Invalid `maxItems` stays HTTP 400 before configuration is checked. Invalid key or limit is HTTP 500 with the fixed body, including when `maxItems` is 0. Do not echo the key, the limit, SQL, prompts, or analysis content.
- Do not add cron, a scheduled Worker event, a GitHub Actions analysis workflow, automatic post-crawl analysis, run history, request history, failure history, token, cost, or latency ledgers, a monitoring dashboard, Durable Objects, KV, R2, queues, Redis, a claim, a lease, OpenRouter, Groq, Cloudflare Workers AI, another provider, qualification, contact discovery, DNC expansion, outreach, mailing, CRM, website generation, payments, or subscriptions. Do not add a generic budget engine, quota framework, provider registry, factory, or dependency-injection container.
- Tests use `node:test` and `node:assert/strict`. No real Gemini, no production D1, and no outbound network. Do not add an npm script. This shell is zsh, so targeted commands use `exit_code`, not `status`. `.test-build/` is gitignored. Do not weaken an existing assertion to make it pass. Retarget an assertion only when this plan names that test and the approved design changed the behavior.
- Do not apply the migration to production, do not set Worker configuration, do not deploy, and do not send a real Gemini request. The activation checklist at the end of this plan is not a Builder step.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one has the named test in the owning task.

1. **One website slot left in front of five new candidates.** Usage 49/50 and the next five eligible rows all new: only the first is reserved and sent. The other four are not admitted, not fetched, and not counted in `selected` or `failed`. Test: `usage 49 of 50 admits only the first of five new candidates` in Task 6.
2. **Already-admitted rows before the last slot, without skipping.** Usage 49/50 and the read order is admitted A, admitted B, then new C, D, and E: analyze A, B, and C only. The evidence read uses `LIMIT maxItems`, not the one remaining slot, so A and B are visible. The walk stops at D and does not skip D to reach a later admitted row. Test: `usage 49 of 50 keeps admitted A and B and the next new candidate only` in Task 6.
3. **Four valid siblings and one invalid sibling.** A completed envelope with four matches and one missing, duplicate, mismatched, or malformed match persists the four and fails the one. The batch is not sent again. Test: `four valid analyses persist when one sibling is invalid` in Task 3.
4. **Midnight retry is not a new admission.** A retry reservation after 00:00 UTC charges the new date's request counter by 1, inserts no new-date admission, and leaves yesterday's `websites_admitted` unchanged. A separate later invocation of that same evidence on the new date inserts one new-date admission. Test: `an in-flight retry after midnight charges only the new day's request` in Task 5, with the new-invocation half asserted by `a new invocation after midnight admits the same evidence once` in Task 6.
5. **A lost reservation does not fetch and does not double-count.** Two overlapping reservations of the same new evidence ID leave one admission row and increase `websites_admitted` once. The losing `batch()` rolls back its request increment. The provider performs no `fetch` when `reserveNextRequest` returns false. Test: `overlapping reservations of one evidence id admit it once` in Task 2, and `request exhaustion before fallback performs no further fetch` in Task 4.

## File structure

Create:

- `migrations/0004_website_analysis_daily_usage.sql` — both ledger tables and the two admission triggers.
- `src/website-analysis/daily-usage.ts` — the UTC date helper, the usage read, the admission-identity read, the first-request reservation, and the request-only reservation. This file is the SQL for this ledger. It is not a quota framework.
- `tests/integration/website-analysis-daily-usage.test.ts` — Miniflare coverage of migration 0004 and the reservation functions.
- `tests/unit/gemini-website-batch.test.ts` — batch contract, identity mapping, partial success, and request-reservation seams.

Modify:

- `src/config/errors.ts` — two configuration codes for the request limit.
- `src/config/env.ts` — required `dailyRequestLimit` on the Gemini config, parsed only when the provider is `gemini`.
- `.env.example` — one empty non-secret `GEMINI_DAILY_REQUEST_LIMIT=` line.
- `src/website-analysis/providers/gemini/prompt.ts` — batch prompt and batch response schema. The existing single-website prompt and schema stay byte-for-byte.
- `src/website-analysis/providers/gemini/gemini-provider.ts` — `analyzeWebsitesWithGemini`. `analyzeWebsiteWithGemini` stays behaviorally unchanged and ignores `dailyRequestLimit`.
- `src/website-analysis/providers/gemini/index.ts` — export the batch function and its types.
- `src/website-analysis/index.ts` — re-export those batch symbols beside the existing Gemini exports.
- `src/website-analysis/pipeline-errors.ts` — `INVALID_CONFIGURATION` and `BUDGET_FAILED`.
- `src/website-analysis/d1-analysis-pipeline.ts` — budget-aware selection, batch execution, one retry round, and the budget summary. The database type gains `batch`.
- `src/crawl-gateway/worker.ts` — parse `GEMINI_DAILY_REQUEST_LIMIT` and copy `budget` onto HTTP 200.
- `tests/unit/config-env.test.ts` — limit parsing. Existing disabled-provider tests stay, and they do not start requiring the limit.
- `tests/unit/crawl-gateway-analysis.test.ts` — limit validation now, budget body in Task 7. Crawl authorization tests stay.
- `tests/unit/gemini-website-analysis.test.ts` — add `dailyRequestLimit` to the existing config helper so the required field typechecks. Do not change single-website fallback assertions.
- `tests/unit/website-analysis-run.test.ts` — same config-helper update. `runWebsiteAnalysis` behavior stays.
- `tests/integration/d1-website-analysis-pipeline.test.ts` — apply migration 0004, replace the `runWebsiteAnalysis` seam with the batch seam, and cover the quota walk. Do not delete coverage of selection order, persistence failure, or `maxItems` bounds.

Do not modify `wrangler.toml`, `package.json`, `package-lock.json`, `tsconfig.json`, `docs/PLAN.md`, `docs/BACKLOG.md`, or `.github/`.

## Test command

Targeted command, from the repository root. Replace the test path with the file named in the task.

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/config-env.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

Relevant regression for a task is that same command with every test file listed in the task's GREEN and regression steps. Full regression is the existing runner, which compiles with `tsc` and then runs every compiled `*.test.js`:

```bash
node scripts/run-tests.cjs
```

Typecheck is the existing script:

```bash
npm run typecheck
```

`package.json` already defines `test` and `typecheck`. Do not add a script.

## Reservation algorithm

Task 2 creates this SQL. Tasks 4, 5, and 6 call it. Do not invent a second write path.

`migrations/0004_website_analysis_daily_usage.sql`:

```sql
CREATE TABLE website_analysis_daily_usage (
  utc_date TEXT PRIMARY KEY CHECK (
    utc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(utc_date) = utc_date
  ),
  websites_admitted INTEGER NOT NULL CHECK (
    typeof(websites_admitted) = 'integer'
    AND websites_admitted >= 0
    AND websites_admitted <= 50
  ),
  gemini_requests_used INTEGER NOT NULL CHECK (
    typeof(gemini_requests_used) = 'integer'
    AND gemini_requests_used >= 0
  )
);

CREATE TABLE website_analysis_daily_admissions (
  utc_date TEXT NOT NULL CHECK (
    utc_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(utc_date) = utc_date
  ),
  evidence_id INTEGER NOT NULL CHECK (
    typeof(evidence_id) = 'integer' AND evidence_id > 0
  ),
  PRIMARY KEY (utc_date, evidence_id)
);

CREATE TRIGGER website_analysis_daily_admissions_cap
BEFORE INSERT ON website_analysis_daily_admissions
FOR EACH ROW
BEGIN
  INSERT INTO website_analysis_daily_usage (
    utc_date, websites_admitted, gemini_requests_used
  ) VALUES (NEW.utc_date, 0, 0)
  ON CONFLICT (utc_date) DO NOTHING;
  SELECT RAISE(ABORT, 'daily website cap')
  WHERE (
    SELECT COUNT(*)
    FROM website_analysis_daily_admissions
    WHERE utc_date = NEW.utc_date
  ) >= 50;
END;

CREATE TRIGGER website_analysis_daily_admissions_count
AFTER INSERT ON website_analysis_daily_admissions
FOR EACH ROW
BEGIN
  UPDATE website_analysis_daily_usage
  SET websites_admitted = websites_admitted + 1
  WHERE utc_date = NEW.utc_date;
END;
```

The `BEFORE INSERT` count does not include `NEW`, so the 50th insert sees 49 and commits, and the 51st sees 50 and aborts. An earlier insert in the same `batch()` is visible to the next trigger execution. Aborting the second insert rolls the whole `batch()` back, including the first insert from that proposal.

`src/website-analysis/daily-usage.ts` exports:

```ts
export const DAILY_WEBSITE_CAP = 50;

export type WebsiteAnalysisDailyUsage = Readonly<{
  websitesAdmitted: number;
  geminiRequestsUsed: number;
}>;

export function utcAnalysisDate(clock: () => Date): string;

export async function readWebsiteAnalysisDailyUsage(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
): Promise<WebsiteAnalysisDailyUsage>;

export async function readWebsiteAnalysisAdmissions(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  evidenceIds: readonly number[],
): Promise<ReadonlySet<number>>;

export async function reserveWebsiteAnalysisBatch(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  newEvidenceIds: readonly number[],
  requestLimit: number,
): Promise<boolean>;

export async function reserveGeminiRequest(
  database: D1WebsiteAnalysisPipelineDatabase,
  utcDate: string,
  requestLimit: number,
): Promise<boolean>;
```

`utcAnalysisDate` returns `clock().toISOString().slice(0, 10)`.

`readWebsiteAnalysisDailyUsage` runs:

```sql
SELECT websites_admitted, gemini_requests_used
FROM website_analysis_daily_usage
WHERE utc_date = ?
```

No row returns `{ websitesAdmitted: 0, geminiRequestsUsed: 0 }`. Both values must already be numbers. A string, boolean, null, or non-integer throws `D1WebsiteAnalysisPipelineError` with code `BUDGET_FAILED`. Do not coerce and do not repair the row.

`readWebsiteAnalysisAdmissions` runs one query for the candidate IDs. `maxItems` is at most 50, so one bound `IN` list is enough. An empty ID list returns an empty set and prepares nothing. This read spends nothing.

`reserveWebsiteAnalysisBatch` is the reservation for the first HTTP request of a batch. It calls `database.batch` with these statements, in this order:

1. Always:

```sql
INSERT INTO website_analysis_daily_usage (
  utc_date, websites_admitted, gemini_requests_used
) VALUES (?, 0, 0)
ON CONFLICT (utc_date) DO NOTHING
```

2. For each new evidence ID, one statement, with no `OR IGNORE`:

```sql
INSERT INTO website_analysis_daily_admissions (utc_date, evidence_id)
VALUES (?, ?)
```

Skip this step when `newEvidenceIds` is empty. An empty list still runs steps 1 and 3.

3. Always, with `?1` bound to `requestLimit` and `?2` bound to `utcDate`:

```sql
UPDATE website_analysis_daily_usage
SET gemini_requests_used = CASE
  WHEN gemini_requests_used + 1 <= ?1 THEN gemini_requests_used + 1
  ELSE -1
END
WHERE utc_date = ?2
```

`reserveGeminiRequest` is the same `batch()` with only steps 1 and 3. Fallback and the 90-second retry call this function. They do not insert admission rows. A new UTC date created here keeps `websites_admitted` at 0 and then increments only `gemini_requests_used`.

Both functions return `true` only when `batch()` resolves. They return `false` when `batch()` rejects with a message containing `daily website cap`, `CHECK constraint failed`, or `UNIQUE constraint failed`. That `false` is exhaustion: the caller does not `fetch`. Any other rejection, including `no such table`, is rethrown as `BUDGET_FAILED`. Lock the three phrases to the messages Miniflare actually produces; do not treat an unknown error as exhaustion.

There is no refund function. Do not export one.

## Batch composition algorithm

Task 6 uses this walk before it hands a batch to the Task 5 runner. The runner reserves and executes that batch. It does not skip ahead of a candidate the walk stopped on. Until Task 6, the current selector can still hand the runner every eligible row; Task 6 is what stops the 49/50 and 50/50 cases before reservation. Do not ask for feature approval between those two tasks.

The evidence query stays the current `SELECTION_SQL`, including `ORDER BY evidence.attempted_at ASC, evidence.id ASC` and `LIMIT ?` bound to `maxItems`. Call it only when `maxItems > 0` and `geminiRequestsUsed < dailyRequestLimit`. When the request cap is already reached, skip this query.

Then call `readWebsiteAnalysisAdmissions` for the returned IDs. That is the classification read. It can be stale. The reservation remains authoritative.

Compose one batch from the front of the not-yet-sent list:

```ts
const slotsLeft = DAILY_WEBSITE_CAP - usage.websitesAdmitted;
const batch = [];
const newEvidenceIds = [];
for (const candidate of unsent) {
  if (batch.length === GEMINI_WEBSITE_BATCH_SIZE) break;
  if (admitted.has(candidate.evidenceId)) {
    batch.push(candidate);
    continue;
  }
  if (newEvidenceIds.length >= slotsLeft) break;
  batch.push(candidate);
  newEvidenceIds.push(candidate.evidenceId);
}
```

`break` on a new candidate that does not fit. Do not `continue`. Rows after that candidate, including already-admitted rows, stay in `unsent` and are not visited for this batch. They also are not sent later in this invocation: the walk ended.

If `batch` is empty because the next candidate is new and `slotsLeft` is 0, stop with `website_cap`. If `batch` is empty because `unsent` is empty, stop with `no_evidence` unless an earlier precedence rule matches. If a request unit does not remain, do not call `reserveWebsiteAnalysisBatch` and stop with `request_cap`.

On `true`, remove that batch from `unsent` and call `analyzeWebsitesWithGemini` with `firstRequestReserved: true`. On `false`, re-read usage and admissions for the proposal. If any proposed new ID is now in the admission set, compose once more from the first candidate that was not in a committed batch and reserve that new composition once. If the composition is unchanged, or it still does not fit, stop. Do not reserve a smaller subset of the failed proposal.

Worked results the tests pin:

- Admitted A and B, then new C, D, and E, with at least 3 slots and 1 request unit: one request contains A through E. Admission inserts are C, D, and E only. `websites_admitted` +3. `gemini_requests_used` +1.
- Usage 49/50, next five all new: one request contains only the first. `websites_admitted` +1. `gemini_requests_used` +1. The other four stay out of `selected`.
- Usage 49/50, order A admitted, B admitted, C new, D new, E new: one request contains A, B, and C. `websites_admitted` +1. D and E are not selected. The `LIMIT` is `maxItems`, so the read includes A and B even though only one slot remains.
- Usage 50/50, next candidate admitted, request unit remains: the batch contains already-admitted candidates only, up to 5, and stops before the next new candidate. `websites_admitted` +0. `gemini_requests_used` +1.
- Usage 50/50, next candidate new: no reservation and no `fetch`.

A second batch in the same invocation starts only after the previous batch has finished its first-pass reservation and analysis, and only from a fresh usage read. One request unit covers one batch, not one website. Fallback requests spend extra units and can prevent the next batch.

## Midnight clock

Resolve one clock:

```ts
const clock = options?.now ?? options?.analysisRunOptions?.now ?? (() => new Date());
```

Production `fetch` passes no options, so the clock is `() => new Date()`. Sleep is `options?.analysisRunOptions?.sleep`, otherwise a private delay that waits the requested milliseconds. `storedAt` stays the existing option and is not the admission date.

The first-pass reservation date is `utcAnalysisDate(clock)` at the moment `reserveWebsiteAnalysisBatch` runs. `retryAt` is `clock().getTime()` at the transport failure plus `90_000`. After the first pass, sleep only when `retryAt - clock().getTime()` is positive. The retry then calls `reserveGeminiRequest` with `utcAnalysisDate(clock)` at that later moment and with no evidence IDs.

If the first reservation saw `2026-10-24` and the retry reservation sees `2026-10-25`, the retry inserts no `website_analysis_daily_admissions` row for either date. Yesterday's `websites_admitted` stays unchanged. The new date's usage row is created with `websites_admitted` 0 if absent, and its `gemini_requests_used` increases by 1, plus one more for each fallback `fetch` on that retry call.

A new `runD1WebsiteAnalysisPipeline` call whose clock is already `2026-10-25` is not that retry. If the evidence still has no `website_analyses` row, the composition treats it as new for `2026-10-25`, and a successful reservation inserts that date's admission and increments that date's `websites_admitted` by 1.

## Public contracts

`GeminiWebsiteAnalysisConfig` becomes:

```ts
export type GeminiWebsiteAnalysisConfig = Readonly<{
  provider: "gemini";
  apiKey: string;
  dailyRequestLimit: number;
}>;
```

`analyzeWebsiteWithGemini` keeps its signature and does not read `dailyRequestLimit`.

```ts
export const GEMINI_WEBSITE_BATCH_SIZE = 5;

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

export async function analyzeWebsitesWithGemini(
  facts: readonly WebsiteFacts[],
  config: GeminiWebsiteAnalysisConfig,
  options: GeminiWebsiteBatchOptions,
): Promise<GeminiWebsiteBatchResult>;
```

`facts.length` outside 1 through 5 throws `RangeError` before `fetch` and before `reserveNextRequest`. The pipeline never relies on that throw. The first model iteration does not call `reserveNextRequest`. Each later iteration awaits it and, on `false`, returns `requestExhausted: true` without another `fetch`. Whole-batch transport failure still throws `GeminiWebsiteAnalysisError` with code `GEMINI_TRANSPORT_UNAVAILABLE`. A completed non-2xx throws `GEMINI_HTTP_ERROR`. An unreadable body or an envelope whose own keys are not exactly `analyses`, or whose `analyses` value is not an array, throws `GEMINI_INVALID_RESPONSE`. Per-website `INVALID_ANALYSIS` and `ANALYSIS_IDENTITY_MISMATCH` stay inside `items` and do not throw.

Every `ok: true` item in one return carries the same `model` and the same `attemptedModels` contents. `attemptedModels` is a new frozen array of models for which `fetch` was called.

`D1WebsiteAnalysisPipelineResult` gains `budget`. The five counters stay first in the type and in the Worker JSON.

```ts
export type WebsiteAnalysisBudgetSummary = Readonly<{
  utcDate: string;
  websitesAdmitted: number;
  websiteLimit: 50;
  geminiRequestsUsed: number;
  geminiRequestLimit: number;
  stoppedReason: "max_items" | "no_evidence" | "website_cap" | "request_cap";
}>;

export type D1WebsiteAnalysisPipelineResult = Readonly<{
  selected: number;
  succeeded: number;
  failed: number;
  retried: number;
  persisted: number;
  budget: WebsiteAnalysisBudgetSummary;
}>;
```

`D1WebsiteAnalysisPipelineOptions` gains `now?: () => Date` and `analyzeBatch?: typeof analyzeWebsitesWithGemini`. The existing `storedAt` and `analysisRunOptions` fields stay. Production passes neither new field.

`D1WebsiteAnalysisPipelineDatabase` gains:

```ts
batch(
  statements: readonly D1WebsiteAnalysisPipelineStatement[],
): Promise<readonly unknown[]>;
```

`D1_WEBSITE_ANALYSIS_PIPELINE_ERROR_CODES` gains `"INVALID_CONFIGURATION"` and `"BUDGET_FAILED"`, with messages `D1 website analysis configuration is invalid.` and `D1 website analysis budget ledger failed.`

`WEBSITE_ANALYSIS_CONFIGURATION_ERROR_CODES` gains `"MISSING_GEMINI_DAILY_REQUEST_LIMIT"` and `"INVALID_GEMINI_DAILY_REQUEST_LIMIT"`. Messages: `GEMINI_DAILY_REQUEST_LIMIT is required when website analysis provider is gemini.` and `GEMINI_DAILY_REQUEST_LIMIT is invalid.` The Worker does not throw this class. It returns the fixed HTTP 500 body.

`GEMINI_WEBSITE_BATCH_PROMPT` is `GEMINI_WEBSITE_ANALYSIS_PROMPT` plus these lines, joined with `\n`. Do not edit the existing prompt constant:

```ts
"The input is a JSON array of website facts.",
"Return one JSON object whose only analysis collection is analyses.",
"Include one object for each supplied website.",
"Copy evidenceId, leadId, and leadVersion from that website.",
"Do not invent a website.",
"Do not merge websites.",
"Do not drop a valid website because another website cannot be analyzed.",
```

`GEMINI_BATCH_RESPONSE_FORMAT` is an object schema whose required property is `analyses`, an array whose item schema is the current `GEMINI_RESPONSE_FORMAT.schema`. Do not edit `GEMINI_RESPONSE_FORMAT`. The request `input` is the batch prompt, a newline, and `JSON.stringify` of `facts.map(selectFacts)` in admission order. Reuse the existing `selectFacts` fields. Do not add a field.

---

### Task 1: Gemini daily request-limit configuration

**Files:**
- Modify: `src/config/errors.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/crawl-gateway/worker.ts` (`CrawlGatewayEnv` and the private Gemini config parser only)
- Test: `tests/unit/config-env.test.ts`
- Test: `tests/unit/crawl-gateway-analysis.test.ts`
- Test: `tests/unit/gemini-website-analysis.test.ts`
- Test: `tests/unit/website-analysis-run.test.ts`
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `WebsiteAnalysisConfigurationError`, `GeminiWebsiteAnalysisConfig`, `geminiConfigFromEnv`, `whitespaceOrControlCharacterPattern`.
- Produces: `GeminiWebsiteAnalysisConfig` with required `dailyRequestLimit: number`. `loadConfig` fills it only when `WEBSITE_ANALYSIS_PROVIDER` is `gemini`. The Worker config object is `Object.freeze({ provider: "gemini", apiKey, dailyRequestLimit })`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/config-env.test.ts`, add these tests. Use a synthetic key such as `synthetic-gemini-key`. Do not call Gemini.

- `a missing Gemini daily request limit fails closed`: provider `gemini`, key present, `GEMINI_DAILY_REQUEST_LIMIT` absent. `loadConfig` throws `WebsiteAnalysisConfigurationError` with code `MISSING_GEMINI_DAILY_REQUEST_LIMIT` and message `GEMINI_DAILY_REQUEST_LIMIT is required when website analysis provider is gemini.`
- `an invalid Gemini daily request limit fails closed`: one assertion each for `""`, `"0"`, `"01"`, `" 1"`, `"+1"`, `"-1"`, `"1.5"`, `"1e2"`, `"10001"`, and `"abc"`. Each throws code `INVALID_GEMINI_DAILY_REQUEST_LIMIT` and message `GEMINI_DAILY_REQUEST_LIMIT is invalid.`
- `a Gemini daily request limit of 1 and 10000 is accepted`: `"1"` and `"10000"` return `websiteAnalysis` deep-equal to `{ provider: "gemini", apiKey, dailyRequestLimit: 1 }` and `{ provider: "gemini", apiKey, dailyRequestLimit: 10000 }`. The object is frozen.
- `disabled website analysis does not require the request limit`: provider absent, and provider `disabled`, both with `GEMINI_DAILY_REQUEST_LIMIT` unset and with it set to `"nope"`. Both return `{ provider: "disabled" }`.

Update the existing Gemini success deep-equal so it expects `dailyRequestLimit` once the valid fixture includes the variable. Update `geminiConfig()` in `tests/unit/gemini-website-analysis.test.ts` and `tests/unit/website-analysis-run.test.ts`, and `CONFIG` in `tests/integration/d1-website-analysis-pipeline.test.ts`, to include `dailyRequestLimit: 10`. Do not change their behavioral assertions.

In `tests/unit/crawl-gateway-analysis.test.ts`:

- `a missing or invalid Gemini daily request limit returns a fixed 500 and does not call the pipeline`: for each of absent, `""`, `"0"`, `"01"`, `"10001"`, and `" 3"`, with a valid key and `{"maxItems":0}`, the response is HTTP 500, the body is exactly `{"error":"internal_error"}`, the body does not contain the limit text or the key, and the pipeline stub is not called.
- `maxItems is validated before the Gemini daily request limit`: `{"maxItems":51}` with the limit absent is HTTP 400 `{"error":"invalid_request"}`, and the pipeline stub is not called.
- `a valid request limit is frozen onto the Gemini config`: limit `"10"`, key present, `maxItems` 0. The pipeline stub receives `config` deep-equal to `{ provider: "gemini", apiKey, dailyRequestLimit: 10 }`, `Object.isFrozen(config)` is true, and `options` is `undefined`.

Update the existing analysis-route success fixtures to set `GEMINI_DAILY_REQUEST_LIMIT` to `"10"` and expect that `dailyRequestLimit` on the forwarded config. Leave the success JSON as the five counters. Task 7 adds `budget`.

- [ ] **Step 2: Run the tests to verify the RED**

Run the targeted command for `tests/unit/config-env.test.js` and `tests/unit/crawl-gateway-analysis.test.js`.

Expected RED: `tsc` reports that `dailyRequestLimit` does not exist on `GeminiWebsiteAnalysisConfig`, or that the new error codes are not assignable. Do not accept a generic runner failure as this RED.

- [ ] **Step 3: Implement the minimum**

Add the two error codes and messages. Parse the limit with a private function separate from key parsing. Accept only a string matching `^(?:[1-9][0-9]{0,4})$` whose numeric value is from 1 through 10000. Do not trim and do not default. Call that function only after the provider is `gemini` and the key is valid. `disabled` or an absent provider returns before reading the limit.

In the Worker, add optional `GEMINI_DAILY_REQUEST_LIMIT?: string` to `CrawlGatewayEnv`. Parse it with a private function that uses the same rule. Do not import `loadConfig`. A missing or invalid key, or a missing or invalid limit, still returns the existing fixed 500 before `runPipeline`. Check order stays: unknown path 404, non-POST 405, analysis auth 401, content type and `maxItems` 400, then Gemini key and limit 500. Do not put the limit in `wrangler.toml`.

Add this line to `.env.example` beside the existing empty `GEMINI_API_KEY=` line:

```text
GEMINI_DAILY_REQUEST_LIMIT=
```

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/unit/config-env.test.js`, `tests/unit/crawl-gateway-analysis.test.js`, `tests/unit/gemini-website-analysis.test.js`, `tests/unit/website-analysis-run.test.js`, and `tests/unit/crawl-gateway-worker.test.js`.

Expected: PASS. The single-website Gemini tests still describe the unchanged adapter. Crawl routes still authorize only with `CRAWL_GATEWAY_TOKEN`.

- [ ] **Step 5: Commit**

```bash
git add src/config/errors.ts src/config/env.ts .env.example src/crawl-gateway/worker.ts tests/unit/config-env.test.ts tests/unit/crawl-gateway-analysis.test.ts tests/unit/gemini-website-analysis.test.ts tests/unit/website-analysis-run.test.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: add Gemini daily analysis budget config"
```

### Task 2: D1 admission ledger

**Files:**
- Create: `migrations/0004_website_analysis_daily_usage.sql`
- Create: `src/website-analysis/daily-usage.ts`
- Modify: `src/website-analysis/pipeline-errors.ts`
- Modify: `src/website-analysis/d1-analysis-pipeline.ts` (add `batch` to the database type only)
- Modify: `tests/integration/d1-website-analysis-pipeline.test.ts` (add a `batch` method to the local database doubles so the widened type typechecks; do not change their assertions)
- Test: `tests/integration/website-analysis-daily-usage.test.ts`

**Interfaces:**
- Consumes: `D1WebsiteAnalysisPipelineDatabase` and `D1WebsiteAnalysisPipelineError`.
- Produces: the signatures in Reservation algorithm. Later tasks import them from `src/website-analysis/daily-usage.ts`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/website-analysis-daily-usage.test.ts` using the Miniflare helper shape in `tests/integration/d1-website-analysis-store.test.ts`. Apply `migrations/0001_delta_qoralis_crawl.sql`, `migrations/0002_website_analysis.sql`, `migrations/0003_website_analysis_selection.sql`, and `migrations/0004_website_analysis_daily_usage.sql` through `database.exec`. Add a `prepareCount` only if a test needs it. Use evidence IDs 101 and 200. The date string is `2026-10-24`.

Tests:

- `the first usage read is zero without a row`: `readWebsiteAnalysisDailyUsage` returns both counters 0, and a following `COUNT(*)` on the usage table is 0.
- `the first reservation creates the usage row and one admission`: `reserveWebsiteAnalysisBatch(database, "2026-10-24", [101], 10)` returns `true`. The usage row is `websites_admitted` 1 and `gemini_requests_used` 1. One admission row exists for `(2026-10-24, 101)`.
- `a same-day duplicate evidence id is rejected and rolled back`: after 101 is admitted, a second `reserveWebsiteAnalysisBatch` for `[101]` with limit 10 returns `false`. `websites_admitted` stays 1, `gemini_requests_used` stays 1, and the admission count stays 1.
- `the 50th admission commits and the 51st does not`: insert 49 admission rows through the reservation function in groups of 5, then reserve the 50th alone. It returns `true` and `websites_admitted` is 50. The 51st returns `false`, the admission count stays 50, and `websites_admitted` stays 50.
- `a proposal that crosses the 50 cap rolls back every insert in that batch`: with 49 committed, `reserveWebsiteAnalysisBatch` for two new IDs returns `false`. Neither new ID is present. `websites_admitted` stays 49 and `gemini_requests_used` is unchanged.
- `the request limit is enforced without a schema change`: with limit 1, the first request-only `reserveGeminiRequest` returns `true`. The second returns `false` and `gemini_requests_used` stays 1. No admission row is created by the request-only call.
- `a lowered limit blocks a new reservation when used units are already above it`: set the row to `gemini_requests_used` 5 through successful reservations, then call `reserveGeminiRequest` with limit 3. It returns `false` and the stored value stays 5.
- `websites admitted matches the admission count`: after three successful new IDs and one rejected duplicate, `websites_admitted` equals `COUNT(*)` for that date.
- `overlapping reservations of one evidence id admit it once`: `Promise.all` of two `reserveWebsiteAnalysisBatch` calls for evidence ID 200 on the same date. One returns `true` and one returns `false`. One admission row exists. `websites_admitted` is 1. `gemini_requests_used` is 1.
- `a corrupt usage read fails closed`: a database double whose `first()` returns `{ websites_admitted: "1", gemini_requests_used: 0 }` makes `readWebsiteAnalysisDailyUsage` throw `D1WebsiteAnalysisPipelineError` code `BUDGET_FAILED`. No statement writes.
- `there is no refund path`: after a successful reservation, a second read returns the same counters. The module exports no function whose name contains `refund` or `release`. Assert that with an explicit export list check in the test, not by scanning the filesystem.

Do not create a run-history table. Do not assert tokens, cost, latency, or error text stored in D1.

- [ ] **Step 2: Run the tests to verify the RED**

Targeted command for `tests/integration/website-analysis-daily-usage.test.js`.

Expected RED: `tsc` cannot find `reserveWebsiteAnalysisBatch` or the module `src/website-analysis/daily-usage.ts`. Do not accept a missing migration assertion as a pass.

- [ ] **Step 3: Implement the minimum**

Add the migration and functions exactly as specified in Reservation algorithm. Add the two pipeline error codes before the daily-usage module throws them. Add `batch` to `D1WebsiteAnalysisPipelineDatabase`. In `tests/integration/d1-website-analysis-pipeline.test.ts`, add `batch()` to `TestDatabase`, `throwingDatabase`, and the barrel-contract database literal. Those methods throw `Error("unused")` or return `Promise.resolve([])` without being called. Do not change pipeline behavior or the existing assertions in this task.

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/integration/website-analysis-daily-usage.test.js` and `tests/integration/d1-website-analysis-pipeline.test.js`.

Expected: PASS. The existing pipeline test still applies only through migration 0003 because this task does not change its runtime path.

- [ ] **Step 5: Commit**

```bash
git add migrations/0004_website_analysis_daily_usage.sql src/website-analysis/daily-usage.ts src/website-analysis/pipeline-errors.ts src/website-analysis/d1-analysis-pipeline.ts tests/integration/website-analysis-daily-usage.test.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: add D1 analysis budget ledger"
```

### Task 3: Batched Gemini response contract

**Files:**
- Modify: `src/website-analysis/providers/gemini/prompt.ts`
- Modify: `src/website-analysis/providers/gemini/gemini-provider.ts`
- Modify: `src/website-analysis/providers/gemini/index.ts`
- Test: `tests/unit/gemini-website-batch.test.ts`
- Test: `tests/unit/gemini-website-analysis.test.ts`

**Interfaces:**
- Consumes: `selectFacts`, `readCandidate`, `validateWebsiteAnalysis`, `GEMINI_MODELS`, `GEMINI_RESPONSE_FORMAT`, `WebsiteFacts`, `GeminiWebsiteAnalysisConfig`.
- Produces: `analyzeWebsitesWithGemini`, `GeminiWebsiteBatchOptions`, `GeminiWebsiteBatchResult`, `GEMINI_WEBSITE_BATCH_PROMPT`, `GEMINI_BATCH_RESPONSE_FORMAT`, and `GEMINI_WEBSITE_BATCH_SIZE`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/gemini-website-batch.test.ts`. Build facts with the existing single-website fixture style and distinct `evidenceId` values 1 through 6. Inject `fetch`. `reserveNextRequest` records calls and returns `true` unless a test says otherwise. Pass `firstRequestReserved: true`. Assert the request URL, both headers, `store: false`, `stream: false`, and that `input` starts with `GEMINI_WEBSITE_BATCH_PROMPT` and contains a JSON array of `selectFacts` objects in the supplied order.

Tests:

- `one website is sent as a one-element analyses request`: one facts value, one `fetch`, response envelope has one valid analysis. The item is `ok: true`. `requestExhausted` is false. `reserveNextRequest` is not called.
- `five websites are sent in one request`: five facts values, one `fetch`, the parsed input array has length 5. No request body contains 50 objects.
- `more than five websites is rejected before fetch`: six facts values throw `RangeError`. `fetch` call count is 0. `reserveNextRequest` call count is 0.
- `identity mapping ignores array position`: the response `analyses` array is reversed. Each success is paired with its own facts value, not with the response index.
- `a missing analysis fails only that website`: five inputs, four returned. The missing `evidenceId` is `ok: false`. The other four are `ok: true`.
- `a duplicate analysis fails that website and persists neither copy`: two elements with the same identity and three other valid identities. The duplicated website is `ok: false`. The other three are `ok: true`.
- `an unexpected identity persists nothing for that element`: an extra element whose identity is not in the input does not add an item and does not flip a valid sibling to `ok: false`.
- `a mismatched lead version fails only that website`: the element copies `evidenceId` and changes `leadVersion`. That item is `ok: false` with `WebsiteAnalysisError` code `ANALYSIS_IDENTITY_MISMATCH`. Siblings stay `ok: true`.
- `four valid analyses persist when one sibling is invalid`: construct the batch result for five websites where the fifth finding uses a category outside the allowed set. Four items are `ok: true`. One is `ok: false` with `INVALID_ANALYSIS`. `fetch` was called once.
- `an unparseable envelope fails the whole batch`: the completed body is `{"analysis":[]}` or a JSON array. The call throws `GEMINI_INVALID_RESPONSE`. `fetch` was called once. The next model is not requested.
- `a completed HTTP error fails the whole batch without fallback`: status 400. The call throws `GEMINI_HTTP_ERROR`. `fetch` call count is 1.
- `a transport failure tries the next model only after reserveNextRequest returns true`: the first `fetch` throws, `reserveNextRequest` returns `true`, and the second model returns a valid envelope. `attemptedModels` is `[firstModel, secondModel]`. Every `ok: true` result uses that same list and the second model.
- `provenance lists only models whose fetch ran`: the first model succeeds. `attemptedModels` has length 1 and equals `[GEMINI_MODELS[0]]`.

Keep quota SQL out of this file.

- [ ] **Step 2: Run the tests to verify the RED**

Targeted command for `tests/unit/gemini-website-batch.test.js`.

Expected RED: `tsc` cannot find `analyzeWebsitesWithGemini`.

- [ ] **Step 3: Implement the minimum**

Add the prompt, schema, and function from Public contracts. Parse the completed body with the existing `readCandidate` path. Build a map keyed by the string `` `${evidenceId}\u0000${leadId}\u0000${leadVersion}` `` only after `typeof evidenceId === "number"`, `typeof leadId === "string"`, and `typeof leadVersion === "number"`. Call `validateWebsiteAnalysis(facts, candidate)` only for the single matched element. Freeze the result and a new `attemptedModels` array. Do not reserve the first request inside this function. Do not import the daily-usage module.

Export the new symbols from `src/website-analysis/providers/gemini/index.ts`.

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/unit/gemini-website-batch.test.js` and `tests/unit/gemini-website-analysis.test.js`.

Expected: PASS. Existing single-website fallback tests still pass against `analyzeWebsiteWithGemini`.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/providers/gemini/prompt.ts src/website-analysis/providers/gemini/gemini-provider.ts src/website-analysis/providers/gemini/index.ts tests/unit/gemini-website-batch.test.ts
git commit -m "feat: add batched Gemini website analysis"
```

### Task 4: Gemini request reservation at fetch

**Files:**
- Modify: `src/website-analysis/providers/gemini/gemini-provider.ts`
- Test: `tests/unit/gemini-website-batch.test.ts`

**Interfaces:**
- Consumes: `GeminiWebsiteBatchOptions.reserveNextRequest` and `firstRequestReserved`.
- Produces: the same `analyzeWebsitesWithGemini` signature. A later pipeline passes a `reserveNextRequest` that calls `reserveGeminiRequest` and returns its boolean. This task's tests use a stub.

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/unit/gemini-website-batch.test.ts`:

- `the first fetch does not call reserveNextRequest`: one successful model. `reserveNextRequest` call count is 0. `fetch` call count is 1. `attemptedModels` equals `[GEMINI_MODELS[0]]`.
- `fallback reserves the next request before the second fetch`: the first `fetch` throws. Record the order of events. `reserveNextRequest` happens after the first `fetch` settles and before the second `fetch` starts. Both models are in `attemptedModels`.
- `request exhaustion before fallback performs no further fetch`: the first `fetch` throws and `reserveNextRequest` returns `false`. `fetch` call count is 1. The return is `requestExhausted: true`. The call does not throw `GEMINI_TRANSPORT_UNAVAILABLE`. `attemptedModels` equals `[GEMINI_MODELS[0]]`.
- `an unsuccessful fetch still consumes the already reserved first unit`: this test does not decrement a counter inside the provider. The stub counts `reserveNextRequest` calls. The first model returns HTTP 500. `reserveNextRequest` is not called, `fetch` is called once, and the call throws `GEMINI_HTTP_ERROR`. The assertion is that the provider has no path that calls `fetch` and then calls a refund. Combine it with the event order: no reserve call exists after the failed response.
- `a retry call has its own attempted model list`: call `analyzeWebsitesWithGemini` twice. The first call's first `fetch` throws and the second model succeeds. The second call's first `fetch` succeeds. The second result's `attemptedModels` equals `[GEMINI_MODELS[0]]`, not the first call's two-model list.

- [ ] **Step 2: Run the tests to verify the RED**

Targeted command for `tests/unit/gemini-website-batch.test.js`.

Expected RED: `request exhaustion before fallback performs no further fetch` fails because the second model is fetched or the call throws `GEMINI_TRANSPORT_UNAVAILABLE`. Name that failure in the task notes if the first RED differs, and do not skip the assertion.

- [ ] **Step 3: Implement the minimum**

Inside the model loop, call `reserveNextRequest` only when a previous model in this call already ran `fetch` and failed with a thrown `fetch` or abort. On `false`, return the exhausted result for the websites that have no valid analysis. Do not call `reserveNextRequest` before the first model. Do not call it after `GEMINI_HTTP_ERROR` or `GEMINI_INVALID_RESPONSE`. Push a model onto `attemptedModels` only after its `fetch` is invoked. There is no refund call.

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/unit/gemini-website-batch.test.js` and `tests/unit/gemini-website-analysis.test.js`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/providers/gemini/gemini-provider.ts tests/unit/gemini-website-batch.test.ts
git commit -m "feat: enforce Gemini request reservations"
```

### Task 5: Batch execution and one retry round

**Files:**
- Modify: `src/website-analysis/d1-analysis-pipeline.ts`
- Modify: `src/website-analysis/index.ts`
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts`
- Test: `tests/integration/website-analysis-daily-usage.test.ts`

**Interfaces:**
- Consumes: `analyzeWebsitesWithGemini`, `reserveWebsiteAnalysisBatch`, `reserveGeminiRequest`, `readWebsiteAnalysisDailyUsage`, `persistD1WebsiteAnalysis`, `extractWebsiteFacts`, `evidenceFromRow`.
- Produces: `runD1WebsiteAnalysisPipeline` still has the same four-parameter signature. Its options accept `now` and `analyzeBatch`. The production path no longer calls `runWebsiteAnalysis`. The full quota walk in Batch composition algorithm is completed in Task 6; this task executes a batch the current selector returns, in groups of at most 5, and already uses the reservation functions so retry and midnight charges are real.

- [ ] **Step 1: Write the failing tests**

Retarget these existing tests in `tests/integration/d1-website-analysis-pipeline.test.ts` from `analysisRunOptions.analyze` to `options.analyzeBatch`. Keep their original guarantees:

- `runWebsiteAnalysis receives facts in selected order` becomes `analyzeWebsitesWithGemini receives facts in selected order`. The batch input order is `attempted_at ASC, id ASC`.
- `analysisRunOptions are forwarded to runWebsiteAnalysis` becomes `sleep and now are the only run seams the batch path uses`. Assert the injected `sleep` is awaited for a deferred batch and the injected `now` supplies the reservation date. Do not require `analyze` to be called.
- `runWebsiteAnalysis is invoked once` becomes `one selected website produces one batch call`.
- `a known Gemini failure stays on that website`, `an unexpected analyzer error escapes`, `successful items persist and failed items do not`, and `successful items persist in original result order` use a batch double that returns per-item results. An unexpected throw still escapes and is not stored as a fake provider failure.

Apply migration 0004 in this file's `withDatabase` helper before these new tests run. Existing selection tests that do not call Gemini must still pass.

Extend `ZERO_SUMMARY` and the barrel-contract sample with `budget` so they match the widened result. For this task, `maxItems === 0` still prepares nothing: its provisional budget is `utcDate` from the clock, both stored counters 0, `websiteLimit` 50, `geminiRequestLimit` copied from config, and `stoppedReason` `"max_items"`. Task 6 replaces that provisional zero-run with the ledger read. A failed reservation is not `selected` and not `failed`.

Add:

- `a batch of five uses one first-request reservation`: five eligible evidence rows, `dailyRequestLimit` 10, `maxItems` 5. The injected `fetch` is not used; `analyzeBatch` records one call with five facts. The usage row is `websites_admitted` 5 and `gemini_requests_used` 1 before `analyzeBatch` is entered. Assert that by reading D1 at the start of the stub.
- `four valid items persist and the invalid sibling does not`: `analyzeBatch` returns four `ok: true` items and one `ok: false` item. Four `website_analyses` rows exist. `selected` is 5, `succeeded` is 4, `failed` is 1, `persisted` is 4, `retried` is 0. `analyzeBatch` was called once.
- `transport failure defers the same batch once`: the first `analyzeBatch` throws `GEMINI_TRANSPORT_UNAVAILABLE`. `sleep` receives `90_000` unless the injected clock is already past `retryAt`. The second call receives the same evidence IDs. After the second call succeeds, `retried` is 5 when all five were sent on the retry, `websites_admitted` is 5, and `gemini_requests_used` is 2.
- `HTTP and validation failures are not deferred`: `analyzeBatch` throws `GEMINI_HTTP_ERROR` once. `sleep` is not called. `analyzeBatch` call count is 1. `retried` is 0. The admission rows remain.
- `a same-batch retry does not insert another admission`: the retry call is the second `analyzeBatch` invocation. Admission count for the date stays equal to the batch length, not twice that length.
- `an in-flight retry after midnight charges only the new day's request`: `now` returns `2026-10-24T23:59:50.000Z` until the first `analyzeBatch` throws `GEMINI_TRANSPORT_UNAVAILABLE`, then returns `2026-10-25T00:00:20.000Z`. `sleep` resolves without waiting in wall-clock time. After the retry succeeds, the `2026-10-24` usage row has `websites_admitted` 1 and `gemini_requests_used` 1 for one website. The `2026-10-25` usage row has `websites_admitted` 0 and `gemini_requests_used` 1. No admission row exists for `2026-10-25`. `retried` is 1.
- `a retry that cannot reserve does not fetch and is not retried`: pre-set `2026-10-24` `gemini_requests_used` to the limit after the first reservation by using limit 1. The first call throws transport. The retry reservation returns `false`. `analyzeBatch` is called once. `retried` is 0. The website is `failed`. Yesterday's admission remains.

`selected = succeeded + failed` in every successful return from these tests.

- [ ] **Step 2: Run the tests to verify the RED**

Targeted command for `tests/integration/d1-website-analysis-pipeline.test.js`.

Expected RED: `an in-flight retry after midnight charges only the new day's request` fails because the pipeline still calls `runWebsiteAnalysis` and does not write the ledger, or `tsc` fails because `analyzeBatch` is not on the options type. Do not accept the old `runWebsiteAnalysis is invoked once` test as proof of this task.

- [ ] **Step 3: Implement the minimum**

Stop calling `runWebsiteAnalysis` from the pipeline. For the facts extracted from the current selector, group them in that order into arrays of at most 5. Before each group, call `reserveWebsiteAnalysisBatch` with the IDs that `readWebsiteAnalysisAdmissions` does not already contain. On `true`, call `analyzeBatch` or `analyzeWebsitesWithGemini` with `firstRequestReserved: true` and a `reserveNextRequest` that calls `reserveGeminiRequest` for `utcAnalysisDate(clock)` at that moment. On `false`, do not call the analyzer for that group.

A thrown `GEMINI_TRANSPORT_UNAVAILABLE` defers that same facts array. Any other thrown `GeminiWebsiteAnalysisError`, and a returned `requestExhausted: true`, is terminal for the unresolved websites in that group and is not deferred. After the first pass, replay deferred groups once, as specified in Midnight clock. The retry calls `reserveGeminiRequest`, not `reserveWebsiteAnalysisBatch`. If it returns `false`, those websites fail with `retried: false` and the analyzer is not called. If the retry call sends an HTTP request, the websites in that call have `retried: true`, including a second transport failure.

Persist `ok: true` items sequentially in the order they entered the invocation, through `persistD1WebsiteAnalysis`. Do not persist `ok: false` items. Add `budget` with `stoppedReason` `"max_items"` when `maxItems === 0` or `selected === maxItems`, and `"no_evidence"` when the selected evidence is exhausted. Task 6 adds `request_cap` and `website_cap`. `maxItems === 0` in this task still returns before D1. Do not implement the 49/50 early stop here: the current selector may still return every eligible row, and this task's tests do not seed a nearly full cap. A failed `reserveWebsiteAnalysisBatch` does not count those websites as `selected` or `failed`. Do not leave the runner admitting a second time on retry.

Re-export `analyzeWebsitesWithGemini` and its result types from `src/website-analysis/index.ts` beside the existing Gemini exports. Do not export `runWebsiteAnalysis` removal; that function stays exported.

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/integration/d1-website-analysis-pipeline.test.js`, `tests/integration/website-analysis-daily-usage.test.js`, and `tests/unit/website-analysis-run.test.js`.

Expected: PASS. `runWebsiteAnalysis` unit tests still pass because that function is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/d1-analysis-pipeline.ts src/website-analysis/index.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: run website analysis in batches"
```

### Task 6: Quota-aware selection

**Files:**
- Modify: `src/website-analysis/d1-analysis-pipeline.ts`
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts`

**Interfaces:**
- Consumes: the Task 5 runner, `SELECTION_SQL`, `readWebsiteAnalysisDailyUsage`, `readWebsiteAnalysisAdmissions`, `reserveWebsiteAnalysisBatch`, and `DAILY_WEBSITE_CAP`.
- Produces: the pipeline order in the approved design: invalid `maxItems`, invalid `dailyRequestLimit`, zero-run read, request-cap short circuit, selection, facts extraction, composition, reservation, analysis, retry, persistence, frozen summary. `budget.stoppedReason` uses the precedence in Global Constraints.

- [ ] **Step 1: Write the failing tests**

Add these tests to `tests/integration/d1-website-analysis-pipeline.test.ts`. Seed usage and admission rows with the Task 2 functions or direct SQL that matches a committed reservation. `analyzeBatch` records the evidence IDs it receives and returns valid items unless a test says otherwise. `dailyRequestLimit` is 10 unless the test names another value.

- `usage 49 of 50 admits only the first of five new candidates`: five new eligible rows in deterministic order. The analyzer receives one call with the oldest evidence ID only. `websites_admitted` becomes 50. `gemini_requests_used` increases by 1. The other four evidence IDs have no admission row and no `website_analyses` row. `selected` is 1. `stoppedReason` is `website_cap`.
- `usage 49 of 50 keeps admitted A and B and the next new candidate only`: seed admissions for A and B on the test date, with `websites_admitted` 49, and no `website_analyses` rows. Eligible order is A, B, C, D, E, with C, D, and E new. The analyzer receives A, B, and C. D and E are absent from the call. `websites_admitted` becomes 50. Admission rows for D and E do not exist. `selected` is 3. Assert the selection SQL was bound with `maxItems`, not with `1`. Capture the bound `LIMIT` value through a wrapping `prepare`, or assert that A and B were visible to the analyzer even though one slot remained. One `LIMIT` query is enough. Do not add a second evidence query that skips C.
- `usage 50 of 50 reanalyzes an admitted candidate when a request remains`: A is admitted, no analysis row, the next row B is new. The analyzer receives only A. `websites_admitted` stays 50. `gemini_requests_used` increases by 1. B is not selected. `stoppedReason` is `website_cap`.
- `usage 50 of 50 does not select a new candidate`: the oldest eligible row is new. `analyzeBatch` is not called. No 51st admission exists. `selected` is 0. `stoppedReason` is `website_cap`.
- `request exhaustion stops before fetch even for an admitted website`: `gemini_requests_used` equals `dailyRequestLimit`, A is already admitted, and A has no analysis row. `analyzeBatch` is not called. `selected` is 0. `stoppedReason` is `request_cap`. `websites_admitted` is unchanged.
- `two already admitted and three new with three slots sends all five`: `websites_admitted` is 47. Order is A, B admitted and C, D, E new. One analyzer call receives all five. `websites_admitted` becomes 50. `gemini_requests_used` increases by 1. Admission inserts for this run are C, D, and E only.
- `maxItems 0 reads the ledger and writes nothing`: a usage row already has `websites_admitted` 4 and `gemini_requests_used` 2. `maxItems` 0 returns counters all 0, `budget.websitesAdmitted` 4, `budget.geminiRequestsUsed` 2, `budget.websiteLimit` 50, and `stoppedReason` `max_items`. A `COUNT(*)` of admissions is unchanged. `analyzeBatch` is not called. No `website_analyses` insert runs.
- `an invalid daily request limit throws before D1`: `dailyRequestLimit` 0 throws `INVALID_CONFIGURATION`. The database `prepare` count is 0.
- `a same-day reattempt adds no website slot and counts as selected`: A was admitted earlier and has no analysis row because the first analysis failed. The next invocation's `selected` includes A. `websites_admitted` is unchanged. `gemini_requests_used` increases by 1 before the analyzer stub runs.
- `a new invocation after midnight admits the same evidence once`: the previous UTC date has A's admission and `websites_admitted` 1. The clock is `2026-10-25T00:00:01.000Z`. A has no analysis row. The invocation admits A on `2026-10-25`. That date's `websites_admitted` is 1 and `gemini_requests_used` is 1. The previous date's `websites_admitted` stays 1.
- `selected equals succeeded plus failed when a later batch is not entered`: `maxItems` 6, two batches worth of new rows, and `dailyRequestLimit` 1. The first five are selected. The sixth is not `selected` or `failed`. `gemini_requests_used` is 1.

The `maxItems 0 reads the ledger and writes nothing` test replaces `maxItems 0 returns a frozen zero summary without D1 work`. Do not keep both. Keep the assertions that Gemini is not called, nothing is persisted, and the five counters are 0. Do not delete the invalid-`maxItems` test; it still prepares nothing.

- [ ] **Step 2: Run the tests to verify the RED**

Targeted command for `tests/integration/d1-website-analysis-pipeline.test.js`.

Expected RED: `usage 49 of 50 admits only the first of five new candidates` fails because the analyzer received more than one evidence ID, or because `stoppedReason` is not `website_cap`. That is the specific RED for this task.

- [ ] **Step 3: Implement the minimum**

Implement the pipeline order and the Batch composition algorithm. Validate `dailyRequestLimit` with `Number.isInteger` and the inclusive range 1 through 10000 immediately after the existing `maxItems` check and before any D1 call. `maxItems === 0` reads usage for `utcAnalysisDate(clock)` and returns the zero counters plus that budget. Do not write.

When `geminiRequestsUsed >= dailyRequestLimit`, return before `SELECTION_SQL` with `request_cap`. Otherwise select with `LIMIT maxItems`. Extract facts before the first reservation. A `CrawlEvidencePersistenceError` or `WebsiteFactsError` still propagates, and no reservation has run.

Use one fresh usage read before each batch. Follow the recompose rule in Reservation algorithm. Set `stoppedReason` by the first matching precedence rule. Freeze the summary. `websiteLimit` is the literal `50`.

Do not add a second selector. Do not change `SELECTION_SQL`'s `ORDER BY`.

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/integration/d1-website-analysis-pipeline.test.js` and `tests/integration/website-analysis-daily-usage.test.js`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/d1-analysis-pipeline.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: enforce daily website admission budget"
```

### Task 7: Worker budget response

**Files:**
- Modify: `src/crawl-gateway/worker.ts`
- Test: `tests/unit/crawl-gateway-analysis.test.ts`
- Test: `tests/unit/crawl-gateway-worker.test.ts`

**Interfaces:**
- Consumes: `D1WebsiteAnalysisPipelineResult.budget` and the Task 1 config parser.
- Produces: HTTP 200 JSON with the five counters and `budget` in the field order from Public contracts. Production `fetch` still calls `handleCrawlGatewayRequest(request, env)` with no dependency override and no pipeline options.

- [ ] **Step 1: Write the failing tests**

Update the success-body assertions in `tests/unit/crawl-gateway-analysis.test.ts` so the stubbed pipeline result includes `budget` and the HTTP body copies it. Add:

- `the analysis success body copies counters and budget without analysis content`: the stub returns `selected` 1, `succeeded` 1, `failed` 0, `retried` 0, `persisted` 1, and a budget object for `2026-10-24` with `websitesAdmitted` 1, `websiteLimit` 50, `geminiRequestsUsed` 1, `geminiRequestLimit` 10, and `stoppedReason` `no_evidence`. The response text is exactly:

```json
{"selected":1,"succeeded":1,"failed":0,"retried":0,"persisted":1,"budget":{"utcDate":"2026-10-24","websitesAdmitted":1,"websiteLimit":50,"geminiRequestsUsed":1,"geminiRequestLimit":10,"stoppedReason":"no_evidence"}}
```

The body does not contain the Gemini key, the token, `summary`, or `findings`.

- `a zero maxItems success copies the unread budget from the pipeline`: `maxItems` 0. The Worker does not invent a local zero budget. The body `budget` deep-equals the stub's `budget`.
- `a thrown pipeline error stays a fixed 500`: the stub throws `D1WebsiteAnalysisPipelineError` with code `BUDGET_FAILED` and a message that contains the Gemini key. The response is HTTP 500 `{"error":"internal_error"}`. The body does not contain `BUDGET_FAILED` or the key.
- `ANALYSIS_GATEWAY_TOKEN does not authorize a crawl route` and the existing crawl-token tests still fail the opposite route with 401. Re-run them; do not rewrite them.
- `crawl selection still returns candidates`: `POST /internal/crawl/select` with `CRAWL_GATEWAY_TOKEN` and without `GEMINI_DAILY_REQUEST_LIMIT` keeps its current 200 shape. The new env field is optional.

- [ ] **Step 2: Run the tests to verify the RED**

Targeted command for `tests/unit/crawl-gateway-analysis.test.js`.

Expected RED: the success body assertion fails because `budget` is absent from the JSON.

- [ ] **Step 3: Implement the minimum**

Copy `utcDate`, `websitesAdmitted`, `websiteLimit`, `geminiRequestsUsed`, `geminiRequestLimit`, and `stoppedReason` from `result.budget` into a new object. Put that object on the 200 body as `budget` after `persisted`. Do not pass `result.budget` through by reference. Do not add fields. A thrown pipeline, including `BUDGET_FAILED` and `INVALID_CONFIGURATION`, stays in the existing generic catch and returns the fixed 500. Do not log the error message.

- [ ] **Step 4: Run focused tests and the relevant regression**

Targeted command for `tests/unit/crawl-gateway-analysis.test.js` and `tests/unit/crawl-gateway-worker.test.js`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/crawl-gateway/worker.ts tests/unit/crawl-gateway-analysis.test.ts
git commit -m "feat: integrate DQ-037 analysis budgets"
```

### Task 8: Public surface and offline verification

**Files:**
- Modify: `src/website-analysis/index.ts` only if Task 5 left a batch symbol unexported.
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts` (`public pipeline exports are the barrel contract`, updated to include the batch symbols and `budget` on the result type's runtime object).

**Interfaces:**
- Consumes: the exports produced by Tasks 3 through 7.
- Produces: no new runtime behavior. `node scripts/run-tests.cjs` and `npm run typecheck` pass. A repository search shows no scheduler was added.

- [ ] **Step 1: Write the failing test**

Extend `public pipeline exports are the barrel contract` so the barrel exports `analyzeWebsitesWithGemini` and `GEMINI_WEBSITE_BATCH_SIZE`. Assert `GEMINI_WEBSITE_BATCH_SIZE` is 5. Assert a zero-run pipeline result's own keys are `selected`, `succeeded`, `failed`, `retried`, `persisted`, and `budget`, in that order.

- [ ] **Step 2: Run the test to verify the RED**

Targeted command for `tests/integration/d1-website-analysis-pipeline.test.js`.

Expected RED: the barrel assertion fails if `analyzeWebsitesWithGemini` is not exported, or the key-order assertion fails. If Task 5 already exported the symbol and Task 6 already returns `budget`, this step is PASS and the implementation step is a confirmation, not a new feature.

- [ ] **Step 3: Implement the minimum**

Re-export the missing batch symbols from `src/website-analysis/index.ts` if the test failed for that reason. Do not add a wrapper. Do not edit `docs/PLAN.md` or `docs/BACKLOG.md`. Do not mark a production verification record.

Search the implementation diff for `scheduled`, `cron`, `wrangler secret`, `queues`, `DurableObject`, `OpenRouter`, `Groq`, and `Workers AI`. None of those additions belong in this slice. `wrangler.toml` stays unchanged.

- [ ] **Step 4: Run the full offline suite**

```bash
node scripts/run-tests.cjs
npm run typecheck
git diff --check
```

Expected: both commands exit 0. `git diff --check` prints nothing. The suite stays offline.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/index.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "docs: complete DQ-037 implementation state"
```

If the only change is the test assertion and no source file changed, use that commit for the test. If this step confirms exports that were already committed and the worktree is clean, do not create an empty commit.

## Post-merge activation checklist

This checklist is not a task. The Builder does not run it. Merging this slice does not authorize a Gemini request.

1. Apply `migrations/0004_website_analysis_daily_usage.sql` to production D1 `delta-qoralis-crawl` before deploying a Worker that reads these tables.
2. Set non-secret Worker variable `GEMINI_DAILY_REQUEST_LIMIT` to an operator-chosen integer from 1 through 10000. Do not store it with `wrangler secret put`. Do not invent that integer in source.
3. Leave the existing secrets `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, and `CRAWL_GATEWAY_TOKEN` unchanged. Do not print or commit their values.
4. After that activation, a `maxItems` 0 call is the configuration smoke. A `maxItems` greater than 0 call is a real budgeted analysis and is outside this plan.

## Spec coverage

- Batch size 5 and the 50-website cap are Tasks 3 and 6.
- Request reservation before every `fetch`, fallback, and retry is Tasks 2, 4, and 5.
- The 49/50, 50/50, admitted-prefix, and no-skip cases are Task 6.
- Partial success and identity mapping are Task 3.
- Midnight retry versus a new invocation is Tasks 5 and 6.
- `maxItems` 0 and invalid configuration are Tasks 1 and 6.
- The Worker budget object and crawl compatibility are Task 7.
- DQ-038 scheduling and DQ-039 history are not tasks.
