# DQ-037 Batched Gemini Analysis and Daily Budget Guard

## Status

```text
design, human-approved decisions, not implemented
```

## Intent

Delta Qoralis is the company. Analyzing and Mailing Agent is the agent. This design does not rename the agent to the company, and it does not rename the deployed Worker `delta-qoralis-crawl-gateway`.

DQ-037 makes the existing production analysis path spend Gemini in batches of at most 5 websites and account for that spend in production D1. One UTC day admits at most 50 websites. Each real Gemini HTTP request consumes one request unit, bounded by the runtime value `GEMINI_DAILY_REQUEST_LIMIT`. Manual analysis and a future scheduled run must not be able to spend the same last quota units.

This slice stays inside `runD1WebsiteAnalysisPipeline` and `POST /internal/analysis/run`. It does not create a second analysis system.

## Current state

DQ-030 through DQ-036 are completed. DQ-036 is production-verified. DQ-037, DQ-038, and DQ-039 are planned and were not architected before this document. This design covers DQ-037 only.

The production Worker is `delta-qoralis-crawl-gateway`, entry `src/crawl-gateway/worker.ts`, configured by `wrangler.toml` with `compatibility_date = "2026-10-22"`, `compatibility_flags = ["nodejs_compat"]`, and one D1 binding `DB` for database `delta-qoralis-crawl`, ID `59efef60-8acd-4277-b808-8220de5521eb`. `wrangler.toml` contains no secrets and no analysis quota.

`handleCrawlGatewayRequest` serves `POST /internal/crawl/select`, `POST /internal/crawl/evidence`, and `POST /internal/analysis/run`. Crawl routes authenticate with `CRAWL_GATEWAY_TOKEN`. The analysis route authenticates with `ANALYSIS_GATEWAY_TOKEN`. The analysis body is exactly `{ maxItems }` for an integer 0 through 50. `geminiConfigFromEnv` accepts `GEMINI_API_KEY` only when it is a string, non-empty, and free of whitespace or control characters under `/[\s\u0000-\u001f\u007f-\u009f]/u`. The Worker does not call `loadConfig()`. A missing or invalid key is HTTP 500 `{ "error": "internal_error" }`. Success HTTP 200 copies `selected`, `succeeded`, `failed`, `retried`, and `persisted`. Fixed error bodies and the 404, 405, 401, 400, 500 order from DQ-036 stay.

`GeminiWebsiteAnalysisConfig` in `src/config/env.ts` is `{ provider: "gemini", apiKey: string }`. `parseWebsiteAnalysisConfig` is private to `loadConfig()`. `WEBSITE_ANALYSIS_PROVIDER=gemini` requires `GEMINI_API_KEY`. `disabled` or an absent provider does not. The repository has no `GEMINI_DAILY_REQUEST_LIMIT` name. That name is free to use.

`analyzeWebsiteWithGemini` sends one `WebsiteFacts` value per request to `https://generativelanguage.googleapis.com/v1/interactions` with `x-goog-api-key`, `store: false`, `stream: false`, a 30_000 ms abort, and `GEMINI_RESPONSE_FORMAT`. The model chain is `GEMINI_MODELS`: `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`. One outbound `fetch` is one real Gemini API request. A thrown fetch or abort tries the next model. A completed HTTP status outside 200–299 throws `GeminiWebsiteAnalysisError` `GEMINI_HTTP_ERROR` and does not try another model. An unreadable completed 2xx throws `GEMINI_INVALID_RESPONSE` and does not try another model. `validateWebsiteAnalysis(facts, candidate)` runs only after a candidate exists. `WebsiteAnalysisError` does not try another model. If every model transport-fails, the function throws `GEMINI_TRANSPORT_UNAVAILABLE`. There is no Gemini SDK.

`runWebsiteAnalysis` accepts 0–50 unique `evidenceId` values, analyzes them one at a time, and defers only `GEMINI_TRANSPORT_UNAVAILABLE`. After the first pass it waits until that failure time plus 90_000 ms, then calls the analyzer once more. `retried` is true only for that second call. Known analyzer errors stay on that website. There is no D1 ledger in this function.

`runD1WebsiteAnalysisPipeline` validates `maxItems`, returns a zero summary when `maxItems === 0` before D1 and before Gemini, then selects fetched `single_page_crawl_evidence` that has no `website_analyses` row, ordered by `attempted_at ASC, id ASC`, limited by `maxItems`. It reconstructs evidence with `evidenceFromRow`, extracts facts with `extractWebsiteFacts`, calls `runWebsiteAnalysis` once, and persists each success through `persistD1WebsiteAnalysis`. `selected` is currently the number of selected evidence rows. `website_analyses` is append-only. `website_analyses_evidence_id_idx` is not unique. Migrations present are `0001_delta_qoralis_crawl.sql`, `0002_website_analysis.sql`, and `0003_website_analysis_selection.sql`. The next migration number is `0004`.

D1 access in this repository is the structural `prepare().bind()` surface with `all`, `first`, and `run`. `run().meta.changes` is already part of that surface. No analysis code uses `batch()`, a SQL transaction, a Durable Object, KV, or R2.

## Goals

- Send at most 5 websites in one normal Gemini request.
- Admit at most 50 distinct evidence IDs per UTC day. A failed analysis keeps that day's admission. The same evidence ID does not take a second website slot on that day.
- Count every real Gemini HTTP request, including fallback and the delayed retry.
- Reserve quota before the HTTP call, atomically, so two overlapping runs cannot spend the same last units.
- Keep four valid websites when one sibling in the same response is invalid.
- Keep a returned analysis tied to the website identified by `evidenceId`, `leadId`, and `leadVersion`.
- Keep `POST /internal/analysis/run`, `maxItems` 0 through 50, and the existing five summary counters.
- Let `maxItems === 0` prove configuration, including `GEMINI_DAILY_REQUEST_LIMIT`, without spending quota.

