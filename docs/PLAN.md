# Delta Qoralis Development Plan

## Product Direction

Delta Qoralis is being built incrementally into a human-controlled system that can discover businesses, inspect their websites, analyze improvement opportunities, qualify suitable leads, discover legitimate contact channels, and prepare professional outreach. After a useful lead-generation pipeline is established, later work may support client conversion, website delivery, payments, subscriptions, and operational workflows.

Each phase has a distinct responsibility and a reviewable output for the next phase. The separation prevents discovery from silently becoming contact, keeps crawling apart from analysis and qualification, and allows safety, auditability, reliability, and human approval to be established before greater autonomy is considered.

## Phase 0 — Foundation

**Status: Completed**

**Tasks: DQ-001–DQ-008**

Phase 0 established the technical and operational controls needed before building the product pipeline. The project now has modular boundaries, validated configuration, durable persistence, a central lead lifecycle, attributable audit history, safe network-target preparation, fail-closed do-not-contact protection, and a repeatable reviewed development workflow.

### Completed Capabilities

- **DQ-001 — Project Architecture:** Defined the modular TypeScript structure, feature boundaries, documentation base, and development conventions.
- **DQ-002 — Environment Configuration:** Centralized typed environment parsing with safe defaults and production validation.
- **DQ-003 — Database Layer:** Added the SQLite abstraction, bound operations, transactions, migrations, and persistent storage.
- **DQ-004 — Lead Lifecycle:** Added the persisted `BusinessLead`, lifecycle states, website observations, and stale-write protection.
- **DQ-005 — Audit Logging:** Added attributable append-only events committed atomically with lead mutations.
- **DQ-006 — SSRF-safe URL Handling:** Added public-network URL and DNS validation plus redirect revalidation for future outbound connections.
- **DQ-007 — Do-not-contact Protection:** Added one-way lead suppression and a fresh fail-closed contact guard.
- **DQ-008 — Git & GitHub Workflow:** Established feature branches, pull requests, CI, reviewed merges, and cleanup conventions.

### What Phase 0 Gives the Project

- A stable modular architecture for independently developed capabilities.
- SQLite persistence with deterministic migrations and transaction support.
- A durable `BusinessLead` state model with optimistic concurrency protection.
- Append-only, attributable audit history for implemented mutations.
- Safe preparation and approved-address results for future website networking.
- Persistent, fail-closed contact suppression before contact features exist.
- A repeatable Architect → Builder → Analyst → human-approved merge workflow.

### What Phase 0 Does Not Yet Provide

- Business discovery.
- Website fetching or crawling.
- Website analysis.
- Lead qualification.
- Contact discovery.
- Outreach drafting.
- Real email sending.

## Phase 1 — Lead Discovery

**Status: Completed**

**Tasks: DQ-010–015**

**Objective:** Build the first mechanism for discovering real candidate businesses through approved sources.

**Inputs:** Location, category, and search criteria together with future validated provider configuration.

**Expected outputs:** Traceable candidate `BusinessLead` records with preserved source provenance, ready to be handed to website investigation.

**Important boundaries:** Discovery will use approved APIs or sources, will not scrape Google Maps pages directly, will not contact businesses, and will not crawl websites except through explicitly designed later phases. Provider behavior, normalization, filtering, and deduplication must be architected within the DQ-010–015 range before implementation.

### Approved Sequence

- **DQ-010 — Discovery Domain and Provider Contract (Completed):** Established bounded criteria, normalized candidate outcomes, page validation, and the provider-independent asynchronous contract.
- **DQ-011 — Audited Discovery Provenance and Idempotent Lead Creation (Completed):** Added traceable, idempotent persistence for discovered leads.
- **DQ-012 — First-provider Eligibility and Explicit Configuration (Completed):** Selected Geoapify Places and added disabled-by-default explicit configuration without implementing its adapter.
- **DQ-013 — First Approved API Provider Adapter (Completed):** Implemented one bounded Geoapify page adapter with fixed transport, strict normalization, and instance-local continuation cursors.
- **DQ-014 — Bounded Discovery Run and Persistence Orchestration (Completed):** Coordinate one injected provider across bounded pages and persist accepted outcomes through the existing lead boundary.
- **DQ-015 — Controlled Discovery Command and Phase 1 Integration (Completed):** Added one operator command that loads approved configuration, opens the existing lead database, constructs one Geoapify provider, and calls `runBoundedDiscovery` once for an explicit human actor.

