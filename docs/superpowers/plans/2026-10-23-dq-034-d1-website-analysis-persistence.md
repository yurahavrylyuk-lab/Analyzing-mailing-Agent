# DQ-034 D1 Website Analysis Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist successful Gemini website analyses as immutable historical records in Cloudflare D1 with exact crawl-evidence identity validation and defensive read-back verification.

**Architecture:** Add one append-only D1 table and one narrow D1 persistence primitive under the existing website-analysis boundary. The primitive verifies referenced fetched crawl evidence, verifies evidence/lead/version identity, inserts the validated analysis plus selected Gemini provenance, reads the inserted row back, validates it, and returns an immutable `StoredWebsiteAnalysis`. No repository abstraction, SQLite implementation, DQ-033 wiring, scheduler, Worker route, or qualification behavior is added.

**Tech Stack:** TypeScript, Cloudflare D1 structural interfaces, SQL migrations, Node test runner / existing project test stack.

**Spec:** `docs/superpowers/specs/2026-10-23-dq-034-d1-website-analysis-persistence-design.md`

## Global Constraints

Every task includes this section.

- D1 is the only analysis persistence target.
- Persist successful `GeminiWebsiteAnalysisResult` values only.
- Multiple rows for the same `evidence_id` are allowed.
- No `UNIQUE(evidence_id)`.
- `website_analyses` is append-only.
- `UPDATE` and `DELETE` are blocked at the database level.
- The referenced `single_page_crawl_evidence` row must exist.
- Referenced crawl evidence must have `outcome = "fetched"`.
- `analysis.evidenceId` must exactly match `evidence.id`.
- `analysis.leadId` must exactly match `evidence.lead_id`.
- `analysis.leadVersion` must exactly match `evidence.lead_version`.
- `storedAt` is explicit input.
- The persistence primitive must not generate its own timestamp.
- `storedAt` uses `YYYY-MM-DDTHH:mm:ss.sssZ`.
- `findings_json` and `attempted_models_json` are JSON text.
- `provider` is exactly `"gemini"`.
- `model` must be an existing `GeminiModel`.
- Read-back validation is mandatory.
- No SQLite analysis persistence, repository abstraction, generic persistence framework, DQ-033 wiring, batch persistence API, Worker route, scheduler, GitHub Actions analysis workflow, qualification, contact discovery, outreach, token/cost/latency accounting, speculative indexes, findings child table, or new provider.
- Implement only the approved spec and this plan. Do not edit the spec or this plan. Do not start DQ-035.
- Builder execution creates `feature/dq-034-d1-website-analysis-persistence` from the approved plan commit on `design/dq-034-d1-website-analysis-persistence`. Do not implement on `main` or on the design branch.
- Do not modify `src/crawler/migration.ts`, `src/crawler/d1-crawl-store.ts`, `src/website-analysis/analysis.ts`, `src/website-analysis/run.ts`, the Gemini provider, `package.json`, `package-lock.json`, `wrangler.toml`, or `.github`. Local SQLite migrations stay unrelated.
- Do not edit `docs/PLAN.md` or `docs/BACKLOG.md`. DQ-034 remains Planned. Do not mark DQ-034 Completed.
- Do not import Cloudflare SDK types. Do not import `D1CrawlDatabase`. Copy its structural surface locally.
- Do not call `analyzeWebsiteWithGemini`, `runWebsiteAnalysis`, `extractWebsiteFacts`, `fetch`, `Date.now`, or `new Date` from the persistence primitive.
- Tests use `node:test` and `node:assert/strict`. `npm test` is `node scripts/run-tests.cjs`. `npm run typecheck` is `tsc --noEmit`. No live Gemini call, no production D1, and no outbound Miniflare network. Miniflare stays the existing devDependency, with `d1Persist: false`.
- This shell is zsh. `status` is read-only, so targeted commands use `exit_code`. `.test-build/` is gitignored. Do not add a package script.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one has the named test in the owning task.