## Non-goals

Scheduling stays in DQ-038 and is not designed here. History and observability beyond this ledger stay in DQ-039 and are not designed here. Provider expansion, qualification, contact discovery, and outreach stay out of this slice.

## Approved decisions

These decisions are closed.

- Batch size is fixed at 5 websites per normal Gemini request. It is not configurable. A batch may contain fewer than 5 when fewer websites are available or allowed. One request never contains 50 websites.
- The daily website cap is fixed at 50 websites per UTC calendar day. It is not configurable. The reset boundary is 00:00 UTC. The day identity is the ISO UTC date `YYYY-MM-DD`. There is no reset cron. Yesterday's row is not deleted or zeroed. A new UTC date starts with fresh counters.
- A website consumes at most one daily website slot per `(utc_date, evidence_id)`. The slot is consumed when that evidence ID is first admitted to Gemini analysis on that UTC date. The slot stays consumed when transport fails, HTTP fails, output is malformed, validation fails, or the analysis ultimately fails. Model fallback, the 90-second retry, a later manual invocation, a future scheduled invocation, and an overlapping invocation do not increment `websites_admitted` again for that same pair. A website that never enters a Gemini batch consumes no slot. A new UTC date may admit the same evidence ID again when it is still eligible.
- Every real outbound HTTP request to Gemini consumes 1 Gemini request unit. That includes the first-model request, each model fallback, the later transport retry, fallback during the retry round, and a later same-day invocation that calls Gemini again for an evidence ID that already has that day's admission.
- The request cap is the runtime environment variable `GEMINI_DAILY_REQUEST_LIMIT`. Repository inspection found no naming conflict. It fails closed when missing or invalid for a real analysis run. The free-tier quota is not hard-coded. Changing the value later must not require a schema migration. Parse it as a positive integer with bounded safe-integer validation. Do not silently default. Missing or invalid configuration fails closed. `GEMINI_API_KEY` handling stays separate. The request limit is not a secret.
- Reserve one API-request unit immediately before each actual Gemini HTTP request. If none remains, do not send that HTTP request. No path may call Gemini and record usage afterward.
- When a website batch begins, account atomically for the new evidence IDs in that batch plus 1 Gemini API-request unit for the first request. Evidence IDs that already have that UTC date's admission are in the batch without another website slot. The reservation fails closed if a required new website slot or the request unit is unavailable. Do not add a Durable Object. Use D1. Do not use an unprotected read-then-write.
- After the initial request, model fallback consumes no additional website slots. Each fallback HTTP request consumes one additional API-request unit. The 90-second retry consumes no additional website slots. Every HTTP request during that retry consumes one API-request unit. If request budget is exhausted midway through fallback or retry, send no further Gemini request. Those websites may fail for that run and remain eligible for a later run or day when no analysis was persisted.
- Partial success is required. Four valid analyses survive when the fifth item in that response is malformed. Do not discard the four. Do not automatically retry the whole batch because one website's output is invalid. Validation stays per website through the existing `validateWebsiteAnalysis(facts, candidate)` contract.
- Each returned candidate maps deterministically to the correct `WebsiteFacts`. Identity protects at least `evidenceId`, `leadId`, and `leadVersion`. Do not persist a candidate under the wrong website. Missing, duplicate, mismatched, or malformed output for one expected website fails that website without corrupting valid siblings where that is technically possible. Unexpected model output never creates an analysis for a website that was not in the input batch.
- Preserve DQ-032 transport behavior where practical. A transport failure may use the next Gemini model, subject to request budget. If every allowed model transport-fails, preserve one delayed retry round after approximately 90 seconds. Retry the unresolved batch rather than consuming new website slots. A completed HTTP non-2xx does not model-fallback. An unparseable completed 2xx does not model-fallback. If the whole response cannot be mapped to any website safely, the batch websites may fail. If only individual entries are bad, preserve valid sibling analyses.
- Add one authoritative D1 daily-usage ledger. One logical usage row per UTC day. It must support `utc_date`, `websites_admitted`, and `gemini_requests_used`. `websites_admitted` cannot exceed 50. `gemini_requests_used` cannot be negative. The request limit is not a schema constraint. Previous UTC-day rows may remain. There is no detailed per-request history table. This ledger is mutable operational accounting. `website_analyses` stays append-only. Use migration `migrations/0004_website_analysis_daily_usage.sql`. The same migration also stores the daily admission identity needed to enforce one website slot per `(utc_date, evidence_id)`. That identity is quota state, not history.
- Manual analysis and future scheduled analysis may overlap. Two runs must not spend the same final quota units. Use an atomic D1 conditional update. Do not add Durable Objects, KV, R2, external Redis, queues, or locks unrelated to the daily ledger.
- If a long-running operation crosses midnight, each new reservation uses the UTC date at the time of that reservation. A retry crossing midnight may consume an API-request unit from the new UTC day. It must not consume another website slot for a website already admitted on the previous day.
- The DQ-035 and DQ-036 path becomes budget-aware. `selected` means websites that enter Gemini analysis in this invocation. It includes a same-day re-attempt of an evidence ID that already has today's admission. It does not include candidates that never entered a batch. `selected` is not the daily unique admission count. Budget exhaustion before another batch ends further processing cleanly and does not manufacture provider failures for websites that were never attempted. The authenticated runtime response may add a small non-sensitive budget summary.
- `maxItems` 0 through 50 remains the per-invocation operator bound. It does not replace either daily budget. This invocation enters no more websites than `maxItems`. It creates no more new daily admissions than the remaining website slots. It starts no batch unless a Gemini request unit remains. Already-admitted evidence for the current UTC date may enter without a new website slot. One request unit covers one batch, not one website.
- `maxItems === 0` authenticates, validates the request, validates required analysis configuration, admits no websites, consumes no website budget, consumes no Gemini request budget, makes no Gemini HTTP request, and persists no analysis. `GEMINI_DAILY_REQUEST_LIMIT` is validated on that zero-run. This zero-run validation is approved.