Phase 1 is complete. Current phase status is recorded under Current Position.

### Completion Outcome

Phase 1 can turn approved search criteria into a reviewable set of persisted candidate leads with enough provenance to understand where every candidate came from. The controlled command is the only discovery entry. It does not crawl websites, discover contacts, or send outreach.

## Phase 2 — Website Crawling

**Status: Completed**

**Tasks: DQ-020–025**

**Objective:** Safely retrieve website content from selected candidate leads.

**Dependencies:** DQ-006 network-target validation and its approved-address model.

**Expected output:** Bounded, structured crawl evidence that later analysis can inspect.

**Important boundaries:** Crawling must enforce SSRF controls, manually validate redirects, connect only to approved targets, and apply explicit time, size, and resource limits. It gathers content and metadata but does not produce qualification conclusions.

### DQ-020 — One-Page Pinned Crawl Fetch

**Status: Completed**

`DQ-020 — One-Page Pinned Crawl Fetch` is this architecture's decomposition of the grouped Phase 2 crawling work. It is not an old backlog title. It fetches one untrusted URL into one frozen HTML page. Every hop uses DQ-006. The socket is pinned to the first approved address. Redirects are revalidated. At most five redirects are followed, and an HTTPS-to-HTTP hop is refused. DQ-020 does not persist the page. There is no crawl command, spider, analysis, contact extraction, or outreach.

### DQ-021 — Lead-Linked Single-Page Crawl Evidence

**Status: Completed**

`DQ-021 — Lead-Linked Single-Page Crawl Evidence` is this architecture's decomposition of the next Phase 2 slice. One caller-held `BusinessLead` whose website observation is present becomes one frozen in-memory evidence value. The stored URL is passed unchanged to `fetchCrawlPage` once and remains untrusted. A returned page becomes fetched evidence. A `NetworkTargetError` or `CrawlPageError` becomes failed evidence with that code. Any other error propagates. `attemptedAt` records when the attempt began, and `leadVersion` is the caller snapshot's lead version. The lead and its observation stay unchanged. DQ-021 does not persist, write an audit event, select leads, batch, add a command, spider, analyze, discover contacts, or send outreach.

### DQ-022 — Persisted Single-Page Crawl Evidence

**Status: Completed**

`DQ-022 — Persisted Single-Page Crawl Evidence` stores one already-built fetched or failed single-page attempt and reads that attempt back by id. The row is append-only history. `leadVersion` and the requested URL stay as they were on the evidence, even after the lead version or website URL changes. HTML is untrusted stored text. A failed attempt stores an allowlisted code and no raw error message. The lead row is not changed. There is no lead selection, crawl command, spider, list of attempts, audit event, actor, analysis, contact extraction, or outreach.

### DQ-023 — Bounded Single-Page Crawl Run

**Status: Completed**

`DQ-023 — Bounded Single-Page Crawl Run` selects at most 60 eligible `BusinessLead` snapshots in one read transaction, then crawls them one at a time. The read ends before collection. Eligible leads are `recorded` or `reviewing` with a present website URL, manual or discovered. Archived, unknown, and missing leads are excluded. Suppression is not consulted. A finished attempt for the exact current URL blocks another automatic selection. `CANCELLED` does not. Each returned attempt is persisted immediately. The run does not retry. The result is five counters and a stop. There is no migration, index, crawl command, actor, audit event, analysis, contact extraction, or outreach.

### DQ-024 — D1 Crawl Store and Async Run Core

**Status: Completed**