1. **Evidence gate.** A missing row and a non-fetched row are different codes, and neither inserts. Tests: `missing evidence is EVIDENCE_NOT_FOUND` and `failed evidence is EVIDENCE_NOT_ANALYZABLE` in Task 2.
2. **Exact identity.** A mismatch is not repaired. Test: `evidence lead and version mismatches are ANALYSIS_IDENTITY_MISMATCH` in Task 2.
3. **Mandatory read-back.** The return value comes from the selected row, and a missing or corrupt row fails. Tests: `read-back returns the stored row`, `missing read-back row is PERSISTENCE_FAILED`, and `corrupt findings_json is PERSISTENCE_FAILED` in Task 2.
4. **Append-only history.** The same evidence can gain another row, and the database rejects `UPDATE` and `DELETE`. Tests: `a second raw insert for the same evidence is allowed` and `update and delete are rejected` in Task 1. Test: `a second persistence creates a different id` in Task 3.
5. **Caller timestamp and attempt order.** An invalid `storedAt` makes no database call. The successful model must be the last attempted model. Tests: `invalid storedAt is PERSISTENCE_FAILED` and `successful model must be the final attempted model` in Task 2.

## File structure

Create:

- `migrations/0002_website_analysis.sql` — D1 table `website_analyses` and its two append-only triggers. Production style follows `migrations/0001_delta_qoralis_crawl.sql`: each statement is one physical line. Do not add this table to `src/crawler/migration.ts`.
- `src/website-analysis/persistence-errors.ts` — `WebsiteAnalysisPersistenceError`, its frozen code array, and `WebsiteAnalysisPersistenceErrorCode`.
- `src/website-analysis/d1-analysis-store.ts` — `D1WebsiteAnalysisDatabase`, `StoredWebsiteAnalysis`, and `persistD1WebsiteAnalysis`. The row parser stays private in this file.
- `tests/integration/d1-website-analysis-store.test.ts` — schema tests, stubbed failure tests, and Miniflare round-trip tests. One file. Do not add a unit file that repeats these cases.

Modify:

- `src/website-analysis/index.ts` — export only the public contract listed below. Append it after the existing DQ-033 exports. Do not reorder the existing exports.

`StoredWebsiteAnalysis` lives in `d1-analysis-store.ts`, beside the D1 function. It does not get a new generic domain module. The error file matches the existing `analysis-errors.ts` split. Do not create `repository.ts`, `repository-interface.ts`, `factory.ts`, `service.ts`, `provider-registry.ts`, or `storage-manager.ts`.

## Public contract

```ts
export const WEBSITE_ANALYSIS_PERSISTENCE_ERROR_CODES = Object.freeze([
  "EVIDENCE_NOT_FOUND",
  "EVIDENCE_NOT_ANALYZABLE",
  "ANALYSIS_IDENTITY_MISMATCH",
  "PERSISTENCE_FAILED",
] as const);

export type WebsiteAnalysisPersistenceErrorCode =
  (typeof WEBSITE_ANALYSIS_PERSISTENCE_ERROR_CODES)[number];

export class WebsiteAnalysisPersistenceError extends Error {
  readonly name = "WebsiteAnalysisPersistenceError";

  constructor(readonly code: WebsiteAnalysisPersistenceErrorCode) {
    super(messages[code]);
  }
}

export type StoredWebsiteAnalysis = Readonly<{
  id: number;
  evidenceId: number;
  leadId: string;
  leadVersion: number;
  summary: string;
  findings: readonly WebsiteAnalysisFinding[];
  provider: "gemini";
  model: GeminiModel;
  attemptedModels: readonly GeminiModel[];
  storedAt: string;
}>;

export type D1WebsiteAnalysisDatabase = {
  prepare(sql: string): D1WebsiteAnalysisStatement;
};

export function persistD1WebsiteAnalysis(
  database: D1WebsiteAnalysisDatabase,
  result: GeminiWebsiteAnalysisResult,
  storedAt: string,
): Promise<StoredWebsiteAnalysis>;
```

