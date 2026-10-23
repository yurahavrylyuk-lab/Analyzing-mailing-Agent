# DQ-035 Bounded D1 Website Analysis Pipeline

## Status

```text
design, human-approved, not implemented
```

## Intent

DQ-035 connects production D1 to the website-analysis pieces that already exist. One controlled run selects eligible fetched crawl evidence, reconstructs `StoredSinglePageCrawlEvidence`, extracts facts, runs the existing bounded analysis, persists each successful result, and returns a small operational summary.

It orchestrates existing boundaries and must not duplicate them.

```text
DQ-030: StoredSinglePageCrawlEvidence
→ extractWebsiteFacts
→ WebsiteFacts

DQ-033: readonly WebsiteFacts[]
→ runWebsiteAnalysis
→ readonly WebsiteAnalysisRunItem[]

DQ-034: GeminiWebsiteAnalysisResult + D1 + explicit storedAt
→ persistD1WebsiteAnalysis
→ StoredWebsiteAnalysis
```

DQ-035 is the first D1-backed Phase 3 pipeline. It is not a scheduler, a daily budget, or a new analysis implementation.

## Current State

DQ-030 `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts` reads one fetched crawl evidence value and performs no network request. Failed evidence throws `WebsiteFactsError` with code `EVIDENCE_NOT_ANALYZABLE`.

DQ-031 `validateWebsiteAnalysis` and DQ-032 `analyzeWebsiteWithGemini` stay inside DQ-033. `GeminiWebsiteAnalysisConfig` is the existing config from `src/config/env.ts`: `provider: "gemini"` and `apiKey: string`.

DQ-033 `runWebsiteAnalysis(facts: readonly WebsiteFacts[], config: GeminiWebsiteAnalysisConfig, options?: WebsiteAnalysisRunOptions)` accepts 0–50 unique `evidenceId` values, analyzes them sequentially, isolates known per-website failures, and retries `GEMINI_TRANSPORT_UNAVAILABLE` once, no earlier than that item's first transport failure plus 90 seconds. It returns `readonly WebsiteAnalysisRunItem[]` in input order. Each terminal item has `retried: boolean`. A succeeded item carries `result: GeminiWebsiteAnalysisResult`. A failed item carries `error: Error`. `WebsiteAnalysisRunOptions` already allows tests to inject `analyze`, `now`, and `sleep`. 50 per run is not 50 per day. DQ-033 does not select evidence and does not persist.

DQ-034 `persistD1WebsiteAnalysis(database: D1WebsiteAnalysisDatabase, result: GeminiWebsiteAnalysisResult, storedAt: string)` appends one successful analysis to `website_analyses`. It requires the referenced `single_page_crawl_evidence` row to exist with `outcome = 'fetched'`, and it requires exact `evidenceId`, `leadId`, and `leadVersion` agreement. It does not generate `storedAt`. The private `isCanonicalTimestamp` check accepts only the 24-character UTC form `YYYY-MM-DDTHH:mm:ss.sssZ`. `migrations/0002_website_analysis.sql` creates the append-only table with no index and no `UNIQUE(evidence_id)`. Multiple historical rows for one `evidence_id` remain valid. Update and delete are rejected.

`evidenceFromRow` in `src/crawler/database-evidence-repository.ts` is the existing crawl-evidence parser. It accepts the stored columns `id`, `lead_id`, `lead_version`, `outcome`, `requested_url`, `attempted_at`, `final_url`, `status_code`, `content_type`, `body_text`, `byte_length`, `redirect_count`, and `failure_code`. Its parameter type, `EvidenceRow`, is not exported. `persistD1CrawlEvidence` already calls it as `evidenceFromRow(row as unknown as Parameters<typeof evidenceFromRow>[0])`. A row that cannot become valid stored evidence throws `CrawlEvidencePersistenceError`.