`DQ-024 — D1 Crawl Store and Async Run Core` keeps the local Node crawl entry and adds a runtime-neutral async loop plus a D1 crawl store. The store covers `business_leads` and `single_page_crawl_evidence` only. Miniflare module mode is test infrastructure. It is not a deployed module Worker. DQ-024 does not deploy a Worker, add Cron, create a production D1 database, or perform a deployment. The local Node crawler still runs.

### DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway

**Status: Completed**

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is completed. Production activation was verified through GitHub Actions run 39773510876. That `workflow_dispatch` run on `main` at `a1ad31fddfcd9860f37320d46461062afa7644bf` succeeded: selected 1, attempted 1, fetched 1, failed 0, persisted 1. The stored evidence outcome was fetched for `https://example.com/`, HTTP 200, `text/html`.

The active path is a GitHub Actions scheduled or manual run, then the Node crawl runner, then the authenticated Worker gateway for D1 select and persist. The same Node runner uses the existing DQ-020 pinned transport to fetch the public website, and evidence is persisted to production D1. The Worker does not fetch business websites.

Discovery still uses local SQLite. Discovery does not currently feed production D1 automatically. The whole discovery-to-crawl pipeline is not autonomous. What is autonomous is an eligible production D1 lead, then the scheduled GitHub Actions crawl, then production D1 evidence.

The production crawl workflow is active at cron `17 6 * * *` with timezone `Europe/Warsaw`, and `workflow_dispatch`. Mac participation is not required for scheduled runtime execution.

## Phase 3 — Website Analysis

**Status: Current**

**Tasks: DQ-030–039**

**Objective:** Turn stored crawl results into structured observations about website quality, missing capabilities, and potential improvement opportunities.

**Expected output:** Reviewable `WebsiteAudit` information and supporting evidence that qualification can consume.

Phase 3 is current and is not complete. DQ-030, DQ-031, DQ-032, DQ-033, DQ-034, DQ-035, and DQ-036 are completed. DQ-037–039 remain planned and have not yet been architected. Analysis remains separate from contact and outreach. Single-website Gemini analysis exists, and DQ-033 provides a bounded run for an explicit `WebsiteFacts[]` input. One run accepts 0–50 unique `evidenceId` values. Analysis is strictly sequential. Known per-website failures stay on that website. Only `GEMINI_TRANSPORT_UNAVAILABLE` is deferred, and that website is retried once, no earlier than its first transport failure plus 90 seconds, in one retry round only. The run returns ordered terminal results. 50/run is not 50/day. DQ-034 persists one successful Gemini analysis in append-only D1 when the referenced fetched crawl evidence matches exactly. DQ-035 is a D1-backed bounded analysis pipeline. One invocation selects 0–50 fetched crawl-evidence rows, excludes any evidence that already has a `website_analyses` row, and orders the rows by `attempted_at ASC, id ASC`. Stored evidence is reconstructed with `evidenceFromRow`. Facts come from `extractWebsiteFacts`. Selected facts go through one DQ-033 `runWebsiteAnalysis` invocation. Successful terminal results persist through DQ-034. Failed terminal results persist nothing and remain eligible later. Persistence is sequential, and partial successful persistence remains durable if a later persistence call fails. `storedAt` is owned by DQ-035. `website_analyses_evidence_id_idx` is non-unique, and multiple historical analyses for the same evidence remain supported. DQ-035 does not add a scheduler, a GitHub Actions analysis workflow, a Worker analysis endpoint, a production analysis deployment, 50/day accounting, failure-history or analysis-attempt persistence, a lock, lease, or claim, qualification, contacts, or outreach. DQ-036 adds `POST /internal/analysis/run` to the existing Worker `delta-qoralis-crawl-gateway`. It uses `ANALYSIS_GATEWAY_TOKEN` for the analysis route. Existing crawl routes continue using `CRAWL_GATEWAY_TOKEN`. The body has exactly one key, `maxItems`, an integer from 0 through 50 inclusive. The route performs analysis authentication, strict request validation, focused `GEMINI_API_KEY` validation, `runD1WebsiteAnalysisPipeline`, and a safe DQ-035 count summary. It reuses DQ-035 and does not duplicate selection, facts, Gemini fallback, retry, or persistence. It does not expose analysis contents or secrets. Existing crawl routes stay compatible. The next Phase 3 slice begins with DQ-037 and has not yet been architected. Groq, Cloudflare Workers AI, and OpenRouter remain unimplemented. A validator is not AI analysis.