`D1WebsiteAnalysisStatement` is the same private surface as `D1CrawlStatement`: `bind(...values: readonly unknown[])` returns the statement; `all()` returns `Promise<{ readonly results: readonly Record<string, unknown>[] }>`; `first()` returns `Promise<Record<string, unknown> | null>`; `run()` returns `Promise<{ readonly meta: { readonly changes: number; readonly last_row_id: number } }>`. Do not export the statement type.

Fixed messages, with no `cause`:

- `EVIDENCE_NOT_FOUND`: `Crawl evidence was not found.`
- `EVIDENCE_NOT_ANALYZABLE`: `Crawl evidence is not analyzable.`
- `ANALYSIS_IDENTITY_MISMATCH`: `Website analysis identity does not match the crawl evidence.`
- `PERSISTENCE_FAILED`: `Website analysis persistence failed.`

`src/website-analysis/index.ts` adds only:

```ts
export { WebsiteAnalysisPersistenceError } from "./persistence-errors";
export type { WebsiteAnalysisPersistenceErrorCode } from "./persistence-errors";
export { persistD1WebsiteAnalysis } from "./d1-analysis-store";
export type {
  D1WebsiteAnalysisDatabase,
  StoredWebsiteAnalysis,
} from "./d1-analysis-store";
```

Do not export `WEBSITE_ANALYSIS_PERSISTENCE_ERROR_CODES` or the row parser from the barrel. `d1-analysis-store.ts` imports the error from `./persistence-errors` and `GEMINI_MODELS`, `GeminiModel`, and `GeminiWebsiteAnalysisResult` from `./providers/gemini`. It imports `WebsiteAnalysisFinding` from `./analysis`. It must not import `./index`.

## Algorithm

`persistD1WebsiteAnalysis` follows this order. Do not normalize or repair a bad value.

1. Validate `storedAt` before `database.prepare`. Reject with `PERSISTENCE_FAILED` unless it is already canonical UTC: length 24, shape `YYYY-MM-DDTHH:mm:ss.sssZ`, month 1..12, day valid for that month and year, hour 0..23, minute 0..59, second 0..59. Use Gregorian leap years: divisible by 4, except centuries, which must be divisible by 400. `2024-02-29` is valid. `2023-02-29` and `1900-02-29` are not. Do not call `Date.now`, `new Date`, or `Date.parse`. Do not rewrite the string.
2. `SELECT id, lead_id, lead_version, outcome FROM single_page_crawl_evidence WHERE id = ?` bound to `result.analysis.evidenceId`. A thrown `first()` is `PERSISTENCE_FAILED`. No row is `EVIDENCE_NOT_FOUND`. `outcome !== "fetched"` is `EVIDENCE_NOT_ANALYZABLE`, including `failed` and any other value.
3. Require `result.analysis.evidenceId === evidence.id`, `result.analysis.leadId === evidence.lead_id`, and `result.analysis.leadVersion === evidence.lead_version`. Any miss is `ANALYSIS_IDENTITY_MISMATCH`. Do not coerce types and do not copy the row identity over the result.
4. Require `result.provider === "gemini"`, `result.model` to be a member of `GEMINI_MODELS`, `result.attemptedModels` to be a non-empty array whose every entry is a member of `GEMINI_MODELS`, and the last entry to be `result.model`. Otherwise `PERSISTENCE_FAILED` and do not insert. Do not sort the array and do not require it to equal the current `GEMINI_MODELS` prefix.
5. `findings_json = JSON.stringify(result.analysis.findings)` and `attempted_models_json = JSON.stringify(result.attemptedModels)`. No replacer, no key sort, no hash, and no compression.
6. `INSERT INTO website_analyses (evidence_id, lead_id, lead_version, summary, findings_json, provider, model, attempted_models_json, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`. Bind `result.analysis.evidenceId`, `result.analysis.leadId`, `result.analysis.leadVersion`, `result.analysis.summary`, the two JSON strings, `result.provider`, `result.model`, and the original `storedAt`.
7. A thrown `run()` is `PERSISTENCE_FAILED`. Require `meta.changes === 1`. Require `meta.last_row_id` to satisfy `typeof value === "number" && Number.isSafeInteger(value) && value > 0`. A bigint, zero, negative, or unsafe id is `PERSISTENCE_FAILED`. This is the same positive-id rule as `isStoredRowId` in `src/crawler/d1-crawl-store.ts`.
8. `SELECT id, evidence_id, lead_id, lead_version, summary, findings_json, provider, model, attempted_models_json, stored_at FROM website_analyses WHERE id = ?` bound to that inserted id. A thrown `first()` or a null row is `PERSISTENCE_FAILED`.
9. Parse and validate the row. `JSON.parse` `SyntaxError` becomes `PERSISTENCE_FAILED` with no `cause`. Any other unexpected throw propagates. Rebuild a new frozen object. Require its `id` to equal the inserted id.
10. Return that frozen `StoredWebsiteAnalysis`.