`D1CrawlDatabase` and `D1WebsiteAnalysisDatabase` are the same minimal structural shape: `prepare(sql)` returning a statement with `bind`, `all`, `first`, and `run`. Neither module imports Cloudflare SDK types.

Local SQLite still has no website-analysis table. DQ-036 through DQ-039 have no title or contract in the current project docs.

## Goals

- Select eligible fetched crawl evidence from production D1, oldest first, at most 50 rows.
- Reconstruct each selected row with `evidenceFromRow`.
- Extract facts with `extractWebsiteFacts`.
- Call `runWebsiteAnalysis` once for that batch.
- Persist each successful terminal item with `persistD1WebsiteAnalysis`.
- Leave failed analyses unpersisted so they remain eligible.
- Return one frozen count summary.
- Keep DQ-030, DQ-033, and DQ-034 as the owners of facts, analysis, and persistence.

## Non-goals

DQ-035 does not add a scheduler, a Worker route, daily accounting, failure history, a lock, SQLite analysis storage, a new facts extractor, a new Gemini adapter, another provider, qualification, contacts, or outreach. It does not start DQ-036.

## Approved Decisions

- The selected approach is one bounded D1 analysis pipeline.
- Eligibility is `single_page_crawl_evidence.outcome = 'fetched'` and no `website_analyses` row for that evidence id.
- Any existing `website_analyses` row makes that evidence ineligible for automatic selection. A failed analysis writes no row and stays eligible.
- Order is `attempted_at ASC, id ASC`.
- One run accepts 0–50 evidence rows. Invalid bounds fail before any D1 selection. `0` is valid.
- 50 per run is not 50 per day.
- The selection query returns the full stored crawl-evidence row that `evidenceFromRow` already requires. There is no second parser.
- A selected row that cannot reconstruct fails the pipeline. It is not skipped.
- `extractWebsiteFacts` is used for every selected evidence value. There is no network request in that step.
- `runWebsiteAnalysis` is called exactly once. Gemini transport, model fallback, known-error isolation, the 90-second transport retry, retry ordering, analysis concurrency, and duplicate-evidence validation stay in DQ-033.
- Persistence is sequential and successful-only. A failed terminal item persists nothing and creates no failure-history row.
- A persistence failure propagates `WebsiteAnalysisPersistenceError` and stops the pipeline. Earlier persisted rows stay. There is no cross-row transaction and no compensating delete.
- DQ-034 remains clock-free. DQ-035 generates one `storedAt` string immediately before each successful persistence call.
- The public result is counts only. DQ-033 continues to own the per-site items.
- The D1 argument is a minimal structural type. There is no repository abstraction, service container, factory, or dependency-injection framework.
- Tests reuse `WebsiteAnalysisRunOptions` for a deterministic analyzer, clock, and sleep. DQ-035 does not add another analyzer abstraction.
- A future migration adds one non-unique index on `website_analyses(evidence_id)`. That migration is not part of this design's implementation, and this design does not create the file.
- Concurrent runs may both select the same evidence. That duplicate-analysis possibility is accepted and is not locked.
- `UNIQUE(evidence_id)` is not added. DQ-034 must still permit an explicit future reanalysis.

## Considered Approaches

Approach 1 — bounded D1 analysis pipeline. Select eligible fetched evidence, reconstruct it, extract facts, call DQ-033 once, persist successful results through DQ-034, and return a summary.

Approach 2 — selector and loader only. Rejected. It would not produce a useful analysis pipeline.

Approach 3 — daily-budget accounting first. Rejected. It would introduce runtime policy before the D1 pipeline exists.

## Selected Approach

Approach 1. It creates the first useful D1-backed Phase 3 pipeline, reuses the completed DQ-030, DQ-033, and DQ-034 contracts, and does not introduce a scheduler or runtime policy.

The implementation shape stays small: one selection query, one bounded orchestration function, one small error class, one small result type, one directly justified index, and reuse of the existing facts, run, and persistence functions.