### DQ-030 — Deterministic Website Facts

**Status: Completed**

`DQ-030 — Deterministic Website Facts` consumes one persisted fetched crawl evidence record. `extractWebsiteFacts` returns one frozen deterministic `WebsiteFacts` value. It extracts metadata and objective structural facts, and creates cleaned visible text capped at 12,000 UTF-16 code units. Failed evidence is rejected with `WebsiteFactsError` and code `EVIDENCE_NOT_ANALYZABLE`. It uses stored HTML only. It performs no network request, no AI analysis, no persistence, no qualification, and no outreach.

### DQ-031 — Provider-Neutral Website Analysis Contract

**Status: Completed**

`DQ-031 — Provider-Neutral Website Analysis Contract` validates one untrusted candidate against one `WebsiteFacts` value. `validateWebsiteAnalysis` returns one frozen provider-neutral `WebsiteAnalysis`, or throws `WebsiteAnalysisError`. Categories are design, usability, seo, accessibility, and conversion. Severities are low, medium, and high. Every finding requires evidence. At most 8 findings are accepted, and at most 3 findings are accepted in one category. Identity must match the supplied `WebsiteFacts`. It performs no AI call. It does not add a provider adapter, real AI analysis, fallback routing, 50/day enforcement, persistence, qualification, contacts, or outreach.

### DQ-032 — Gemini Website Analysis Adapter

**Status: Completed**

`DQ-032 — Gemini Website Analysis Adapter` analyzes one `WebsiteFacts` value with Gemini through direct REST. It uses transport-only fallback across `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-flash-lite`, validates the candidate with `validateWebsiteAnalysis()`, and returns one `WebsiteAnalysis` plus provider, model, and attempted models. It does not add a multi-website run, a 90-second retry, a 50/day budget, persistence, cross-provider fallback, qualification, contacts, or outreach.

### DQ-033 — Bounded Website Analysis Run

**Status: Completed**

`DQ-033 — Bounded Website Analysis Run` provides an explicit `WebsiteFacts[]` input and runs it through `analyzeWebsiteWithGemini`. One run accepts 0–50 unique `evidenceId` values. More than 50 items, or a duplicate `evidenceId`, rejects the whole run. Analysis is strictly sequential. Known per-website failures, including known Gemini failures and `WebsiteAnalysisError`, stay on that website and do not stop the next website. Only `GEMINI_TRANSPORT_UNAVAILABLE` is deferred. That website is retried once, no earlier than its first transport failure plus 90 seconds, and only after the first pass finishes. There is one retry round only. The run returns ordered terminal results in original input order. 50/run is not 50/day. DQ-033 does not select crawl evidence from D1, load crawl evidence from SQLite, persist website analyses, implement daily accounting, add concurrency, add cross-provider fallback, qualify leads, discover contacts, or perform outreach.

### DQ-034 — D1 Website Analysis Persistence

**Status: Completed**

D1 is the authoritative website-analysis store. `persistD1WebsiteAnalysis()` persists one successful `GeminiWebsiteAnalysisResult`. The referenced `single_page_crawl_evidence` row must exist and have `outcome = 'fetched'`. `evidenceId`, `leadId`, and `leadVersion` must match exactly. `website_analyses` is append-only. Multiple analyses for the same evidence are allowed. Successful analysis plus Gemini provenance is stored: summary, findings, provider, successful model, attempted models, and explicit `storedAt`. Findings and attempted models are stored as JSON text and validated on read-back. INSERT metadata and the persisted row are verified before returning a frozen `StoredWebsiteAnalysis`. DQ-034 does not add SQLite analysis persistence, DQ-033 wiring, selection, scheduler, Worker endpoint, qualification, contacts, or outreach.