Database catches wrap only the awaited `first()` or `run()`. They map every rejection to `new WebsiteAnalysisPersistenceError("PERSISTENCE_FAILED")` and do not keep the caught value, its message, or a `cause`. Do not use the SQLite `SqliteError` check from `database-evidence-repository.ts`: D1 rejects with an ordinary `Error`, and `persistD1CrawlEvidence` maps that rejection to `PERSISTENCE_FAILED`. Do not wrap identity checks or the parser in that database catch. Do not wrap the whole function in one `try`.

The private parser rejects, with `PERSISTENCE_FAILED`, an invalid `id`, `evidence_id`, `lead_id`, or `lead_version`; a summary that is not a string, is empty, is longer than 800, or differs from `summary.trim()`; unparseable or structurally invalid `findings_json`; an invalid `provider`; an invalid `model`; unparseable or structurally invalid `attempted_models_json`; an invalid attempted-model entry; and an invalid `stored_at`. It also rejects an empty attempted-model array and a successful model that is not the final attempted model. `lead_id` must be a string whose `trim().length > 0`. Return the stored characters unchanged. `lead_version` must be a safe integer greater than 0. Do not coerce bigint or numeric strings.

Findings rebuild `WebsiteAnalysisFinding`. Accept only a plain object with exact own keys `category`, `severity`, `observation`, `evidence`, and `recommendation`, in that stored order when reconstructed. Categories are `design`, `usability`, `seo`, `accessibility`, and `conversion`. Severities are `low`, `medium`, and `high`. `observation` and `recommendation` are non-empty, equal to their trimmed form, and at most 500. `evidence` is non-empty, equal to its trimmed form, and at most 800. At most 8 findings. At most 3 findings in one category. An empty findings array is valid. Do not call `validateWebsiteAnalysis` and do not modify `analysis.ts`.

Freeze every finding, the findings array, a new attempted-models array, and the root. Do not freeze the caller's result.

## Test command

Targeted command, from the repository root:

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

### Task 1: D1 schema and append-only migration

**Files:**
- Create: `migrations/0002_website_analysis.sql`
- Create: `tests/integration/d1-website-analysis-store.test.ts`
- Test: `tests/integration/d1-website-analysis-store.test.ts`

**Interfaces:**
- Consumes: `migrations/0001_delta_qoralis_crawl.sql` and the Miniflare setup in `tests/integration/d1-crawl-store.test.ts`.
- Produces: table `website_analyses` with the columns and triggers Task 2 inserts into.

- [ ] **Step 1: Write the failing schema tests**

Create the test file. Copy the Miniflare `withDatabase` shape from `tests/integration/d1-crawl-store.test.ts`: `modules: true`, inline script returning `new Response("ok")`, `d1Databases: { DB: "delta-qoralis-test" }`, `d1Persist: false`, `dispose` in `finally`, no outbound service. `exec` `migrations/0001_delta_qoralis_crawl.sql` and then `migrations/0002_website_analysis.sql`.