## Pipeline Flow

1. Validate `maxItems` before D1 work.
2. When `maxItems === 0`, return a frozen zero summary. Do not select, analyze, or persist.
3. Select eligible evidence, oldest first, limited to `maxItems`.
4. When the selection is empty, return a frozen zero summary. Do not call Gemini and do not persist.
5. Reconstruct every selected row with `evidenceFromRow`, in selection order. A reconstruction failure stops the pipeline.
6. Call `extractWebsiteFacts` for every reconstructed evidence value, in that same order. An extraction failure stops the pipeline before analysis.
7. Call `runWebsiteAnalysis` once with the facts array, the supplied Gemini config, and `options.analysisRunOptions`.
8. Walk the returned terminal items in their original order.
9. For `status: "succeeded"`, generate `storedAt` and call `persistD1WebsiteAnalysis` once. For `status: "failed"`, persist nothing.
10. When every successful item has been persisted, return the frozen summary.

Selection order is the facts order, and DQ-033 preserves that order in its terminal results. Persistence follows that same order.

## Selection Eligibility

A row is eligible only when both of these are true:

```text
single_page_crawl_evidence.outcome = 'fetched'
AND NOT EXISTS (
  SELECT 1
  FROM website_analyses
  WHERE website_analyses.evidence_id = single_page_crawl_evidence.id
)
```

Order:

```text
attempted_at ASC, id ASC
```

The query returns the complete stored row:

```text
id, lead_id, lead_version, outcome, requested_url, attempted_at,
final_url, status_code, content_type, body_text, byte_length,
redirect_count, failure_code
```

`LIMIT` is the validated `maxItems`.

`maxItems` must be an integer number from 0 through 50. Reject these before preparing or running the selection query: negative, greater than 50, fractional, `NaN`, `Infinity`, and any other non-integer. A non-number is an invalid request. `0` is valid and performs no D1 selection.

A fetched evidence row becomes ineligible for automatic selection once any `website_analyses` row exists for that `evidence_id`. One persisted successful analysis is enough. The absence of a row means the evidence remains eligible, including evidence whose earlier analysis failed. This design does not add analysis-failure persistence, a retry-history table, or `UNIQUE(evidence_id)`.

`persistD1WebsiteAnalysis` still does not look for an existing analysis row. An explicit future caller can append another historical analysis for the same evidence. DQ-035 automatic selection will skip that evidence after the first row exists.

Failed crawl evidence is not selected because `outcome` is not `fetched`.

## Evidence Reconstruction

Reuse `evidenceFromRow`. Do not create a second parser, and do not reimplement `normalizeSinglePageCrawlEvidence`.

The call follows the existing D1 crawl store: pass the selected row through the exported function's parameter type. `EvidenceRow` stays module-private.

Every selected row already has `outcome = 'fetched'`. If a selected row cannot reconstruct into valid `StoredSinglePageCrawlEvidence`, the pipeline fails. Do not silently skip corrupt D1 evidence. The failure is the existing `CrawlEvidencePersistenceError` from that parser. It is not rewritten as `SELECTION_FAILED`.

## Facts Extraction

Call `extractWebsiteFacts(evidence)` for every selected evidence value after reconstruction. Reuse DQ-030. This step performs no network request.

Build the full `WebsiteFacts[]` before calling DQ-033. If extraction throws, stop. Do not call `runWebsiteAnalysis` with a partial facts array, and do not persist anything for that run.

## DQ-033 Boundary

After the facts array is complete, call `runWebsiteAnalysis` exactly once:

```text
runWebsiteAnalysis(facts, config, options?.analysisRunOptions)
```

Do not reimplement Gemini transport, model fallback, known-error isolation, the 90-second transport retry, retry ordering, analysis concurrency, or duplicate evidence validation.

Selection uses `single_page_crawl_evidence.id`, so the facts array has unique `evidenceId` values and should satisfy DQ-033 uniqueness. The batch length is at most 50. 50 per run is not 50 per day.

