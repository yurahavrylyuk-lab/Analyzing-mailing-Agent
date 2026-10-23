# DQ-034 D1 Website Analysis Persistence Design

## Status

```text
design, human-approved, not implemented
```

## Intent

DQ-034 makes one successful website analysis durable in production Cloudflare D1.

The current flow ends at a successful `GeminiWebsiteAnalysisResult`:

```text
stored fetched crawl evidence
→ DQ-030 WebsiteFacts
→ DQ-032 Gemini analysis
→ DQ-033 bounded run
→ successful GeminiWebsiteAnalysisResult
```

DQ-034 adds only the persistence primitive:

```text
successful GeminiWebsiteAnalysisResult
+ D1
+ explicit storedAt
→ verify referenced crawl evidence
→ verify fetched outcome
→ verify identity
→ append one website analysis row
→ read back and validate
→ StoredWebsiteAnalysis
```

DQ-034 is not the orchestration or wiring slice. It does not automatically consume a DQ-033 result array.

## Current state

DQ-030 returns frozen `WebsiteFacts` from one fetched crawl evidence record. DQ-031 `validateWebsiteAnalysis` returns one frozen `WebsiteAnalysis`. DQ-032 `analyzeWebsiteWithGemini` returns one frozen `GeminiWebsiteAnalysisResult` with `provider: "gemini"`, the successful `GeminiModel`, and `attemptedModels` in model-attempt order. DQ-033 `runWebsiteAnalysis` returns ordered terminal items and does not persist them.

Production crawl evidence already lives in Cloudflare D1 table `single_page_crawl_evidence`, written by `persistD1CrawlEvidence`. That table's real columns include `id`, `lead_id`, `lead_version`, and `outcome`. `outcome` is exactly `fetched` or `failed`. `lead_id` references `business_leads(id)` with `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`. Update and delete are rejected by append-only triggers. `attempted_at` is canonical UTC text of the form `YYYY-MM-DDTHH:mm:ss.sssZ`.

`persistD1CrawlEvidence` uses a minimal structural D1 type, `D1CrawlDatabase`. It does not use Cloudflare SDK types. After insert it requires `meta.changes === 1`, a positive safe-integer `meta.last_row_id`, one selected row with that id, and `stored.id === insertedId`.

Local SQLite still stores crawl evidence through the existing crawler repository. It has no website-analysis table. That SQLite store stays unrelated to DQ-034.