Add local helpers that insert one manual `business_leads` row and one `single_page_crawl_evidence` row. Use lead id `00000000-0000-4000-8000-000000000001`, `lead_version` 4, requested URL `https://example.com/a`, and `attempted_at` `2026-10-23T00:00:00.000Z`. A fetched row uses `final_url` equal to that URL, status 200, `text/html`, body `<p>a</p>`, the matching byte length, and redirect count 0. A failed row uses `failure_code` `TIMEOUT` and null fetched columns. Do not import the crawler store.

The analysis insert helper binds `evidence_id`, `lead_id`, `lead_version`, `summary`, `findings_json`, `provider`, `model`, `attempted_models_json`, and `stored_at`. Default `stored_at` is `2026-10-23T12:34:56.789Z`. Default model is `gemini-3.8-flash`. Default findings JSON is `[]`. Default attempted-models JSON is `["gemini-3.8-flash"]`.

Write these tests:

`a second raw insert for the same evidence is allowed` inserts a lead and fetched evidence, inserts two analysis rows for that evidence id, and asserts both `last_row_id` values are positive numbers and differ. `PRAGMA index_list('website_analyses')` has no index whose `name` contains `evidence_id`. `sqlite_master` has the table and the two triggers, and no `CREATE INDEX` statement for this table.

`sql accepts non-json text and rejects empty json text` inserts `findings_json` `"not-json"` and `attempted_models_json` `"not-json"` successfully, then rejects `findings_json` `""` and `attempted_models_json` `""`.

`sql rejects invalid scalars` rejects explicit `id` `-1`, `evidence_id` `0`, `lead_id` `" "`, `lead_version` `0`, summary `""`, summary `" "`, a summary of 801 `a` characters, provider `"groq"`, model `"gemini-2.0-flash"`, `stored_at` `"2026-02-31T00:00:00.000Z"`, and an `evidence_id` that does not exist. A summary of exactly 800 `a` characters and `stored_at` `"2024-02-29T00:00:00.000Z"` succeed. Do not assert driver text for these rejections.

`update and delete are rejected` inserts one analysis row, then rejects `UPDATE website_analyses SET summary = summary WHERE id = ?` and `DELETE FROM website_analyses WHERE id = ?`. Each rejection message includes `website_analyses is append-only`.

- [ ] **Step 2: Run the schema tests and confirm RED**

Run the targeted command.

Expected: FAIL. `readFileSync` throws `ENOENT` for `migrations/0002_website_analysis.sql`, or the schema assertions fail because the table does not exist.

- [ ] **Step 3: Write the migration**

Create `migrations/0002_website_analysis.sql` with three one-line statements:

- `CREATE TABLE website_analyses` with `id INTEGER PRIMARY KEY CHECK (typeof(id) = 'integer' AND id > 0)`.
- `evidence_id INTEGER NOT NULL CHECK (typeof(evidence_id) = 'integer' AND evidence_id > 0)`.
- `lead_id TEXT NOT NULL CHECK (length(trim(lead_id)) > 0)`.
- `lead_version INTEGER NOT NULL CHECK (typeof(lead_version) = 'integer' AND lead_version > 0)`.
- `summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 800 AND summary = trim(summary))`.
- `findings_json TEXT NOT NULL CHECK (length(findings_json) > 0)`.
- `provider TEXT NOT NULL CHECK (provider = 'gemini')`.
- `model TEXT NOT NULL CHECK (model IN ('gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'))`.
- `attempted_models_json TEXT NOT NULL CHECK (length(attempted_models_json) > 0)`.
- `stored_at TEXT NOT NULL` with the `attempted_at` CHECK copied from `migrations/0001_delta_qoralis_crawl.sql`, using the column name `stored_at`. Keep that file's short positional `GLOB` checks. Do not copy the single long `GLOB` from `src/crawler/migration.ts`.
- `FOREIGN KEY (evidence_id) REFERENCES single_page_crawl_evidence(id) ON DELETE RESTRICT ON UPDATE RESTRICT`.
- No `UNIQUE`, no `CREATE INDEX`, and no SQL JSON function.