## Approaches considered

Approach A, a D1 daily budget ledger plus 5-website Gemini batching, is chosen. It accounts for failures and fallbacks, can be shared by manual and future scheduled runs, uses existing production D1, enables batching, and stays relatively simple.

Approach B, inferring usage from `website_analyses`, is rejected. Failed websites and failed or fallback Gemini requests may produce no persisted row and would undercount quota.

Approach C, a Durable Object or external quota limiter, is rejected for DQ-037. It adds infrastructure and complexity that the present scale does not require.

## Chosen architecture

Keep one production path:

```text
POST /internal/analysis/run
→ existing ANALYSIS_GATEWAY_TOKEN check
→ existing maxItems validation
→ GEMINI_API_KEY validation
→ GEMINI_DAILY_REQUEST_LIMIT validation
→ runD1WebsiteAnalysisPipeline
→ D1 ledger reservation
→ analyzeWebsitesWithGemini
→ validateWebsiteAnalysis per website
→ persistD1WebsiteAnalysis per success
→ five counters plus budget summary
```

`runWebsiteAnalysis` and `analyzeWebsiteWithGemini` stay as they are, including the single-website prompt, `GEMINI_RESPONSE_FORMAT`, one-website fallback, and the 90_000 ms one-website retry. Existing DQ-032 and DQ-033 tests keep that contract. The production pipeline stops calling `runWebsiteAnalysis`. Batching, admission, request reservation, and the batch-level 90-second retry live in the pipeline and the new batch Gemini function. That is one production system, not a second pipeline entry.

No service layer, repository factory, dependency-injection framework, plugin architecture, provider registry, generic budget engine, generic quota framework, distributed lock, queue, scheduler, or monitoring system is added.

### Architect calls

These choices do not reopen the approved decisions.

- The aggregate table name is `website_analysis_daily_usage`. The admission-identity table name is `website_analysis_daily_admissions`. Both are created by `migrations/0004_website_analysis_daily_usage.sql`. No second migration is added. The admission table has no columns beyond `utc_date` and `evidence_id`.
- `GEMINI_DAILY_REQUEST_LIMIT` parses as a canonical base-10 integer from 1 through 10000 inclusive, with no sign, no leading zero, and no surrounding whitespace. 10000 is only a parse bound. It is not a quota and it is not a free-tier value.
- `GeminiWebsiteAnalysisConfig` gains a required `dailyRequestLimit: number`. `analyzeWebsiteWithGemini` ignores that field. Key parsing and limit parsing are separate functions. `loadConfig()` enforces the limit only when `WEBSITE_ANALYSIS_PROVIDER=gemini`. The Worker parser does not call `loadConfig()` and does not consult `WEBSITE_ANALYSIS_PROVIDER`.
- The batch function is `analyzeWebsitesWithGemini`. The batch prompt constant is `GEMINI_WEBSITE_BATCH_PROMPT`. The batch response schema constant is `GEMINI_BATCH_RESPONSE_FORMAT`. The envelope property is `analyses`.
- Fixed constants are `GEMINI_WEBSITE_BATCH_SIZE = 5`, `DAILY_WEBSITE_CAP = 50`, and the existing `90_000` and `30_000` millisecond values. None of them is configurable. The per-request timeout stays 30_000 ms.
- New pipeline codes are `INVALID_CONFIGURATION` ("D1 website analysis configuration is invalid.") and `BUDGET_FAILED` ("D1 website analysis budget ledger failed."), using the existing frozen-code error style. The public message is only that sentence. Reservation exhaustion is not one of these errors.
- A later same-day invocation of an evidence ID that already has `website_analysis_daily_admissions` for today analyzes it again without incrementing `websites_admitted`. The Gemini HTTP request still reserves one request unit before `fetch`. A new UTC date has a new admission namespace, so the same evidence ID can take one new website slot on that date.
- The reservation uses D1 `batch()`, which rolls back every statement in the batch when any statement fails. The structural pipeline database type gains that `batch` method. This is not a transaction framework.
- `retried` is true only when a retry-round Gemini HTTP request was actually sent.
- The budget object and `stoppedReason` strings are the ones in Runtime response behavior. Precedence when several bounds are closed is `max_items`, then `request_cap`, then `website_cap`, then `no_evidence`. Request exhaustion wins even when the next website would need zero additional website slots.

## D1 daily ledger