`GeminiModel` is exactly `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, or `gemini-3.1-flash-lite`. `WebsiteAnalysis.summary` is already trimmed and bounded to 1..800. Findings stay inside the existing DQ-031 bounds. No analysis schema exists yet.

## Goals

- Persist one successful `GeminiWebsiteAnalysisResult` in D1.
- Reject missing evidence, evidence that is not `fetched`, and an identity mismatch before insert.
- Keep every stored analysis as an immutable historical row.
- Read the inserted row back and return one frozen `StoredWebsiteAnalysis`.
- Use the existing `WebsiteAnalysis`, `WebsiteAnalysisFinding`, `GeminiWebsiteAnalysisResult`, and `GeminiModel` types.

## Non-goals

DQ-034 does not select crawl evidence, extract `WebsiteFacts`, call Gemini, run `runWebsiteAnalysis`, persist failed analyses, or wire DQ-033 to D1. It does not add SQLite analysis storage, a repository abstraction, qualification, or a later provider.

## Approved decisions

- Cloudflare D1 is the only analysis store.
- Only a successful `GeminiWebsiteAnalysisResult` is stored. Failed DQ-033 items are not persisted.
- Multiple analyses for the same crawl evidence are allowed. There is no `UNIQUE(evidence_id)`, no overwrite, and no upsert.
- One table stores findings and attempted models as JSON text. There is no findings child table.
- The referenced `single_page_crawl_evidence` row must exist and have `outcome = "fetched"`.
- `result.analysis.evidenceId`, `leadId`, and `leadVersion` must all match that row. A mismatch is terminal and is not repaired.
- `storedAt` is explicit caller input. The primitive does not call `Date.now` or `new Date` to generate it.
- After insert, the primitive reads that row back and validates it before returning.
- No `WebsiteAnalysisRepository`, `AnalysisStore`, repository factory, dependency injection, SQLite analysis implementation, or generic storage provider is added. Crawl evidence has a SQLite repository because crawl evidence exists in both stores. Analysis does not.
- DQ-033 and DQ-034 stay separate. There is no `persistWebsiteAnalysisRun`.

## Considered approaches

Approach 1 — one focused D1 persistence function. It writes one successful result, checks the referenced evidence, and returns the read-back row.

Approach 2 — a repository abstraction plus a D1 implementation. Rejected. Only one analysis store is required, so the abstraction has no second implementation to justify it.

Approach 3 — persistence plus automatic consumption of a DQ-033 result array. Rejected. That mixes the persistence primitive with orchestration.

## Selected approach

Approach 1. The smallest contract is one D1 function, one error type, and one later migration. It follows `persistD1CrawlEvidence` closely enough to keep insert and read-back defensive, without copying crawl selection, crawl summaries, or the SQLite evidence repository.

The later module is one website-analysis D1 store module, exported from the existing website-analysis index. This design does not create that module.

## Stored domain model

```ts
type StoredWebsiteAnalysis = Readonly<{
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
```

Freeze each finding, the findings array, the attempted-models array, and the root object. Use the same immutable domain convention as `validateWebsiteAnalysis`. Do not add scores, prompts, tokens, cost, latency, run ids, or other metadata.

`leadId` and `leadVersion` are stored again on purpose. They are historical provenance copied from the analyzed result after that result has matched the evidence row.

## D1 schema

The later migration is `migrations/0002_website_analysis.sql`. Do not create it in this design slice. The next existing migration number is `0002` because `migrations/0001_delta_qoralis_crawl.sql` already exists.

Table `website_analyses`:

- `id` `INTEGER PRIMARY KEY` with `typeof(id) = 'integer' AND id > 0`. The application still requires `meta.changes === 1` and a positive safe-integer `meta.last_row_id`, as `persistD1CrawlEvidence` does. `single_page_crawl_evidence.id` has no `id > 0` check; this table adds one because DQ-034 requires a positive id.
- `evidence_id` with `typeof(evidence_id) = 'integer' AND evidence_id > 0`, referencing `single_page_crawl_evidence(id)` with `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`.
- `lead_id` text with `length(trim(lead_id)) > 0`. The source column name is already `lead_id`. Do not add a second lead-id format.
- `lead_version` positive integer, using the same `typeof(lead_version) = 'integer' AND lead_version > 0` rule as `single_page_crawl_evidence.lead_version`.
- `summary` non-empty text, equal to its trimmed form, length 1..800. That is the existing `WebsiteAnalysis.summary` bound.
- `findings_json` text. The application validates it. SQL does not parse it.
- `provider` text, exactly `gemini`.
- `model` text, exactly one of `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`.
- `attempted_models_json` text. The application validates it. SQL does not parse it.
- `stored_at` text, the same canonical UTC check already used by `single_page_crawl_evidence.attempted_at`.

No `UNIQUE(evidence_id)`. No findings child table. No speculative indexes. No SQL JSON queries.

## Identity/evidence validation

Validate `storedAt` before any database call. Invalid timestamps are not stored and raise `PERSISTENCE_FAILED`.

Then read `single_page_crawl_evidence` by `result.analysis.evidenceId`, selecting `id`, `lead_id`, `lead_version`, and `outcome`.

- No row: `EVIDENCE_NOT_FOUND`.
- A row whose `outcome` is not exactly `fetched`: `EVIDENCE_NOT_ANALYZABLE`. Failed crawl evidence cannot receive a successful analysis.
- A D1 read failure: `PERSISTENCE_FAILED`.

Before insert, all three identities must match:

- `result.analysis.evidenceId === evidence.id`
- `result.analysis.leadId === evidence.lead_id`
- `result.analysis.leadVersion === evidence.lead_version`

The real evidence columns are `id`, `lead_id`, and `lead_version`. Any one mismatch is `ANALYSIS_IDENTITY_MISMATCH`. Do not infer, repair, or replace the result identity with database values. Insert the identity columns from `result.analysis`.

`provider` must be exactly `gemini`. `model` and every attempted model must be an existing `GeminiModel`. A result that fails those provenance checks is `PERSISTENCE_FAILED` and is not inserted. Do not re-run `validateWebsiteAnalysis` and do not load `WebsiteFacts`. The analysis contract was already applied before this primitive receives the result.

## JSON serialization

`findings_json` and `attempted_models_json` are JSON text produced with ordinary `JSON.stringify` over the already validated values. Finding objects keep their known field order: `category`, `severity`, `observation`, `evidence`, `recommendation`. Finding array order and `attemptedModels` order are preserved. Do not sort, hash, compress, or send the JSON to blob storage. Do not add a canonical-JSON library or a JSON schema framework.

On read-back, parse the text, require the DQ-031 finding shape and bounds, require every attempted model to be a `GeminiModel`, and rebuild the frozen arrays. Corrupt or unparseable JSON is `PERSISTENCE_FAILED`.

## Append-only behavior

Each call inserts one new row. A second successful analysis for the same evidence inserts a second row. Re-analysis with a newer model, changed logic, changed prompt, or a later provider must not destroy prior rows.

The later migration adds triggers that reject `UPDATE` and `DELETE` on `website_analyses`, in the same way `single_page_crawl_evidence` rejects both. There is no update API and no delete functionality.

## Public API

```ts
persistD1WebsiteAnalysis(
  database: D1WebsiteAnalysisDatabase,
  result: GeminiWebsiteAnalysisResult,
  storedAt: string,
): Promise<StoredWebsiteAnalysis>
```

`D1WebsiteAnalysisDatabase` mirrors the minimal `D1CrawlDatabase` and statement surface in `src/crawler/d1-crawl-store.ts`: `prepare`, `bind`, `all`, `first`, and `run` with `meta.changes` and `meta.last_row_id`. It is local structural typing. It does not import Cloudflare SDK types and it is not a shared database framework.

`storedAt` is required input. The canonical value is `YYYY-MM-DDTHH:mm:ss.sssZ`, for example `2026-10-23T12:34:56.789Z`. Validation checks that the input is already that form, including a real calendar date, using the same structural rule as `attempted_at`. It does not generate a timestamp, trim the value into another zone, or convert time zones.

One call persists one result. There is no batch API, `saveMany`, `repository.insert`, or storage service.

## Error model

`WebsiteAnalysisPersistenceError` follows the existing frozen error style used by `CrawlEvidencePersistenceError` and `WebsiteAnalysisError`: one frozen code array, one fixed message per code, `readonly name = "WebsiteAnalysisPersistenceError"`, and `constructor(readonly code)`. It has no `cause`.

Codes:

- `EVIDENCE_NOT_FOUND` — no referenced crawl evidence. Message: `Crawl evidence was not found.`
- `EVIDENCE_NOT_ANALYZABLE` — the evidence row exists, but `outcome` is not `fetched`. Message: `Crawl evidence is not analyzable.`
- `ANALYSIS_IDENTITY_MISMATCH` — `evidenceId`, `leadId`, or `leadVersion` differs from the evidence row. Message: `Website analysis identity does not match the crawl evidence.`
- `PERSISTENCE_FAILED` — D1 operation failure, invalid insert metadata, a corrupt stored row, invalid stored JSON, an invalid stored provider or model, invalid `storedAt`, or failed read-back integrity. Message: `Website analysis persistence failed.`

Messages do not include secrets, SQL text, evidence bodies, or analysis content.

## Read-back integrity

Follow `persistD1CrawlEvidence`:

1. Insert one row.
2. Require exactly one inserted change and a positive safe-integer inserted id.
3. Select that row by id.
4. Require the row to exist.
5. Parse and validate every stored field, including both JSON columns, provider, model, and `stored_at`.
6. Require the returned id to equal the inserted id.
7. Return the validated frozen `StoredWebsiteAnalysis`.

Do not return an object built only from the in-memory input. A missing read-back row, a mismatched id, or a row that fails validation is `PERSISTENCE_FAILED`.

## Testing expectations

Future tests must cover these cases. This design does not write them.

- A successful analysis persists and round-trips as frozen `StoredWebsiteAnalysis`.
- A second analysis for the same evidence creates a second row.
- Missing evidence is `EVIDENCE_NOT_FOUND`.
- Failed evidence is `EVIDENCE_NOT_ANALYZABLE`.
- An `evidenceId`, `leadId`, or `leadVersion` mismatch is `ANALYSIS_IDENTITY_MISMATCH`.
- A D1 read failure, insert failure, bad insert metadata, missing read-back row, corrupt `findings_json`, corrupt `attempted_models_json`, invalid stored provider or model, and invalid `storedAt` are `PERSISTENCE_FAILED`.
- `UPDATE` and `DELETE` are rejected by the database.

Tests stay off production D1. They use the structural database seam and the explicit `storedAt` input.

## Explicit exclusions

DQ-034 does not add SQLite analysis persistence, DQ-033 to D1 wiring, D1 crawl-evidence selection, `WebsiteFacts` extraction orchestration, scheduled analysis, a GitHub Actions analysis workflow, a Worker analysis endpoint, production deployment, 50/day accounting, concurrency, queues, background workers, cross-provider fallback, Groq, Cloudflare Workers AI, OpenRouter, qualification, lead scoring, contact discovery, DNC execution, outreach, email sending, analysis failure history, an analysis attempt table, retry history, Gemini error logging, token accounting, cost accounting, latency accounting, a prompt version registry, a model registry, a repository abstraction, a generic persistence framework, a findings child table, or speculative indexes.

DQ-035 is not started.

## Future boundary

The later composition, not implemented here, is:

```text
D1 fetched crawl evidence
→ extractWebsiteFacts
→ runWebsiteAnalysis
→ one successful GeminiWebsiteAnalysisResult
→ persistD1WebsiteAnalysis
→ later qualification
```

DQ-034 implements only `persistD1WebsiteAnalysis`.