Production calls the real `runWebsiteAnalysis`. `WebsiteAnalysisRunOptions.analyze` already defaults to `analyzeWebsiteWithGemini` inside DQ-033. Tests that need a deterministic analyzer, clock, or sleep pass them through `analysisRunOptions`. No second analyzer abstraction is added.

Known DQ-033 failures stay on their website and become `status: "failed"` items. Unexpected errors that DQ-033 already lets escape continue to escape. DQ-035 does not catch them and does not turn them into pipeline error codes.

## DQ-034 Persistence Boundary

Process DQ-033 terminal items in original result order.

- `status: "succeeded"` calls `persistD1WebsiteAnalysis` once with `item.result` and the generated `storedAt` string.
- `status: "failed"` persists nothing and creates no failure-history row.

Persistence is sequential. The pipeline waits for one successful persistence to finish before generating the next timestamp or persisting the next success.

DQ-034 still verifies fetched evidence, exact identity, insert metadata, and read-back. DQ-035 does not duplicate those checks and does not change `persistD1WebsiteAnalysis`.

## Timestamp Ownership

DQ-034 stays clock-free and requires an explicit `storedAt` string. DQ-035 generates one timestamp immediately before each successful persistence call.

The default clock is:

```text
() => new Date().toISOString()
```

`Date.toISOString()` produces the canonical 24-character UTC string that DQ-034 already accepts. Tests inject `storedAt?: () => string` on the pipeline options. The string returned by that function is passed unchanged to `persistD1WebsiteAnalysis`. Do not pass a numeric timestamp. Do not alter DQ-034 timestamp validation, including the private `isCanonicalTimestamp` function.

A failed terminal item does not call the clock, because nothing is persisted for it.

## Result Contract

```ts
type D1WebsiteAnalysisPipelineResult = Readonly<{
  selected: number;
  succeeded: number;
  failed: number;
  retried: number;
  persisted: number;
}>;
```

`selected` is the number of evidence rows selected for the run. `succeeded` and `failed` count DQ-033 terminal items by status. `persisted` counts successful analyses that `persistD1WebsiteAnalysis` accepted. `retried` counts terminal items whose `retried` flag is `true`, whether that item succeeded or failed.

Successful-return invariants:

```text
selected = succeeded + failed
persisted = succeeded
0 <= retried <= selected
```

Freeze the result with `Object.freeze` before returning it. Do not return the per-site `WebsiteAnalysisRunItem` values. DQ-033 owns those.

An empty run, either `maxItems === 0` or no eligible evidence, returns a frozen zero summary: `selected`, `succeeded`, `failed`, `retried`, and `persisted` are all `0`.

A thrown pipeline does not return this result. The invariants apply to a successful return.

## Public API

```ts
runD1WebsiteAnalysisPipeline(
  database: D1WebsiteAnalysisPipelineDatabase,
  config: GeminiWebsiteAnalysisConfig,
  maxItems: number,
  options?: D1WebsiteAnalysisPipelineOptions,
): Promise<D1WebsiteAnalysisPipelineResult>
```

`D1WebsiteAnalysisPipelineDatabase` is the minimal structural type already used by `D1CrawlDatabase` and `D1WebsiteAnalysisDatabase`:

```ts
type D1WebsiteAnalysisPipelineDatabase = {
  prepare(sql: string): D1WebsiteAnalysisPipelineStatement;
};
```

The statement exposes `bind`, `all`, `first`, and `run` with the same result shapes those two existing types use. Do not import Cloudflare SDK types. One database value is passed through to `persistD1WebsiteAnalysis` because that function only requires `prepare`.

```ts
type D1WebsiteAnalysisPipelineOptions = Readonly<{
  analysisRunOptions?: WebsiteAnalysisRunOptions;
  storedAt?: () => string;
}>;
```