Create two mutable tables in `migrations/0004_website_analysis_daily_usage.sql`. Do not add append-only triggers. Do not add the request limit as a column or check. Do not add a second migration.

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
```

`website_analysis_daily_usage` has exactly one row per UTC date. `website_analysis_daily_admissions` has exactly one row per `(utc_date, evidence_id)`. The primary key is that uniqueness constraint. The admission table has no outcome, model, timestamp, error, token, cost, or request-count column. It is quota identity only. It is not run history, request history, failure history, an audit log, or a DQ-039 ledger.

`websites_admitted` is the number of admission-identity rows for that `utc_date`, not the number of persisted analyses and not the number of Gemini requests. After every committed reservation, `websites_admitted` equals `COUNT(*)` from `website_analysis_daily_admissions` for that date. `gemini_requests_used` is the number of Gemini HTTP requests reserved that day. The configured limit is applied only at reservation time. Previous dates remain. This slice does not update or delete another date's rows and does not delete admission rows.

The migration also creates two triggers. `website_analysis_daily_admissions_cap` is `BEFORE INSERT`. It ensures the usage row exists with zeros, then `RAISE(ABORT, 'daily website cap')` when the admission count for `NEW.utc_date` is already 50, including rows inserted earlier in the same batch. `website_analysis_daily_admissions_count` is `AFTER INSERT`. It increments that date's `websites_admitted` by 1. An insert therefore cannot commit an identity without the matching aggregate increment, and it cannot commit a 51st identity. A failed later statement in the same `batch()` rolls the insert and the increment back together.

A read is not a reservation:

```sql
SELECT websites_admitted, gemini_requests_used
FROM website_analysis_daily_usage
WHERE utc_date = ?
```

No usage row means both counters are 0. A row whose values are not integers in the check range fails closed with `BUDGET_FAILED`. Do not coerce strings. Do not repair the row in this slice. Classifying candidates uses one additional read of `evidence_id` from `website_analysis_daily_admissions` for the current UTC date and the candidate IDs. That read does not spend quota. The reservation below is authoritative if the read is stale.

## UTC date semantics

The production clock is `() => new Date()`. A reservation's day is `clock().toISOString().slice(0, 10)` at the moment that reservation `batch()` runs. Use UTC from `toISOString()`. Do not use local `getFullYear`, `getMonth`, or `getDate`.

Tests inject the clock. The pipeline option is `now?: () => Date`. The 90-second wait uses that same clock's `getTime()` unless a test passes the existing `analysisRunOptions.now` and `sleep` seams. Production does not pass a second clock. The delay remains exactly 90_000 ms. It is not configurable.

There is no midnight job. Crossing 00:00 UTC does not update yesterday's usage row or yesterday's admission rows. The next reservation targets the new date. A new date starts with no usage row and no admission rows until a reservation creates them.

An in-flight 90-second retry is not a new admission. If the website was admitted on the previous UTC date and the retry reservation runs after midnight, the retry inserts no `website_analysis_daily_admissions` row. It creates the new date's usage row with `websites_admitted` 0 when that row is absent, or leaves an existing new-date `websites_admitted` unchanged, and increases that date's `gemini_requests_used` by 1. Yesterday's website count stays unchanged.

A later batch in the same invocation that has not yet reserved, and any new invocation after midnight, uses the new date's admission namespace. The same `evidence_id` has no admission on that date yet, so a successful new admission consumes one website slot for the new date. That is different from the in-flight retry.

## Website reservation

A website slot is consumed only when a new `(utc_date, evidence_id)` admission row commits. Model fallback, the 90-second retry, and a later same-day batch that finds the row already present do not insert it again and do not increment `websites_admitted`.

Worked same-day sequence for evidence ID 101:

- 09:00 UTC, first admission: `websites_admitted` +1, `gemini_requests_used` +1, one admission row.
- 09:01 UTC, model fallback: `websites_admitted` +0, `gemini_requests_used` +1, no new admission row.
- 12:00 UTC, a later invocation selects 101 because no `website_analyses` row exists: `websites_admitted` +0, `gemini_requests_used` +1 before `fetch`, same admission row.
- The next UTC date, 101 is selected again: one new admission row for that date, that date's `websites_admitted` +1, that date's `gemini_requests_used` +1.

Candidates stay in DQ-035 order: eligible fetched evidence with no `website_analyses` row, `attempted_at ASC, id ASC`. Selection uses `LIMIT maxItems`. It is not limited by the remaining website slots, because an already-admitted evidence ID must remain selectable when the website cap is full. `maxItems === 0` does not select.

A planning read classifies each selected candidate as already admitted today or new today. The read can be stale. Compose the next batch from the first not-yet-sent candidate forward, without reordering:

- Include an already-admitted candidate with zero additional website charge.
- Include a new candidate only while the planned remaining website slots can cover every new ID in this batch.
- Stop the batch at size 5, at the remaining `maxItems` for this invocation, or at the first new candidate that would exceed the remaining website slots.
- Do not skip a new candidate that does not fit in order to reach a later already-admitted candidate.
- Do not charge or send the candidates that did not fit.

If the next batch would contain no websites, stop. If it would contain websites but no request unit remains, stop before reservation and do not `fetch`.

Examples of one composed batch:

- Already-admitted A and B, then new C, D, and E, with at least 3 website slots and 1 request unit: the Gemini request includes A through E. The reservation creates admission rows for C, D, and E only. `websites_admitted` +3. `gemini_requests_used` +1. A and B stay unchanged in website accounting.
- Usage is 49/50 and the next five candidates are all new: the batch contains only the first of those five. `websites_admitted` +1. `gemini_requests_used` +1. The other four are not reserved, not sent, and not counted in `selected`.
- Usage is 50/50, the next candidate is already admitted today, and a request unit remains: the batch contains already-admitted candidates only, up to 5, stopping before the next new candidate. `websites_admitted` +0. `gemini_requests_used` +1. The re-attempt runs.
- Usage is 50/50 and the next candidate is new: no batch. `website_cap`. No `fetch`.

The first-request reservation for a batch with one or more new IDs is one `batch()`:

1. `INSERT` the usage row for this UTC date with zeros, `ON CONFLICT (utc_date) DO NOTHING`.
2. `INSERT` one `website_analysis_daily_admissions` row per new evidence ID. There is no `OR IGNORE`. The primary key aborts a duplicate. The cap trigger aborts a 51st identity. The count trigger increments `websites_admitted` by 1 per inserted row.
3. `UPDATE` the usage row for this date:

```sql
UPDATE website_analysis_daily_usage
SET gemini_requests_used = CASE
  WHEN gemini_requests_used + 1 <= ?1 THEN gemini_requests_used + 1
  ELSE -1
