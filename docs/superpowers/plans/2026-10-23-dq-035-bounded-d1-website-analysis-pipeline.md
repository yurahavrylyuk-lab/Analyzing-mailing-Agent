# DQ-035 Bounded D1 Website Analysis Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect fetched crawl evidence in D1 to the existing website-facts, bounded-analysis, and analysis-persistence boundaries through one controlled 0–50 item pipeline.

**Architecture:** Add one bounded D1-backed orchestration function under the existing website-analysis boundary. It selects fetched crawl evidence with no existing analysis, reconstructs stored evidence through the existing crawl parser, derives WebsiteFacts, calls DQ-033 once, and persists successful terminal results through DQ-034. Add only the directly justified non-unique `website_analyses(evidence_id)` selection index; no scheduler, daily accounting, locking, new provider, or SQLite analysis store is introduced.

**Tech Stack:** TypeScript, Cloudflare D1 structural interfaces, SQL migrations, existing Miniflare/D1 integration test infrastructure, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-23-dq-035-bounded-d1-website-analysis-pipeline-design.md`

## Global Constraints

Every task includes this section.

- Implement only the approved spec and this plan. Do not edit the spec, this plan, `docs/PLAN.md`, or `docs/BACKLOG.md`. Do not start DQ-036.
- Builder execution creates `feature/dq-035-bounded-d1-website-analysis-pipeline` from the approved plan commit on `design/dq-035-bounded-d1-website-analysis-pipeline`. Do not implement on `main` or on the design branch.
- Do not commit, push, or open a pull request during Builder execution. Each task's commit command is the review boundary. Leave the work uncommitted until the Analyst records APPROVED.
- One orchestration function. One selection query. One error class. One result type. One new migration.
- Selection is `outcome = 'fetched'` and no `website_analyses` row for that evidence id. Order is `attempted_at ASC, id ASC`. `LIMIT` is the validated `maxItems`.
- `maxItems` is an integer and `0 <= maxItems <= 50`. Invalid values throw before any D1 `prepare`. `0` is valid and does no D1 work.
- 50 per run is not 50 per day.
- Reconstruct with exported `evidenceFromRow`. `EvidenceRow` stays private. Use the existing cast `row as unknown as Parameters<typeof evidenceFromRow>[0]`. Do not write a second parser. A corrupt selected row fails the pipeline. Do not skip it and do not map it to `SELECTION_FAILED`.
- Call `extractWebsiteFacts` for every reconstructed evidence value. Do not duplicate the HTML parser or invent a second facts model. No network request and no refetch.
- Call `runWebsiteAnalysis(facts, config, options?.analysisRunOptions)` exactly once, and only when the selection is non-empty. Do not reimplement Gemini transport, model fallback, the 90-second retry, retry ordering, known per-site failure handling, or duplicate-evidence validation.
- `runWebsiteAnalysis` writes each terminal item at the same index as its input and throws if an index is empty. A successful return cannot reorder or drop relative to the facts array it received. The pipeline passes facts in selection order and walks the returned array from first to last. Do not sort it and do not add a seam that feeds a reordered item array.
- Persist only `status: "succeeded"` items, sequentially, through `persistD1WebsiteAnalysis(database, item.result, storedAt)`. Do not `INSERT INTO website_analyses` from DQ-035. A `status: "failed"` item persists nothing and creates no failure-history row.
- Generate `storedAt` immediately before each successful persistence call. Default is `() => new Date().toISOString()`. Pass that string unchanged. Do not change `isCanonicalTimestamp` or any other DQ-034 code. A throwing `storedAt` callback propagates as itself.
- A persistence failure propagates `WebsiteAnalysisPersistenceError` and stops the loop. Earlier rows stay. No cross-row transaction, rollback, compensating delete, or DQ-035 retry.
- The successful return is a frozen counts object. Do not return `WebsiteAnalysisRunItem` values. Invariants: `selected === succeeded + failed`, `persisted === succeeded`, and `0 <= retried <= selected`. `retried` counts terminal items whose `retried` is `true`.
- `INVALID_REQUEST` is invalid `maxItems` only. `SELECTION_FAILED` is only a thrown selection query or a selection result longer than `maxItems`. Do not use it for corrupt evidence, facts extraction, DQ-033 propagation, DQ-034 persistence, or a clock callback. Do not attach `cause`. Do not leak SQL, D1 responses, HTML, analysis bodies, configuration, or credentials.
- Do not catch `CrawlEvidencePersistenceError`, `WebsiteFactsError`, `WebsiteAnalysisRunError`, `GeminiWebsiteAnalysisError`, `WebsiteAnalysisError`, or `WebsiteAnalysisPersistenceError` except where DQ-033 already caught a known analyzer error inside `runWebsiteAnalysis`.
- No Cloudflare SDK import. No `D1CrawlDatabase` import. Copy the structural `prepare` surface locally. The local database type must be assignable to `persistD1WebsiteAnalysis` without a cast.
- No repository, service, factory, DI container, scheduler, worker route, SQLite analysis store, lock, lease, claim, reservation, queue, or provider registry.
- Two concurrent runs may select the same evidence and both persist. That limitation is accepted. Do not add a test that tries to prevent it.
- Do not modify `migrations/0001_delta_qoralis_crawl.sql`, `migrations/0002_website_analysis.sql`, `src/crawler/**`, `src/website-analysis/facts.ts`, `src/website-analysis/run.ts`, `src/website-analysis/d1-analysis-store.ts`, `src/website-analysis/persistence-errors.ts`, the Gemini provider, `tests/integration/d1-website-analysis-store.test.ts`, `package.json`, `package-lock.json`, `wrangler.toml`, or `.github`. The existing DQ-034 test still applies only `0001` and `0002`, and it still asserts that those two files alone create no `evidence_id` index.
- Tests use `node:test` and `node:assert/strict`. No real Gemini call, no production D1, and no outbound network. Miniflare stays the existing devDependency, with `d1Persist: false`.
- This shell is zsh. `status` is read-only, so targeted commands use `exit_code`. `.test-build/` is gitignored. Do not add a package script.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one has the named test in the owning task.

1. **Validation before D1.** Invalid `maxItems` must not call `prepare`. Test: `invalid maxItems does not prepare a D1 statement` in Task 1.
2. **Corrupt selected evidence.** A malformed selected row is not skipped and is not `SELECTION_FAILED`. Test: `a corrupt selected row fails before analysis` in Task 1.
3. **Order stays at the pipeline boundary.** `runWebsiteAnalysis` cannot return a successful array in a different order from the facts it was given. The pipeline must hand it selection order and must not sort afterward. Test: `runWebsiteAnalysis receives facts in selected order` in Task 2. Task 3 test `successful items persist in original result order` checks that persistence walks that same array.
4. **Clock failures stay clock failures.** A throwing `storedAt` callback is not `SELECTION_FAILED`, and timestamps are not generated before the persistence loop. Test: `a storedAt callback failure leaves earlier rows durable` in Task 3.
5. **Partial persistence stays durable.** After a later `WebsiteAnalysisPersistenceError`, the next run does not select the rows already persisted. Test: `the next run excludes evidence persisted before a persistence failure` in Task 3.

## File structure

Create:

- `migrations/0003_website_analysis_selection.sql` — one non-unique index. One physical line, matching `migrations/0001_delta_qoralis_crawl.sql` and `migrations/0002_website_analysis.sql`.
- `src/website-analysis/pipeline-errors.ts` — `D1WebsiteAnalysisPipelineError`, its frozen code array, and `D1WebsiteAnalysisPipelineErrorCode`.
- `src/website-analysis/d1-analysis-pipeline.ts` — the database type, options, result, private selection SQL, and `runD1WebsiteAnalysisPipeline`.
- `tests/integration/d1-website-analysis-pipeline.test.ts` — schema, stub, and Miniflare tests. One file.

Modify:

- `src/website-analysis/index.ts` — append only the public exports listed below. Do not reorder the existing exports.

Do not create `repository.ts`, `service.ts`, `factory.ts`, a worker route, or a SQLite analysis module.

## Public contract

```ts
export const D1_WEBSITE_ANALYSIS_PIPELINE_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "SELECTION_FAILED",
] as const);

export type D1WebsiteAnalysisPipelineErrorCode =
  (typeof D1_WEBSITE_ANALYSIS_PIPELINE_ERROR_CODES)[number];

export class D1WebsiteAnalysisPipelineError extends Error {
  readonly name = "D1WebsiteAnalysisPipelineError";

  constructor(readonly code: D1WebsiteAnalysisPipelineErrorCode) {
    super(messages[code]);
  }
}

export type D1WebsiteAnalysisPipelineResult = Readonly<{
  selected: number;
  succeeded: number;
  failed: number;
  retried: number;
  persisted: number;
}>;

export type D1WebsiteAnalysisPipelineOptions = Readonly<{
  analysisRunOptions?: WebsiteAnalysisRunOptions;
  storedAt?: () => string;
}>;

export type D1WebsiteAnalysisPipelineDatabase = {
  prepare(sql: string): D1WebsiteAnalysisPipelineStatement;
};

export function runD1WebsiteAnalysisPipeline(
  database: D1WebsiteAnalysisPipelineDatabase,
  config: GeminiWebsiteAnalysisConfig,
  maxItems: number,
  options?: D1WebsiteAnalysisPipelineOptions,
): Promise<D1WebsiteAnalysisPipelineResult>;
```

`D1WebsiteAnalysisPipelineStatement` is private. It matches `D1CrawlStatement` and `D1WebsiteAnalysisStatement`: `bind(...values: readonly unknown[])` returns the statement; `all()` returns `Promise<{ readonly results: readonly Record<string, unknown>[] }>`; `first()` returns `Promise<Record<string, unknown> | null>`; `run()` returns `Promise<{ readonly meta: { readonly changes: number; readonly last_row_id: number } }>`.

Fixed messages, with no `cause`:

- `INVALID_REQUEST`: `D1 website analysis pipeline request is invalid.`
- `SELECTION_FAILED`: `D1 website analysis selection failed.`

`pipeline-errors.ts` exports the const, the type, and the class. `d1-analysis-pipeline.ts` exports the result, options, database type, and function. It imports the error from `./pipeline-errors`. It imports `evidenceFromRow` from `../crawler/database-evidence-repository`. It imports `extractWebsiteFacts` from `./facts`. It imports `runWebsiteAnalysis` and `WebsiteAnalysisRunOptions` from `./run`. It imports `persistD1WebsiteAnalysis` from `./d1-analysis-store`. It imports `GeminiWebsiteAnalysisConfig` from `../config/env`. It must not import `./index`.

`src/website-analysis/index.ts` adds only:

```ts
export { D1WebsiteAnalysisPipelineError } from "./pipeline-errors";
export type { D1WebsiteAnalysisPipelineErrorCode } from "./pipeline-errors";
export { runD1WebsiteAnalysisPipeline } from "./d1-analysis-pipeline";
export type {
  D1WebsiteAnalysisPipelineDatabase,
  D1WebsiteAnalysisPipelineOptions,
  D1WebsiteAnalysisPipelineResult,
} from "./d1-analysis-pipeline";
```

Do not export `D1_WEBSITE_ANALYSIS_PIPELINE_ERROR_CODES`, the statement type, the selection SQL, or row helpers from the barrel.

## Algorithm

`runD1WebsiteAnalysisPipeline` follows this order.

1. Validate `maxItems` before `database.prepare`. Accept only `typeof maxItems === "number" && Number.isInteger(maxItems) && maxItems >= 0 && maxItems <= 50`. `Number.isInteger` rejects `NaN`, `Infinity`, and fractional numbers. Anything else throws `new D1WebsiteAnalysisPipelineError("INVALID_REQUEST")`.
2. If `maxItems === 0`, return `Object.freeze({ selected: 0, succeeded: 0, failed: 0, retried: 0, persisted: 0 })`.
3. Prepare and bind the selection query below. `LIMIT` is bound to `maxItems`. Await `all()` inside a `try`. On rejection, throw `new D1WebsiteAnalysisPipelineError("SELECTION_FAILED")` and do not keep the caught value, its message, or a `cause`. This `try` wraps only that `all()` call.
4. If `results` is not an array, or `results.length > maxItems`, throw `SELECTION_FAILED`. Do not reconstruct those rows.
5. If `results.length === 0`, return the same frozen zero summary. Do not call `extractWebsiteFacts` or `runWebsiteAnalysis`.
6. Reconstruct every row, in array order, with `evidenceFromRow(row as unknown as Parameters<typeof evidenceFromRow>[0])`. Let that function throw. Do not catch it.
7. `const facts = evidence.map((item) => extractWebsiteFacts(item))`. Let `extractWebsiteFacts` throw. Do not catch it. Fetched evidence is the only selected outcome, so this is the DQ-030 call, not a new failure translator.
8. `const items = await runWebsiteAnalysis(facts, config, options?.analysisRunOptions)`. Call it once. Pass `options?.analysisRunOptions` through unchanged, including `undefined`.
9. Walk `items` from index 0 with `await` inside the loop. Do not use `Promise.all`.
10. For `status: "failed"`, add one to `failed`. If `item.retried` is `true`, add one to `retried`. Do not call `storedAt` and do not persist.
11. For `status: "succeeded"`, call `const storedAt = (options?.storedAt ?? defaultStoredAt)()` immediately before persistence. `defaultStoredAt` is `() => new Date().toISOString()`. If that call throws, the exception leaves the function. Then `await persistD1WebsiteAnalysis(database, item.result, storedAt)`. If that call throws, the exception leaves the function and later items are not processed. After it resolves, add one to `succeeded`, add one to `persisted`, and add one to `retried` when `item.retried` is `true`.
12. Return `Object.freeze({ selected: evidence.length, succeeded, failed, retried, persisted })`.

`selected` is the reconstructed evidence count. Because the real runner returns one terminal item per facts input, a successful return has `selected === succeeded + failed`. Do not add a new error code when the lengths match. Do not repair a mismatch by skipping or padding; the real runner does not produce one.

The private SQL is exactly:

```sql
SELECT id, lead_id, lead_version, outcome, requested_url, attempted_at,
       final_url, status_code, content_type, body_text, byte_length,
       redirect_count, failure_code
FROM single_page_crawl_evidence AS evidence
WHERE evidence.outcome = 'fetched'
  AND NOT EXISTS (
    SELECT 1
    FROM website_analyses AS analysis
    WHERE analysis.evidence_id = evidence.id
  )
ORDER BY evidence.attempted_at ASC, evidence.id ASC
LIMIT ?
```

Those columns are the `EvidenceRow` fields read by `evidenceFromRow`. Keep the SQL private. Formatting inside the template string may break lines. The statement text must contain this selection, this `NOT EXISTS`, this order, and `LIMIT ?`.

Task 1 may return after reconstruction with `succeeded`, `failed`, `retried`, and `persisted` still `0`. Task 2 replaces that return with the runner counts and leaves `persisted` at `0`. Task 3 adds the persistence loop. Task 1 tests must not assert those temporary zeros for a non-empty run. The final function matches the algorithm above, including `persisted === succeeded` on a successful return.

## Test command

Targeted command, from the repository root:

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/integration/d1-website-analysis-pipeline.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

`package.json` has no DQ-035 script. `npm test` is `node scripts/run-tests.cjs`. `npm run typecheck` is `tsc --noEmit`. Use those only in the final verification.

### Task 1: Selection index and bounded eligibility

**Files:**
- Create: `migrations/0003_website_analysis_selection.sql`
- Create: `src/website-analysis/pipeline-errors.ts`
- Create: `src/website-analysis/d1-analysis-pipeline.ts`
- Create: `tests/integration/d1-website-analysis-pipeline.test.ts`
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts`

**Interfaces:**
- Consumes: `migrations/0001_delta_qoralis_crawl.sql`, `migrations/0002_website_analysis.sql`, `evidenceFromRow`, and the Miniflare shape in `tests/integration/d1-website-analysis-store.test.ts`.
- Produces: the index, the error class, and a pipeline that validates `maxItems`, selects, and reconstructs. Analysis and persistence counts are still the temporary zeros described above.

- [ ] **Step 1: Write the failing Task 1 tests**

Create the test file. Import `strict as assert` from `node:assert`, `readFileSync` from `node:fs`, `join` from `node:path`, and `test` from `node:test`. Import `Miniflare` from `miniflare`. Import `runD1WebsiteAnalysisPipeline` and `D1WebsiteAnalysisPipelineError` from `../../src/website-analysis/d1-analysis-pipeline` and `../../src/website-analysis/pipeline-errors`. Import `CrawlEvidencePersistenceError` from `../../src/crawler/evidence-domain`. Do not import the barrel yet.

Copy the Miniflare helper shape from `tests/integration/d1-website-analysis-store.test.ts`: `modules: true`, an inline script returning `new Response("ok")`, `d1Databases: { DB: "delta-qoralis-test" }`, `d1Persist: false`, `dispose` in `finally`, and no outbound service. `exec` `migrations/0001_delta_qoralis_crawl.sql`, then `migrations/0002_website_analysis.sql`, then `migrations/0003_website_analysis_selection.sql`.

Add local helpers for one manual lead and one evidence row. Use lead id `00000000-0000-4000-8000-000000000001`, `lead_version` 4, and requested URL `https://example.com/a`. A fetched row uses that URL as `final_url`, status 200, `text/html`, a body whose byte length matches `Buffer.byteLength`, and redirect count 0. A failed row uses `failure_code` `TIMEOUT` and null fetched columns. The evidence helper takes `attemptedAt` so tests can control order. Do not import the crawler store.

Use Gemini config `{ provider: "gemini", apiKey: "test-key" }`. The key must never reach a network call.

Write these tests:

`the evidence index is non-unique and allows a second analysis` applies the three migrations, inserts a lead and fetched evidence, inserts two `website_analyses` rows for that evidence id, and asserts both `last_row_id` values are positive and different. `PRAGMA index_list('website_analyses')` contains `website_analyses_evidence_id_idx` with `unique` `0`. `sqlite_master` SQL for that index contains `CREATE INDEX` and does not contain `UNIQUE`. No other new index is present.

`invalid maxItems does not prepare a D1 statement` uses a database whose `prepare` increments a counter and throws `new Error("prepare called")`. For each of `-1`, `51`, `1.5`, `Number.NaN`, `Number.POSITIVE_INFINITY`, and `"1" as unknown as number`, the pipeline rejects with `D1WebsiteAnalysisPipelineError` code `INVALID_REQUEST`, message `D1 website analysis pipeline request is invalid.`, and the counter stays `0`.

`maxItems 0 returns a frozen zero summary without D1 work` uses that same throwing database. `maxItems` `0` returns `{ selected: 0, succeeded: 0, failed: 0, retried: 0, persisted: 0 }`, `Object.isFrozen` is true, and `prepare` was not called.

`maxItems 1 and 50 select only that many eligible rows` inserts three fetched rows and asserts `maxItems` `1` returns `selected` `1`. It inserts 50 fetched rows in another database and asserts `maxItems` `50` returns `selected` `50`. Do not assert `succeeded` or `persisted` here.

`only fetched evidence without an analysis is selected` inserts one fetched row, one failed row, and one fetched row that already has a `website_analyses` row. `maxItems` `50` returns `selected` `1`.

`a D1 selection failure is SELECTION_FAILED` uses a statement whose `all()` rejects with `new Error("d1 exploded: secret sql")`. The rejection is `D1WebsiteAnalysisPipelineError` code `SELECTION_FAILED`, message `D1 website analysis selection failed.`, with no `cause` and no message text from the driver. A second stub returns two valid fetched rows when `maxItems` is `1`. That rejection is also `SELECTION_FAILED`, which pins the length check before `evidenceFromRow`.

`a corrupt selected row fails before analysis` returns one row from `all()` with `outcome` `"fetched"`, `final_url` `null`, and the other fetched columns `null`. The rejection is `CrawlEvidencePersistenceError`, not `D1WebsiteAnalysisPipelineError`.

`an empty eligible set returns a frozen zero summary` runs `maxItems` `5` against a migrated database with a lead and no evidence. The summary is the frozen zeros.

- [ ] **Step 2: Run the targeted command and confirm RED**

Expected: FAIL. TypeScript reports `TS2307` because `../../src/website-analysis/d1-analysis-pipeline` or `pipeline-errors` does not exist. `node --test` does not run.

- [ ] **Step 3: Write the minimal Task 1 implementation**

Create `migrations/0003_website_analysis_selection.sql` as one line:

```sql
CREATE INDEX website_analyses_evidence_id_idx ON website_analyses(evidence_id);
```

Create `pipeline-errors.ts` with the frozen codes, fixed messages, `readonly name`, and `constructor(code)`. Do not add `cause`.

Create `d1-analysis-pipeline.ts` with the public types and function. Implement steps 1 through 6 of the algorithm. After reconstruction, return the frozen object with `selected: evidence.length` and the other four counts at `0`. Return the frozen zero summary for `maxItems === 0` and for an empty selection. Do not call `extractWebsiteFacts`, `runWebsiteAnalysis`, or `persistD1WebsiteAnalysis` yet.

- [ ] **Step 4: Run the targeted command and confirm GREEN**

Expected: PASS, with only the Task 1 tests present.

- [ ] **Step 5: Run the DQ-034 regression**

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/integration/d1-website-analysis-store.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

Expected: PASS. That file must still prove `0002` alone has no `evidence_id` index.

- [ ] **Step 6: Commit checkpoint**

```bash
git add migrations/0003_website_analysis_selection.sql src/website-analysis/pipeline-errors.ts src/website-analysis/d1-analysis-pipeline.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: select eligible D1 evidence for analysis"
```

Do not run this commit during Builder execution.

### Task 2: Facts, one DQ-033 call, and the count summary

**Files:**
- Modify: `src/website-analysis/d1-analysis-pipeline.ts`
- Modify: `tests/integration/d1-website-analysis-pipeline.test.ts`
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1 selection, `extractWebsiteFacts`, and `runWebsiteAnalysis`.
- Produces: one real DQ-033 call and `succeeded`, `failed`, and `retried` counts. `persisted` stays `0` until Task 3. Do not assert `persisted === 0` for a run that has successes.

- [ ] **Step 1: Write the failing Task 2 tests**

Extend the same test file. Import `GeminiWebsiteAnalysisError` and the `GeminiWebsiteAnalysisResult` type from `../../src/website-analysis/providers/gemini`. Import the `WebsiteFacts` type from `../../src/website-analysis/facts`. Add an `analyze` helper that records each `WebsiteFacts` value and the config reference, then returns a `GeminiWebsiteAnalysisResult` whose `analysis.evidenceId`, `leadId`, and `leadVersion` copy the facts. `provider` is `"gemini"`, `model` is `"gemini-3.8-flash"`, `attemptedModels` is `["gemini-3.8-flash"]`, `summary` is a trimmed 1..800 string, and `findings` is `[]`. This helper must not call `fetch`.

Write these tests:

`runWebsiteAnalysis receives facts in selected order` stores bodies `<title>Older</title><p>Older page</p>` and `<title>Newer</title><p>Newer page</p>`. Insert the newer `attempted_at` first so its id is smaller, then insert the older `attempted_at`. Call the pipeline with `maxItems` `50` and `analysisRunOptions.analyze` set to the recorder. The recorder sees exactly two calls, the older evidence id first, each facts value's `title` and visible text come from that row's HTML, and each call receives the same config object. `selected` is `2`, `succeeded` is `2`, `failed` is `0`, `retried` is `0`, and `selected === succeeded + failed`.

`maxItems 1 keeps the oldest eligible evidence` uses those same two rows and asserts the single `analyze` call receives the older evidence id.

`extractWebsiteFacts is applied to every selected row` is covered by the title and visible-text assertions above. Do not add a second facts parser or a mock of `extractWebsiteFacts`.

`analysisRunOptions are forwarded to runWebsiteAnalysis` makes the first `analyze` call throw `new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE")` and the retry succeed. Pass `now: () => 1_000` and a `sleep` that records its argument and resolves. The pipeline returns `retried` `1` and `succeeded` `1`. `sleep` was called once with `90_000`. `analyze` was called twice for that one site. That retry behavior exists only inside `runWebsiteAnalysis`, so this is the proof the pipeline called it rather than reimplementing analysis.

`runWebsiteAnalysis is invoked once` uses three eligible rows and a succeeding `analyze`. `analyze` is called exactly three times. A second runner call would double that count.

`an empty selection does not analyze or persist` inserts no eligible evidence, passes an `analyze` that records calls, and asserts the recorder stayed empty, `website_analyses` has no rows, and the summary is the frozen zeros. `runWebsiteAnalysis([])` would also avoid `analyze`, so this test pairs with the pinned early return. Do not add a `run` option to make the empty call observable.

`a known Gemini failure stays on that website` makes `analyze` throw `new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR")`. The summary is `selected` `1`, `succeeded` `0`, `failed` `1`, `retried` `0`. The error does not escape.

`an unexpected analyzer error escapes` makes `analyze` throw `new Error("boom")`. The same error object escapes and is not a `D1WebsiteAnalysisPipelineError`.

`the completed summary is frozen` asserts `Object.isFrozen` on the successful two-row summary.

- [ ] **Step 2: Run the targeted command and confirm RED**

Expected: FAIL. The new order test fails because Task 1 never calls `analyze` and still reports `succeeded` `0`.

- [ ] **Step 3: Write the minimal Task 2 implementation**

Replace the post-reconstruction return with steps 7, 8, and the counting loop from the algorithm. Leave `persisted` at `0` and do not call `persistD1WebsiteAnalysis` yet. Keep the empty-selection return before `extractWebsiteFacts` and `runWebsiteAnalysis`. Pass `options?.analysisRunOptions` through unchanged.

- [ ] **Step 4: Run the targeted command and confirm GREEN**

Expected: PASS, including the Task 1 tests.

- [ ] **Step 5: Commit checkpoint**

```bash
git add src/website-analysis/d1-analysis-pipeline.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: run one bounded D1 website analysis"
```

Do not run this commit during Builder execution.

### Task 3: Successful-only persistence, partial recovery, and public exports

**Files:**
- Modify: `src/website-analysis/d1-analysis-pipeline.ts`
- Modify: `src/website-analysis/index.ts`
- Modify: `tests/integration/d1-website-analysis-pipeline.test.ts`
- Test: `tests/integration/d1-website-analysis-pipeline.test.ts`

**Interfaces:**
- Consumes: Task 2's ordered `WebsiteAnalysisRunItem[]` and `persistD1WebsiteAnalysis`.
- Produces: sequential successful persistence, the final count invariants, and the barrel exports.

- [ ] **Step 1: Write the failing Task 3 tests**

Change the pipeline import in the test file to the barrel `../../src/website-analysis`, including `D1WebsiteAnalysisPipelineError`, `WebsiteAnalysisPersistenceError`, `runD1WebsiteAnalysisPipeline`, and the type `D1WebsiteAnalysisPipelineResult`. Keep importing `CrawlEvidencePersistenceError` from the crawler module. Keep the Gemini and facts imports on their concrete modules.

Add a `storedAt` helper that returns a queue of canonical timestamps, one per call, such as `2026-10-23T01:02:03.004Z` and `2026-10-23T05:06:07.008Z`.

Write these tests:

`successful items persist and failed items do not` selects two fetched rows. `analyze` succeeds for the older row and throws `GeminiWebsiteAnalysisError` `GEMINI_HTTP_ERROR` for the newer row. The summary is `selected` `2`, `succeeded` `1`, `failed` `1`, `persisted` `1`, and `succeeded + failed === selected`. `website_analyses` has one row. Its `evidence_id` is the older id, its `stored_at` equals the one timestamp the callback returned, and its `summary` is the successful result's summary. The failed evidence id has no analysis row.

`successful items persist in original result order` succeeds for both rows. The callback returns the two timestamps above, in that order. The two `website_analyses` rows, ordered by `id ASC`, have the older evidence id with the first timestamp and the newer evidence id with the second timestamp. `persisted` is `2`. `storedAt` was called twice, not once for the whole batch and not for the failed path.

`the default storedAt is a canonical timestamp` omits `options.storedAt` for one success. The stored `stored_at` matches `YYYY-MM-DDTHH:mm:ss.sssZ`.

`a storedAt callback failure leaves earlier rows durable` succeeds for three rows. The callback returns two canonical timestamps and throws `new Error("clock failed")` on the third call. The rejection is that same error, not `D1WebsiteAnalysisPipelineError`. Exactly two `website_analyses` rows exist. This fails if the pipeline generates every timestamp before persisting the first row.

`a persistence failure propagates and keeps earlier rows` succeeds for three rows. The callback returns two canonical timestamps and then `"not-a-timestamp"`. The rejection is `WebsiteAnalysisPersistenceError` code `PERSISTENCE_FAILED`. Exactly two analysis rows exist. No third row exists.

`the next run excludes evidence persisted before a persistence failure` performs both runs inside one Miniflare database. The first run has three successes and a `storedAt` callback that returns two canonical timestamps and then `"not-a-timestamp"`. Catch the `WebsiteAnalysisPersistenceError`. The second run uses a valid `storedAt` and `maxItems` `50`. Its `analyze` calls see only the evidence id that was not persisted, and its summary has `selected` `1` and `persisted` `1`. Do not depend on rows left by another test.

`a failed analysis remains eligible later` fails the only row with `GEMINI_HTTP_ERROR`, asserts no analysis row, then runs again with a succeeding `analyze`. The second run selects that same evidence id and persists one row.

`the summary object is frozen after persistence` asserts `Object.isFrozen` on a successful persisted summary.

`public pipeline exports are the barrel contract` imports the function, error, and types from `../../src/website-analysis` and assigns a `D1WebsiteAnalysisPipelineResult` local. This test fails at compile time until the barrel exports exist.

- [ ] **Step 2: Run the targeted command and confirm RED**

Expected: FAIL. TypeScript reports `TS2305` or `TS2724` because the barrel does not export `runD1WebsiteAnalysisPipeline`. `node --test` does not run.

- [ ] **Step 3: Write the minimal Task 3 implementation**

Replace the Task 2 counting loop with steps 9 through 12 of the algorithm. Call `persistD1WebsiteAnalysis` only for succeeded items. Generate `storedAt` inside that branch, immediately before the call. Do not wrap `storedAt()` or `persistD1WebsiteAnalysis` in the selection `try`. Do not insert analysis SQL from this file.

Append the barrel exports to `src/website-analysis/index.ts` exactly as listed under Public contract.

- [ ] **Step 4: Run the targeted command and confirm GREEN**

Expected: PASS, including the Task 1 and Task 2 tests.

- [ ] **Step 5: Commit checkpoint**

```bash
git add src/website-analysis/d1-analysis-pipeline.ts src/website-analysis/index.ts tests/integration/d1-website-analysis-pipeline.test.ts
git commit -m "feat: persist successful D1 analysis pipeline results"
```

Do not run this commit during Builder execution.

## Explicit exclusions

DQ-035 does not add a scheduler, cron, GitHub Actions analysis workflow, Worker analysis endpoint, or production deployment. It does not add 50/day accounting, daily usage storage, or provider quota tracking. It does not add failure history, an attempt table, or a cross-run retry limit. It does not add a lock, lease, claim, reservation, queue, background worker, or concurrency framework. It does not add SQLite analysis persistence, a new HTML or facts parser, a new Gemini adapter, cross-provider fallback, Groq, Cloudflare Workers AI, or OpenRouter. It does not add qualification, lead scoring, contact discovery, DNC execution, outreach, or email sending. It does not add token, cost, or latency accounting. It does not add a generic repository, a generic persistence framework, a service container, a factory, or dependency injection. It does not implement DQ-036.

The accepted concurrency limitation stays documented only. Do not solve it.

## Final verification

After Task 3 is green, run:

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/integration/d1-website-analysis-pipeline.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

```bash
npm test
```

```bash
npm run typecheck
```

```bash
git diff --check
```

Expected: the focused file passes, `npm test` passes, `npm run typecheck` passes, and `git diff --check` prints nothing. Do not update `docs/PLAN.md` or `docs/BACKLOG.md` in this implementation.