Do not create `WebsiteAnalysisPipelineRepository`, a repository abstraction, a service container, a factory, or a dependency-injection framework.

## Error Model

Follow the existing frozen-code style used by `WebsiteAnalysisPersistenceError` and `WebsiteAnalysisRunError`: a frozen code list, a fixed message per code, `readonly name`, and `constructor(code)`. Do not accept or attach `cause`.

```ts
type D1WebsiteAnalysisPipelineErrorCode = "INVALID_REQUEST" | "SELECTION_FAILED";

class D1WebsiteAnalysisPipelineError extends Error
```

Fixed messages:

```text
INVALID_REQUEST: "D1 website analysis pipeline request is invalid."
SELECTION_FAILED: "D1 website analysis selection failed."
```

`INVALID_REQUEST` is invalid `maxItems` only.

`SELECTION_FAILED` is only a failure of the D1 selection operation itself. A thrown selection query is caught and replaced with this error. A selection result longer than `maxItems` is also `SELECTION_FAILED`, matching the guard in `selectD1CrawlCandidates`. The fixed message is the only public detail. Do not expose SQL, raw D1 errors, database responses, analysis bodies, Gemini configuration, or API keys.

Do not flatten downstream errors. These may propagate unchanged:

- `CrawlEvidencePersistenceError` when selected evidence cannot be reconstructed.
- `WebsiteFactsError` when facts extraction rejects evidence.
- `WebsiteAnalysisRunError` when DQ-033 rejects the facts array.
- `GeminiWebsiteAnalysisError` and `WebsiteAnalysisError` when DQ-033 already lets that error escape.
- `WebsiteAnalysisPersistenceError` when persistence of one successful result fails.

Corrupt selected evidence propagates the existing parsing or persistence-domain failure. Do not convert any of those errors to `SELECTION_FAILED`.

## Partial Progress and Recovery

There is no cross-row transaction. Each `persistD1WebsiteAnalysis` call commits its own append. The table is append-only, so DQ-035 does not delete or update an earlier row.

If persistence of one successful result fails, propagate that `WebsiteAnalysisPersistenceError` and stop. Do not continue with later items. Do not roll back previously persisted analyses. They remain durable.

Example: five evidence rows are selected. Analyses 1 and 2 persist. Analysis 3 is a successful analysis whose persistence fails. The pipeline throws. Rows 1 and 2 remain. The next run's `NOT EXISTS` check excludes evidence 1 and 2. Evidence 3, 4, and 5 were not persisted, so they remain eligible. There is no compensating delete.

A DQ-033 `failed` item is different. It writes no row, the pipeline continues to the next terminal item, and that evidence remains eligible on a later run.

## D1 Selection Index

`migrations/0002_website_analysis.sql` has no index on `website_analyses(evidence_id)`. The eligibility check is a `NOT EXISTS` lookup on that column.

A future migration, `migrations/0003_website_analysis_selection.sql`, adds one non-unique index:

```text
CREATE INDEX website_analyses_evidence_id_idx
ON website_analyses (evidence_id)
```

The `_idx` suffix follows `business_leads_discovery_identity_idx`. The index is not unique. It preserves multiple-analysis history. Do not create this migration in the design step.

No other index is required by this selection. `single_page_crawl_evidence` is already addressed by its primary key, and this design does not add an outcome or `attempted_at` index. Do not add `UNIQUE(evidence_id)`.

## Concurrency Boundary

DQ-035 takes no lease, lock, reservation, claim token, unique analysis-per-evidence constraint, queue, or distributed mutex.

Two concurrent DQ-035 runs can select the same evidence before either persists. Both can then append a `website_analyses` row for that evidence. That outcome is accepted:

- there is no scheduler;
- the intended execution is one controlled run;
- DQ-034 supports multiple historical analyses;
- locking belongs with a future runtime design.

Document this limitation. Do not solve it in DQ-035.

## Testing Expectations