END
WHERE utc_date = ?2
```

`?1` is the configured request limit. Assigning `-1` fails `CHECK (gemini_requests_used >= 0)` and fails that statement. Do not replace this with a `WHERE` that succeeds while changing 0 rows. A failed statement rolls back the D1 batch, including every admission insert and website increment from this reservation. Success means the batch resolves and every new identity, the website increment, and the request increment committed together. Only then may the pipeline call `analyzeWebsitesWithGemini` with `firstRequestReserved: true`.

A batch whose new-ID count is 0 uses the same `batch()` without step 2. It still performs steps 1 and 3 before `fetch`. It does not insert an admission row.

If `batch()` throws, nothing from that call remains. Do not `fetch`. Re-read the usage row and the candidate admission identities. If the composition changes because a raced evidence ID is now already admitted, compose again from the first candidate that was not in a committed batch. If the re-read shows the same composition still cannot fit the website cap or the request cap, stop. Do not spin and do not send a partial subset under a second, different reservation of the same failed proposal.

Model fallback and the 90-second retry must not insert admission rows. They use the request-only reservation below.

## API request reservation

Every Gemini `fetch` is preceded by a reserved request unit.

- The batch reservation above is the reservation for the first HTTP request of a batch, including a same-day re-attempt whose website charge is 0. The batch function must not reserve that first unit again.
- Immediately before each later HTTP request, reserve one unit and no website identity. If that reservation fails, do not call `fetch`.

```sql
INSERT INTO website_analysis_daily_usage (
  utc_date, websites_admitted, gemini_requests_used
) VALUES (?2, 0, 0)
ON CONFLICT (utc_date) DO NOTHING
```

followed, in the same `batch()`, by the same request `UPDATE` shown above. A new date created here keeps `websites_admitted` at 0. That is how a midnight retry spends a request unit without spending a website slot. The `-1` check failure rolls the batch back, including a usage row that this batch itself inserted. Success is a resolved `batch()`, not a later increment.

There is no code path that calls `fetch` and then increments `gemini_requests_used`. A reservation that succeeds and whose later `fetch` throws still keeps the unit. Transport failure does not refund it. A same-day re-attempt does not refund or reuse the earlier request unit.

## Atomicity and concurrency

Do not `SELECT` the counters and then `UPDATE` them from application memory. The planning read only classifies candidates and fills the summary. Quota is spent only by the `batch()` reservation.

D1 serializes the batched write. `PRIMARY KEY (utc_date, evidence_id)` lets only one transaction create that admission. The loser’s `batch()` fails, rolls back its website increment and its request increment, and does not `fetch` for that failed reservation. Two overlapping callers therefore cannot both count evidence ID 200 as a new website on the same UTC date, and `websites_admitted` increases once for that ID. Each actual Gemini HTTP request still requires its own successful request reservation, so request units are not shared or spent after the call.

The cap trigger and `CHECK (websites_admitted <= 50)` reject a 51st distinct evidence ID. The request `UPDATE` rejects a unit past `GEMINI_DAILY_REQUEST_LIMIT` by failing the statement. A failed batch leaves neither the new identity nor the aggregate change. A committed batch leaves both. This slice does not take an evidence lease, claim, or work queue. Two runs that each reserve their own request unit can still both call Gemini for the same not-yet-persisted evidence. That duplicate-work limitation stays. The duplicate website charge does not.

A ledger exception after an earlier batch has already persisted does not roll back those persisted analyses or those spent units. The pipeline throws, and the Worker returns HTTP 500. No further Gemini request is sent.

## Batch request contract

`analyzeWebsitesWithGemini` accepts 1 through 5 `WebsiteFacts` values. The pipeline does not call it with any other length. The HTTP request keeps the DQ-032 transport:

- `POST https://generativelanguage.googleapis.com/v1/interactions`
- headers `content-type: application/json` and `x-goog-api-key`
- `store: false`
- `stream: false`
- abort at 30_000 ms
- the same `GEMINI_MODELS` order
- no Gemini SDK

`input` is `GEMINI_WEBSITE_BATCH_PROMPT`, a newline, and `JSON.stringify` of an array. Each array element uses the same fact fields `selectFacts` already sends for one website: `evidenceId`, `leadId`, `leadVersion`, `requestedUrl`, `finalUrl`, `title`, `metaDescription`, `documentLanguage`, `hasViewport`, `h1Count`, `headingCount`, `imageCount`, `imagesWithoutAlt`, `formCount`, `internalLinkCount`, `externalLinkCount`, and `visibleText`. Array order is the admission order, which is the DQ-035 evidence order.

The batch prompt keeps every current single-website rule and adds these rules: the input is a JSON array of website facts; return one JSON object whose only analysis collection is `analyses`; include one object for each supplied website; copy `evidenceId`, `leadId`, and `leadVersion` from that website; do not invent a website; do not merge websites; do not drop a valid website because another website cannot be analyzed. Do not change the text of `GEMINI_WEBSITE_ANALYSIS_PROMPT`.

`GEMINI_BATCH_RESPONSE_FORMAT` is an object schema. Its required property is `analyses`, an array of objects with the same required fields and finding schema as the current single-website schema. Do not change `GEMINI_RESPONSE_FORMAT`.

The function receives `fetch`, `firstRequestReserved: true` for a pipeline call, and `reserveNextRequest(): Promise<boolean>`. The first model iteration does not call `reserveNextRequest`. Each following iteration awaits `reserveNextRequest()` and returns without `fetch` when the result is false.

## Batch response contract

Read the completed body the way `readCandidate` does: status `completed`, the last `model_output` step, exactly one `text` content part, then `JSON.parse`. A failure at that layer is `GEMINI_INVALID_RESPONSE` for the whole batch and does not try another model.

The parsed text must be a plain object whose own enumerable properties are exactly `analyses`, and `analyses` must be an array. Anything else is an unparseable completed 2xx: `GEMINI_INVALID_RESPONSE`, no model fallback, and every website in the batch fails.

When the envelope is valid, ignore array position. Build each candidate key only from its own `evidenceId`, `leadId`, and `leadVersion`, using the same strict types `validateWebsiteAnalysis` requires: number, string, and number. Do not coerce. Do not assign by index. An element without that identity, or with an identity that is not in the input batch, is unexpected. It persists nothing and does not fail a sibling by itself. An expected website with no element fails. An expected website with two or more elements fails, and neither element is persisted. An expected website with exactly one element is validated against that website's `WebsiteFacts` only.

## Per-website validation