Triggers, also one physical line each:

```sql
CREATE TRIGGER website_analyses_prevent_update BEFORE UPDATE ON website_analyses BEGIN SELECT RAISE(ABORT, 'website_analyses is append-only'); END;
CREATE TRIGGER website_analyses_prevent_delete BEFORE DELETE ON website_analyses BEGIN SELECT RAISE(ABORT, 'website_analyses is append-only'); END;
```

SQLite may treat an explicit `INTEGER PRIMARY KEY` of `0` as "assign a rowid" before the check. Do not drop the `id > 0` check because of that quirk. The explicit `-1` insert is the schema test. Task 2 still rejects a non-positive `last_row_id`.

- [ ] **Step 4: Run the schema tests and confirm GREEN**

Run the targeted command.

Expected: PASS, with only the Task 1 tests present.

- [ ] **Step 5: Commit**

```bash
git add migrations/0002_website_analysis.sql tests/integration/d1-website-analysis-store.test.ts
git commit -m "feat: add D1 website analysis schema"
```

### Task 2: Persistence error and read-back primitive

**Files:**
- Create: `src/website-analysis/persistence-errors.ts`
- Create: `src/website-analysis/d1-analysis-store.ts`
- Modify: `tests/integration/d1-website-analysis-store.test.ts`
- Test: `tests/integration/d1-website-analysis-store.test.ts`

**Interfaces:**
- Consumes: the Task 1 table and the public contract in this plan.
- Produces: `persistD1WebsiteAnalysis`, `WebsiteAnalysisPersistenceError`, `StoredWebsiteAnalysis`, and `D1WebsiteAnalysisDatabase` for Task 3.

- [ ] **Step 1: Write the failing primitive tests**

Append tests to the same file. Import `persistD1WebsiteAnalysis` and `D1WebsiteAnalysisDatabase` from `../../src/website-analysis/d1-analysis-store`, and `WebsiteAnalysisPersistenceError` from `../../src/website-analysis/persistence-errors`. Do not import them from the barrel yet.

Add a result helper. Its analysis uses evidence id from the test, lead id `00000000-0000-4000-8000-000000000001`, lead version 4, summary `Stored page summary`, and one finding: category `design`, severity `medium`, observation `The heading is unclear.`, evidence `The page shows one heading.`, recommendation `State the offer in the heading.` Provider is `gemini`, model is `gemini-3.8-flash`, and `attemptedModels` is `["gemini-3.8-flash"]`. The canonical `storedAt` is `2026-10-23T12:34:56.789Z`.

Add a stub database like `stubDatabase` in `tests/integration/d1-crawl-store.test.ts`. Extend it so a test can count `prepare` calls, capture `run` bindings, and choose `first` by call order: evidence row, then analysis row.

Write these tests:

`invalid storedAt is PERSISTENCE_FAILED` tries `""`, `"2026-02-31T00:00:00.000Z"`, `"2023-02-29T00:00:00.000Z"`, `"1900-02-29T00:00:00.000Z"`, `"2026-10-23T12:34:56.789+00:00"`, and `"2026-10-23t12:34:56.789Z"`. Each rejection is `WebsiteAnalysisPersistenceError` code `PERSISTENCE_FAILED`, message `Website analysis persistence failed.`, and `cause` is `undefined`. `prepare` count stays 0.

`a real leap day is a valid storedAt` uses stubbed fetched evidence and a read-back row for `2024-02-29T00:00:00.000Z`. The call resolves and `storedAt` is that exact string.

`missing evidence is EVIDENCE_NOT_FOUND` uses `first` returning `null`. Code is `EVIDENCE_NOT_FOUND`, message is `Crawl evidence was not found.`, and `run` is not called.