Future tests use the existing local Miniflare and D1 infrastructure. They do not call real Gemini, use the network, or use production D1. This design does not write those tests.

The tests must cover:

- a valid `0` bound returns the zero summary;
- bounds 1–50 are accepted;
- negative, greater than 50, fractional, `NaN`, and `Infinity` `maxItems` values are `INVALID_REQUEST`;
- `maxItems === 0` performs no analysis and no persistence;
- selection includes only `outcome = 'fetched'`;
- fetched evidence with any `website_analyses` row is excluded;
- failed crawl evidence is not selected;
- ordering is `attempted_at ASC, id ASC`;
- selection obeys `maxItems`;
- a D1 selection failure is `SELECTION_FAILED`;
- a selected row is reconstructed through `evidenceFromRow`;
- a corrupt selected row fails rather than being skipped;
- `extractWebsiteFacts` is applied to each selected evidence value;
- `runWebsiteAnalysis` is invoked once;
- successful items are persisted;
- failed items are not persisted;
- successful items persist in original result order;
- `storedAt` is called immediately for each persistence;
- the generated `storedAt` is passed unchanged to DQ-034;
- `retried` follows the DQ-033 `retried` flags;
- `selected`, `succeeded`, `failed`, and `persisted` counts are correct;
- the summary object is frozen;
- a persistence failure propagates;
- an earlier successful persistence remains durable when a later one fails;
- the next run excludes evidence that was already persisted;
- a failed analysis remains eligible later;
- the non-unique `website_analyses(evidence_id)` index exists;
- multiple `website_analyses` rows per evidence remain allowed.

## Explicit Exclusions

DQ-035 does not add:

- a scheduler, cron, GitHub Actions analysis workflow, Worker analysis endpoint, or production deployment;
- 50/day accounting or daily usage persistence;
- a failure-history table, an analysis-attempt table, or a cross-run retry limit;
- a lease, lock, reservation, claim, queue, background worker, or concurrency framework;
- SQLite website-analysis persistence;
- a new website-analysis schema, facts extractor, or Gemini adapter;
- cross-provider fallback, Groq, Cloudflare Workers AI, or OpenRouter;
- qualification, lead scoring, contact discovery, DNC execution, outreach, or email sending;
- token accounting, cost accounting, or latency accounting;
- a generic repository abstraction or a generic persistence framework.

Do not start DQ-036.

## Future Boundary

The intended later sequence is:

```text
DQ-035 controlled D1 pipeline
→ a future runtime and scheduling slice
→ a future real daily-budget and accounting slice
→ later qualification
```

DQ-036 through DQ-039 remain unarchitected. Current project docs do not give DQ-036 a title or a contract, and this design does not assign one.

## Names aligned to source

The approved names match the repository, with these source details:

- Reconstruction uses exported `evidenceFromRow`. `EvidenceRow` is not exported. The existing call site in `persistD1CrawlEvidence` casts the D1 row to `Parameters<typeof evidenceFromRow>[0]`.
- Facts extraction uses `extractWebsiteFacts(evidence: StoredSinglePageCrawlEvidence): WebsiteFacts`.
- The one analysis call uses `runWebsiteAnalysis(facts, config, options?)`.
- `WebsiteAnalysisRunOptions` already contains optional `analyze`, `now`, and `sleep`. The pipeline passes that object through and does not add an analyzer abstraction.
- Persistence uses `persistD1WebsiteAnalysis(database, result, storedAt: string)`.
- Timestamp validation remains the private `isCanonicalTimestamp` in `src/website-analysis/d1-analysis-store.ts`.
- `GeminiWebsiteAnalysisConfig` remains the type in `src/config/env.ts`.
- `D1WebsiteAnalysisPipelineDatabase` copies the structural `prepare` shape of `D1CrawlDatabase` and `D1WebsiteAnalysisDatabase` without importing a Cloudflare SDK type.