Call `validateWebsiteAnalysis(facts, candidate)` only for the single matched element of that facts value. `INVALID_ANALYSIS` and `ANALYSIS_IDENTITY_MISMATCH` fail that website. They do not try another model, do not retry the batch, and do not change another website's outcome. A validated analysis keeps the facts identity that was checked. Persistence receives that paired facts value and that candidate only.

## Partial-success behavior

A completed, parseable envelope with four valid matches and one missing, duplicate, mismatched, or malformed match persists the four and fails the one. The four successes use the responding model and the models attempted for that HTTP series. The failed website is not persisted. The batch is not sent again because of that one invalid output.

If the envelope cannot be parsed, there are no siblings to preserve. All websites in that batch fail together.

## Fallback behavior

Fallback stays inside `analyzeWebsitesWithGemini`. It follows the DQ-032 rules, plus request reservation:

- A thrown `fetch` or abort is transport failure. Reserve the next request unit, then try the next `GEMINI_MODELS` entry. If the reservation is not exactly one changed row, stop with request-budget exhaustion and do not `fetch`.
- A completed status outside 200–299 is `GEMINI_HTTP_ERROR` for the whole batch. Do not try another model.
- An unreadable interactions body or unparseable envelope is `GEMINI_INVALID_RESPONSE` for the whole batch. Do not try another model.
- Per-website validation failure is not model fallback.
- If every model transport-fails, throw `GEMINI_TRANSPORT_UNAVAILABLE`.
- `attemptedModels` lists only models for which `fetch` was called, in chain order. The successful model is the last of that list when the call completes.

The single-website function's fallback rules are unchanged because that function is unchanged.

## 90-second retry behavior

The pipeline copies the DQ-033 two-pass shape onto batches.

During the first pass, a batch that throws `GEMINI_TRANSPORT_UNAVAILABLE` is deferred. `retryAt` is the pipeline clock at that failure plus 90_000 ms. Other first-pass batches still run, subject to remaining `maxItems`, new-admission capacity, and request reservation. HTTP errors, invalid envelopes, per-website validation failures, and request-budget exhaustion are not deferred.

After the first pass, deferred batches run in the order they were reserved. For each one, sleep until `retryAt` if that time is still ahead. If the first pass already took longer than 90_000 ms, do not sleep. Then reserve one request unit on the UTC date at that moment. That reservation inserts no admission row. If the reservation batch fails, do not call Gemini, do not mark the websites `retried`, and fail them for this run. If the reservation succeeds, call `analyzeWebsitesWithGemini` for the same website list with the first retry request already reserved. Fallback inside that call reserves additional units one by one.

The retry does not insert `website_analysis_daily_admissions` rows and does not increment `websites_admitted` on either date. A retry that was admitted yesterday and whose request reservation runs after midnight charges only the new date's request counter. A new invocation after midnight is not this retry: it may create a new-date admission and consume a new website slot.

Retry success persists those valid websites with `retried: true`. A retry HTTP, envelope, or per-website validation failure is terminal, with `retried: true` only for websites whose retry HTTP request was sent. A second full transport failure is terminal `GEMINI_TRANSPORT_UNAVAILABLE` with `retried: true`. There is no third round.

Request-budget exhaustion during retry fallback sends no further request. Websites already sent on that retry round have `retried: true`. The pipeline does not start another deferred batch's Gemini call when the request budget is already exhausted.

## Budget-exhaustion behavior

Exhaustion is a failed reservation `batch()` or a next batch that cannot be composed. It is not a Gemini error and it is not `BUDGET_FAILED`.

- A next new evidence ID that does not fit in the remaining website slots is not reserved and is omitted from `selected` and `failed`.
- Request exhaustion stops the invocation before `fetch`, including when every website in the next batch already has today's admission and the website charge would be 0.
- After a batch has entered analysis, exhaustion during fallback or retry fails the websites in that batch that still have no valid analysis. They count as `failed`. They are not sent again in this run. No analysis row means a later same-day run may select them again without another website slot.
- Spent website slots and request units remain spent. This slice does not refund them.
- A thrown ledger or corrupt ledger fails the invocation with `BUDGET_FAILED` and sends no further Gemini request.

`stoppedReason` records the bound that prevented another batch. It is not a per-website error.

## Pipeline integration

`runD1WebsiteAnalysisPipeline(database, config, maxItems, options?)` remains the only production entry. `config.dailyRequestLimit` is required for every call, including `maxItems === 0`.

Order:

1. Invalid `maxItems` throws the existing `INVALID_REQUEST`. This check stays first.
2. A `dailyRequestLimit` that is not an integer from 1 through 10000 throws `INVALID_CONFIGURATION`. Do this before D1 and before Gemini.
3. `maxItems === 0` reads the current UTC ledger row, writes nothing, selects nothing, calls no analyzer, and persists nothing.
4. Otherwise read today's usage row. When no request unit remains, return the budget summary with `request_cap` and do not select.
5. Select at most `maxItems` eligible rows. A selection throw, or a result longer than `maxItems`, remains `SELECTION_FAILED`.
6. Reconstruct evidence and extract facts for those rows before any reservation. `CrawlEvidencePersistenceError` and `WebsiteFactsError` still propagate, and no quota is spent when they do.
7. Classify those evidence IDs against `website_analysis_daily_admissions` for the reservation's UTC date. Compose batches as specified in Website reservation. Reserve each batch, then analyze it. Finish the first pass and the retry pass before persistence.
8. Persist successes sequentially, in the order they entered this invocation, through the existing `persistD1WebsiteAnalysis`. Do not persist a website that failed or never entered a batch.
9. Return the frozen summary.

`selected` counts websites that entered a reserved Gemini batch in this invocation, including same-day re-attempts that added no website slot. On a successful return, `selected = succeeded + failed`, `persisted = succeeded`, and `0 <= retried <= selected`. `selected` is not required to equal the increase in `websites_admitted`. Candidates that never entered a batch are in none of those counters.