`failed evidence is EVIDENCE_NOT_ANALYZABLE` returns `outcome: "failed"` with matching id, lead id, and lead version. Code is `EVIDENCE_NOT_ANALYZABLE`, message is `Crawl evidence is not analyzable.`, and `run` is not called. Repeat the same assertion for `outcome: "other"`.

`evidence lead and version mismatches are ANALYSIS_IDENTITY_MISMATCH` runs three cases: row id differs, `lead_id` differs, and `lead_version` differs. Each code is `ANALYSIS_IDENTITY_MISMATCH`, message is `Website analysis identity does not match the crawl evidence.`, and `run` is not called. A numeric-string `lead_version` is also a mismatch, not a coerced success.

`evidence read failure is PERSISTENCE_FAILED` makes the evidence `first()` throw `new Error("secret-driver")`. Code is `PERSISTENCE_FAILED`, `cause` is `undefined`, and the message does not include `secret-driver`.

`insert failure is PERSISTENCE_FAILED` returns matching fetched evidence and makes `run()` throw `new Error("secret-insert")`. The message does not include `secret-insert`.

`insert metadata failures are PERSISTENCE_FAILED` covers `changes: 0` with a positive `last_row_id`, and `changes: 1` with `last_row_id` values `0`, `-1`, `1.5`, and `1n as unknown as number`.

`missing read-back row is PERSISTENCE_FAILED` returns a valid insert meta and then `null` from the analysis select.

`read-back returns the stored row` returns a row whose summary is `Stored summary`, not the input summary `Input summary`. The resolved summary is `Stored summary`. The input finding object remains unfrozen. The returned root, findings array, finding, and attempted-models array are frozen.

`read-back id mismatch is PERSISTENCE_FAILED` returns a row whose `id` is not the inserted id.

`corrupt findings_json is PERSISTENCE_FAILED` covers `findings_json` values `{`, `{"category":"design"}`, a finding with an extra own key, a fourth `design` finding while the total is 4, and a nine-finding array. Also reject observation `" "`, observation of 501 characters, evidence of 801 characters, and recommendation of 501 characters.

`corrupt attempted_models_json is PERSISTENCE_FAILED` covers `{`, `[]`, `["gemini-2.0-flash"]`, and `["gemini-3.8-flash", "gemini-3.6-flash"]` when `model` is `gemini-3.8-flash`.

`invalid stored provider is PERSISTENCE_FAILED` returns provider `groq`.

`invalid stored model is PERSISTENCE_FAILED` returns model `gemini-2.0-flash`.

`malformed read-back scalars are PERSISTENCE_FAILED` returns, in separate calls, a summary of 801 `a` characters, a `lead_id` of `" "`, a `lead_version` of `"4"`, and a `stored_at` of `"2026-02-31T00:00:00.000Z"`.

`successful model must be the final attempted model` uses input `model` `gemini-3.8-flash` and `attemptedModels` `["gemini-3.8-flash", "gemini-3.6-flash"]`. `run` is not called. A separate read-back row with that same invalid order is also `PERSISTENCE_FAILED`.

`empty findings round-trip through read-back` uses `findings: []` and a row whose `findings_json` is `[]`. The result findings array is frozen and empty.

A valid stubbed read-back also preserves attempted-model order `["gemini-3.6-flash", "gemini-3.8-flash"]` when `model` is `gemini-3.8-flash`.

- [ ] **Step 2: Run the primitive tests and confirm RED**

Run the targeted command.

Expected: FAIL. TypeScript reports `TS2307` because `../../src/website-analysis/d1-analysis-store` does not exist. `node --test` does not run.

- [ ] **Step 3: Implement the error and store**

Create `persistence-errors.ts` and `d1-analysis-store.ts` with the public contract and algorithm above. Keep the parser private. The error class has `readonly name` and `constructor(readonly code)` only.