### DQ-035 — Bounded D1 Website Analysis Pipeline

**Status: Completed**

`runD1WebsiteAnalysisPipeline` is a D1-backed bounded analysis pipeline. One invocation selects 0–50 fetched crawl-evidence rows. Evidence with any existing `website_analyses` row is excluded. Order is `attempted_at ASC, id ASC`. Stored evidence is reconstructed with `evidenceFromRow`. Facts come from `extractWebsiteFacts`. Selected facts go through one DQ-033 `runWebsiteAnalysis` invocation. Successful terminal results persist through DQ-034. Failed terminal results persist nothing and remain eligible later. Persistence is sequential. Partial successful persistence remains durable if a later persistence call fails. `storedAt` is owned by DQ-035. `website_analyses_evidence_id_idx` is non-unique, and multiple historical analyses for the same evidence remain supported. The returned summary is a frozen count object. DQ-035 does not add a scheduler, a GitHub Actions analysis workflow, a Worker analysis endpoint, a production analysis deployment, 50/day accounting, failure-history or analysis-attempt persistence, a lock, lease, or claim, qualification, contacts, or outreach.

### DQ-036 — Manual Authenticated Website Analysis Runtime

**Status: Completed**

`DQ-036 — Manual Authenticated Website Analysis Runtime` adds `POST /internal/analysis/run` to the existing Worker `delta-qoralis-crawl-gateway`. The analysis route uses `ANALYSIS_GATEWAY_TOKEN`. Existing crawl routes continue using `CRAWL_GATEWAY_TOKEN`. The body has exactly one key, `maxItems`, an integer from 0 through 50 inclusive. The route performs analysis authentication, strict request validation, focused `GEMINI_API_KEY` validation, `runD1WebsiteAnalysisPipeline`, and a safe DQ-035 count summary. It reuses DQ-035 and does not duplicate selection, facts, Gemini fallback, retry, or persistence. It does not expose analysis contents or secrets. Existing crawl routes stay compatible. DQ-036 does not add an analysis scheduler, a GitHub Actions analysis workflow, automatic analysis execution, 50/day accounting, failure-history persistence, a lock, lease, or claim, an additional AI provider, qualification, contact discovery, or outreach or mailing.

## Phase 4 — Qualification

**Status: Planned**

**Tasks: DQ-040–043**

**Objective:** Decide which businesses are worth progressing using explicit criteria and collected evidence.

**Expected output:** Qualified or rejected lead state with understandable supporting evidence or classification.

Qualification indicates commercial suitability; it does not grant permission to contact a business and cannot override suppression or later approval requirements.

## Phase 5 — Contact Discovery

**Status: Planned**

**Tasks: DQ-050–054**

**Objective:** Find legitimate public business contact information for leads that are eligible to progress.

**Dependency:** DQ-007 do-not-contact protection.

**Expected output:** Traceable contact records with source provenance and validation state.

Suppression must be checked before relevant contact-related actions, and failures must not become implicit permission. The phase should avoid speculative or private personal data and does not itself send outreach.

## Phase 6 — Outreach

**Status: Planned**

**Tasks: DQ-060–066**

**Objective:** Turn qualified leads and traceable contacts into professional outreach drafts.

**Expected output:** Reviewable outreach messages, potentially in plain-text and HTML forms where useful.

Drafting requires current lead context, fresh suppression checks, and explicit approval gates. This phase does not assume autonomous sending; real delivery remains separately designed and authorized later work.

## Phase 7 — MVP Pipeline

**Status: Planned**

**Tasks: DQ-070–072**

**Objective:** Connect the previous phases into a controlled end-to-end workflow with recoverable state, audit history, safety gates, and human checkpoints.

### Conceptual Flow

Discovery → Crawl → Analyze → Qualify → Contact discovery → Contact guard → Draft outreach → Human review