The pipeline options gain `now?: () => Date`. The existing `storedAt` and `analysisRunOptions` seams stay. Production `fetch` in the Worker still calls the pipeline with database, config, and `maxItems` only.

## Worker and config integration

`CrawlGatewayEnv` gains optional `GEMINI_DAILY_REQUEST_LIMIT?: string`.

The Worker parses the key and the limit with separate functions. The key rules are unchanged. The limit must match `^(?:[1-9][0-9]{0,4})$` and the numeric value must be from 1 through 10000. Missing, empty, signed, decimal, exponent, leading-zero, or out-of-range text is invalid. Do not trim. Do not default.

`handleAnalysis` keeps body validation before configuration. Invalid `maxItems` stays HTTP 400 even when configuration is missing. After the body is valid, an invalid key or an invalid limit is HTTP 500 `{ "error": "internal_error" }`, including when `maxItems` is 0. The error body does not say which setting failed and does not echo the limit or the key.

The frozen config passed into the pipeline is `{ provider: "gemini", apiKey, dailyRequestLimit }`. `loadConfig()` gets the same limit rule only on the Gemini provider path, so the Node config and the Worker config do not disagree. `WEBSITE_ANALYSIS_PROVIDER` absent or `disabled` does not require the limit.

`.env.example` may gain an empty non-secret `GEMINI_DAILY_REQUEST_LIMIT=` line. Do not put a production value in `wrangler.toml`. Do not store the limit with `wrangler secret put`. It is ordinary Worker configuration set at activation.

## Runtime response behavior

HTTP 200 still returns the five counters and adds one budget object. No analysis contents, prompts, keys, tokens, or raw model text are included.

```ts
type WebsiteAnalysisBudgetSummary = Readonly<{
  utcDate: string;
  websitesAdmitted: number;
  websiteLimit: 50;
  geminiRequestsUsed: number;
  geminiRequestLimit: number;
  stoppedReason: "max_items" | "no_evidence" | "website_cap" | "request_cap";
}>;
```

`websitesAdmitted` and `geminiRequestsUsed` are the current UTC row after this run's reservations, or 0 when no row exists. `websiteLimit` is always 50. `geminiRequestLimit` is the parsed runtime value. `utcDate` is the UTC date used for the response read.

Choose `stoppedReason` by the first matching rule:

1. `max_items` when `maxItems` is 0 or this invocation's `selected` count reached `maxItems`.
2. `request_cap` when another batch or the next Gemini request was not sent because no request unit remained. This includes a same-day re-attempt that needed zero website slots.
3. `website_cap` when the next candidate was a new evidence ID and no website slot remained. Already-admitted evidence that entered this invocation does not by itself produce `website_cap`.
4. `no_evidence` when `maxItems`, request units, and new website slots would still allow another website, but no eligible evidence remained.

A zero-run uses `max_items`. Its counters are all 0. Its budget object shows the stored day usage without having incremented it.

The Worker copies these fields explicitly, the same way it copies the five counters. A thrown pipeline is still HTTP 500 with `{ "error": "internal_error" }` and no partial summary.

## Persistence interaction

`persistD1WebsiteAnalysis` stays the persistence function. Call it only with a success whose candidate was validated against that same facts value. Call it in admission order, one awaited call at a time. A persistence throw remains `WebsiteAnalysisPersistenceError`. Earlier successes stay stored. Later successes in that invocation are not persisted. The Worker surfaces that throw as HTTP 500.

Failed, skipped, unexpected, and never-entered websites write no `website_analyses` row. The ledger is not rolled back when persistence fails. Multiple historical analyses for one `evidence_id` remain allowed. This slice does not add a unique index on `website_analyses`. The admission primary key is separate quota identity.

`storedAt` remains the pipeline clock already used by DQ-035, separate from the UTC date key. The date key is `YYYY-MM-DD`. `stored_at` remains the existing 24-character UTC timestamp.

## Failure semantics

| Situation | Gemini HTTP | Website slot | Request units | Run outcome |
| --- | --- | --- | --- | --- |
| `maxItems` 0 | none | none | none | HTTP 200 zero counters, limit validated |
| Invalid limit or key | none | none | none | HTTP 500 fixed body |
| Cap blocks a new evidence ID before it enters a batch | none for that website | none for that website | none for that website | HTTP 200, not counted in `selected` or `failed` |
| Same-day re-attempt of an evidence ID that already has today's admission | one per request actually sent | no additional slot | one per request sent, reserved before `fetch` | the website counts in `selected` |
| Request quota exhausted before a re-attempt | none | no additional slot | none | no `fetch`; `request_cap` |
| Batch reserved, then transport failure on every model | one per model actually sent | new identities stay; existing identities are not duplicated | one per request sent | defer the batch for one 90-second retry |
| Completed non-2xx | no further request after that response | new identities stay; existing identities are not duplicated | every request already sent stays consumed | whole batch fails, no fallback, no 90-second retry |
| Unparseable completed 2xx | no further request after that response | new identities stay; existing identities are not duplicated | every request already sent stays consumed | whole batch fails, no fallback, no 90-second retry |
| Four valid items and one bad item | no further request after that response | new identities stay; existing identities are not duplicated | every request already sent stays consumed | four persist, one fails, no batch retry |
| Fallback or retry cannot reserve the next request | no further request | already created identities stay | already reserved units stay consumed | unresolved websites in that batch fail; no further Gemini request |
| Reservation `batch()` fails | none for that proposal | no identity and no aggregate change from that `batch()` | no unit from that `batch()` | no `fetch` for that proposal |
| Ledger statement throws or the row is corrupt | no further request | prior committed reservations stay | prior committed reservations stay | `BUDGET_FAILED`, Worker HTTP 500 |
| In-flight retry reservation after midnight | only if the new-day request reservation succeeds | no admission row and no website increment on the new date | one unit on the new UTC date | same websites only |
| New invocation of the same evidence ID on the next UTC date | one per request actually sent | one new slot on the new date | one per request sent | a new admission row for the new date |