- [ ] **Step 4: Run the primitive tests and confirm GREEN**

Run the targeted command.

Expected: PASS, including the Task 1 schema tests.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/persistence-errors.ts src/website-analysis/d1-analysis-store.ts tests/integration/d1-website-analysis-store.test.ts
git commit -m "feat: persist D1 website analyses"
```

### Task 3: Real D1 round-trip and public export

**Files:**
- Modify: `src/website-analysis/index.ts`
- Modify: `tests/integration/d1-website-analysis-store.test.ts`
- Test: `tests/integration/d1-website-analysis-store.test.ts`

**Interfaces:**
- Consumes: `persistD1WebsiteAnalysis` from Task 2 and the Task 1 schema.
- Produces: the barrel exports later slices import from `src/website-analysis`.

- [ ] **Step 1: Write the failing integration tests**

Add tests that import `persistD1WebsiteAnalysis`, `WebsiteAnalysisPersistenceError`, and the types `StoredWebsiteAnalysis`, `WebsiteAnalysisPersistenceErrorCode`, and `D1WebsiteAnalysisDatabase` from `../../src/website-analysis`.

`public persistence contract is exported` assigns a `WebsiteAnalysisPersistenceErrorCode` local to `"PERSISTENCE_FAILED"` and constructs `new WebsiteAnalysisPersistenceError("EVIDENCE_NOT_FOUND")`. This test only needs to compile.

`successful analysis persists and round-trips` uses `withDatabase`, inserts a lead and fetched evidence at lead version 4, reads that evidence id, and calls `persistD1WebsiteAnalysis` with `storedAt` `2026-10-23T12:34:56.789Z`. The input finding is a fresh unfrozen object. `model` is `gemini-3.8-flash` and `attemptedModels` is `["gemini-3.6-flash", "gemini-3.8-flash"]`. Assert the returned id is a positive safe integer, `evidenceId`, `leadId`, and `leadVersion` match, summary and the finding match, `provider` is `gemini`, `attemptedModels` deep-equals that same two-model order, and `storedAt` is unchanged. Assert the root, findings array, finding, and attempted-models array are frozen. Assert the caller's finding object is not frozen. Select the row by the returned id and assert one row, with `findings_json` equal to `JSON.stringify` of the input findings and `attempted_models_json` equal to `JSON.stringify` of the input attempted models.

`a second persistence creates a different id` calls the function twice for the same evidence with summaries `First stored summary` and `Second stored summary`. The ids differ. Both rows remain. Their summaries stay on their own ids.

- [ ] **Step 2: Run the integration tests and confirm RED**

Run the targeted command.

Expected: FAIL with `TS2724` or `TS2305` because `../../src/website-analysis` does not export `persistD1WebsiteAnalysis`. `node --test` does not run.

- [ ] **Step 3: Export the contract**

Add the barrel exports from the public contract section. If the real round-trip then fails because the insert or select column list does not match the migration, fix `d1-analysis-store.ts` only. Do not change the migration's constraints to satisfy a bad insert.

- [ ] **Step 4: Run the integration tests and confirm GREEN**

Run the targeted command.

Expected: PASS, including Task 1 and Task 2 tests. No test waits on a network and none calls Gemini.

- [ ] **Step 5: Commit**

```bash
git add src/website-analysis/index.ts src/website-analysis/d1-analysis-store.ts tests/integration/d1-website-analysis-store.test.ts
git commit -m "test: cover D1 website analysis persistence"
```

Include `d1-analysis-store.ts` only when Step 3 changed it.

## Final verification

After Task 3 is green, run:

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

Then run `npm test`, `npm run typecheck`, and `git diff --check`.

Expected: the targeted file passes, `npm test` passes with 0 failures and 0 skips, `npm run typecheck` passes, and `git diff --check` prints nothing. `docs/PLAN.md` and `docs/BACKLOG.md` are unchanged. No SQLite analysis migration, repository, DQ-033 call, Worker route, scheduler, or new provider is present.