**Expected result:** The first usable Delta Qoralis lead-generation MVP, able to move candidates through a reviewable pipeline without silently bypassing controls or sending messages autonomously.

## Later — Delivery and Controlled Autonomy

**Status: Later**

After the controlled MVP, separately architected work may add approved real sending, incoming reply handling, reply drafting, lead-to-client conversion, requirements gathering, website creation, revision loops, client previews, project repository creation, deployment, payments, subscriptions, and support operations. Expanded automation may follow only after the relevant safety controls, approval policy, auditability, reliability, and operational testing are established.

These capabilities require new backlog items and are **not currently implemented**.

## Current Position

Phase 0 — Foundation: Completed.

Phase 1 — Lead Discovery: Completed.

DQ-010 — Discovery Domain and Provider Contract: Completed.

DQ-011 — Audited Discovery Provenance and Idempotent Lead Creation: Completed.

DQ-012 — First-provider Eligibility and Explicit Configuration: Completed.

DQ-013 — First Approved API Provider Adapter: Completed.

DQ-014 — Bounded Discovery Run and Persistence Orchestration: Completed.

DQ-015 — Controlled Discovery Command and Phase 1 Integration: Completed.

Phase 2 — Website Crawling: Completed.

DQ-020 — One-Page Pinned Crawl Fetch: Completed.

DQ-021 — Lead-Linked Single-Page Crawl Evidence: Completed.

DQ-022 — Persisted Single-Page Crawl Evidence: Completed.

DQ-023 — Bounded Single-Page Crawl Run: Completed.

DQ-024 — D1 Crawl Store and Async Run Core: Completed.

DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway: Completed. Production activation was verified through GitHub Actions run 39773510876.

Phase 3 — Website Analysis: Current. DQ-030, DQ-031, DQ-032, DQ-033, DQ-034, DQ-035, and DQ-036 are completed. DQ-037–039 remain planned and have not yet been architected.

DQ-030 — Deterministic Website Facts: Completed.

DQ-031 — Provider-Neutral Website Analysis Contract: Completed.

DQ-032 — Gemini Website Analysis Adapter: Completed.

DQ-033 — Bounded Website Analysis Run: Completed.

DQ-034 — D1 Website Analysis Persistence: Completed.

DQ-035 — Bounded D1 Website Analysis Pipeline: Completed.

DQ-036 — Manual Authenticated Website Analysis Runtime: Completed.

## Next Planned Step

Phase 3 — Website Analysis is current and is not complete. DQ-030, DQ-031, DQ-032, DQ-033, DQ-034, DQ-035, and DQ-036 are completed. DQ-037–039 remain planned and have not yet been architected. The next Phase 3 slice begins with DQ-037 and has not yet been architected. DQ-036 adds `POST /internal/analysis/run` to the existing Worker `delta-qoralis-crawl-gateway`. The analysis route uses `ANALYSIS_GATEWAY_TOKEN`. Existing crawl routes continue using `CRAWL_GATEWAY_TOKEN`. The body has exactly one key, `maxItems`, an integer from 0 through 50 inclusive. The route performs analysis authentication, strict request validation, focused `GEMINI_API_KEY` validation, `runD1WebsiteAnalysisPipeline`, and a safe DQ-035 count summary. It reuses DQ-035 and does not duplicate selection, facts, Gemini fallback, retry, or persistence. It does not expose analysis contents or secrets. Existing crawl routes stay compatible. There is still no analysis scheduler, no GitHub Actions analysis workflow, and no automatic analysis execution. There is still no production analysis deployment. There is still no 50/day accounting. There is still no failure-history persistence. There is still no lock, lease, or claim. There is still no additional AI provider. There is still no qualification. There is still no contact discovery. There is still no outreach or mailing. Groq, Cloudflare Workers AI, and OpenRouter remain unimplemented. DQ-020 through DQ-025 are completed. Discovery still uses local SQLite and does not feed production D1 automatically. Scheduled crawling of an eligible production D1 lead does not require the Mac.