Known per-website failures do not abort later websites that are already admitted in a later batch unless the request budget is exhausted. An unexpected non-analyzer exception still propagates and stops the invocation. Do not catch it into a fake provider failure.

## Testing strategy

Use the existing offline tests. Do not call Gemini, do not use production D1, and do not put secret values in fixtures. The limit in fixtures is an ordinary integer such as `3` or `10`. Inject `fetch`, the clock, and `sleep`. Assert that a denied reservation performs no `fetch`. Prefer the existing Miniflare D1 integration style so a failed `batch()` rolls back identities and aggregate counters together.

Cover at least:

- batch length 5, batch length under 5, and no request body containing 50 websites
- 2 already-admitted evidence IDs and 3 new IDs in deterministic order: `websites_admitted` +3, `gemini_requests_used` +1, and all 5 are sent
- usage 49/50 with the next 5 candidates new: only the first is admitted and sent; the other 4 are not charged and not sent
- usage 50/50 with the next candidate already admitted and request quota remaining: `websites_admitted` +0, `gemini_requests_used` +1, and `fetch` runs
- usage 50/50 with the next candidate new: no `fetch` and no 51st admission row
- an evidence ID that failed earlier today is selected again: website counter +0, request counter +1 before `fetch`, and `selected` includes it
- two overlapping reservations of previously unseen evidence ID 200: one admission row, `websites_admitted` increases once, and each Gemini call still requires its own request reservation
- a failed reservation leaves neither the new admission row nor an aggregate increment
- after commit, `websites_admitted` equals the admission-row count for that UTC date
- a website slot remains consumed for transport failure, HTTP failure, invalid output, and validation failure
- fallback and the 90-second retry add request units and do not add admission rows
- no `fetch` when the request reservation fails, including midway through `GEMINI_MODELS` and when the website charge would be 0
- four valid siblings persist when one sibling is missing, duplicate, mismatched, or malformed
- an identity outside the batch persists nothing
- array order does not choose the website
- completed non-2xx and an unparseable 2xx do not call the next model
- transport failure calls the next model only after a successful request reservation
- full transport failure waits until failure plus 90_000 ms and retries the same batch once
- a clock step across `00:00Z` during an in-flight retry charges the new date's request counter, inserts no new-date admission, and leaves the previous website count unchanged
- a new invocation after midnight can admit the same evidence ID once on the new date
- reservations cannot take `websites_admitted` past 50 or `gemini_requests_used` past the bound limit
- lowering the limit needs no migration and blocks new request reservations when used units are already above it
- `maxItems === 0` validates a present limit, writes no ledger row, selects nothing, fetches nothing, and persists nothing
- a missing or invalid limit fails before D1 selection and before `fetch`
- the Worker success body has the five counters plus `budget`, and its fixed error bodies stay unchanged
- crawl authorization and crawl routes stay unchanged
- `analyzeWebsiteWithGemini` single-website fallback tests still describe the unchanged function

## Migration and production activation

This design does not apply SQL, set Worker configuration, deploy, or send a Gemini request.

The later activation order is: apply `migrations/0004_website_analysis_daily_usage.sql` to production D1 `delta-qoralis-crawl` before a Worker that reads these tables is deployed; set non-secret `GEMINI_DAILY_REQUEST_LIMIT` to an operator-chosen integer from 1 through 10000; keep the existing secret names `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, and `CRAWL_GATEWAY_TOKEN` as they are. Do not print or commit their values. Do not invent the production request-limit number in source.

After that activation, a `maxItems === 0` call is the configuration smoke. A `maxItems` greater than 0 call is a real budgeted analysis and is not part of this design document.

## Explicit exclusions

This slice does not add or design:

- DQ-038: cron, a scheduled Worker event, a GitHub Actions analysis workflow, automatic daily analysis, or automatic analysis after crawl
- DQ-039: run history, request history, error history, latency history, a token ledger, a cost ledger, or a monitoring dashboard
- OpenRouter, Groq, Cloudflare Workers AI, OpenAI, Anthropic, or any provider other than Gemini
- qualification, lead scoring, contact discovery, DNC expansion, email discovery, outreach, mailing, email sending, CRM, client conversion, website generation, payments, or subscriptions
- a refund of a consumed website slot or request unit
- a claim, lease, work queue, or Durable Object. `website_analysis_daily_admissions` is in scope and records only `(utc_date, evidence_id)` quota identity
- a change to crawl selection, crawl persistence, or crawl authentication
- a new public route, a change to `maxItems` bounds, or a second Worker

## Names aligned to source

| Concern | Repository name |
| --- | --- |
| Worker | `delta-qoralis-crawl-gateway` |
| Analysis route | `POST /internal/analysis/run` |
| Analysis secret | `ANALYSIS_GATEWAY_TOKEN` |
| Crawl secret | `CRAWL_GATEWAY_TOKEN` |
| Gemini credential | `GEMINI_API_KEY` |
| Request cap variable | `GEMINI_DAILY_REQUEST_LIMIT` |
| Pipeline | `runD1WebsiteAnalysisPipeline` |
| In-memory one-website run | `runWebsiteAnalysis` |
| One-website adapter | `analyzeWebsiteWithGemini` |
| Batch adapter | `analyzeWebsitesWithGemini` |
| Validator | `validateWebsiteAnalysis` |
| Persistence | `persistD1WebsiteAnalysis` |
| Models | `GEMINI_MODELS` |
| Interactions URL | `https://generativelanguage.googleapis.com/v1/interactions` |
| Analysis table | `website_analyses` |
| Ledger table | `website_analysis_daily_usage` |
| Admission identity | `website_analysis_daily_admissions` |
| Config type | `GeminiWebsiteAnalysisConfig` |
| D1 binding | `DB` |
