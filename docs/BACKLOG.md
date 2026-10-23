# Delta Qoralis Backlog

## Current Status

Phase 0 — Foundation is completed. Phase 1 — Lead Discovery is completed. DQ-010, DQ-011, DQ-012, DQ-013, DQ-014, and DQ-015 are completed. Phase 2 — Website Crawling is completed. DQ-020 through DQ-025 are completed. Production activation was verified through GitHub Actions run 39773510876. Discovery still uses local SQLite and does not feed production D1 automatically. The autonomous path is an eligible production D1 lead, then the scheduled GitHub Actions crawl, then production D1 evidence. Phase 3 — Website Analysis is current and is not complete. DQ-030 — Deterministic Website Facts is completed. DQ-031 — Provider-Neutral Website Analysis Contract is completed. DQ-032 — Gemini Website Analysis Adapter is completed. DQ-033 — Bounded Website Analysis Run is completed. DQ-034 — D1 Website Analysis Persistence is completed. DQ-035 — Bounded D1 Website Analysis Pipeline is completed. DQ-036 — Manual Authenticated Website Analysis Runtime is completed. DQ-037–039 remain planned and have not yet been architected. The next Phase 3 slice begins with DQ-037 and has not yet been architected. DQ-036 adds `POST /internal/analysis/run` to the existing Worker `delta-qoralis-crawl-gateway`. It uses `ANALYSIS_GATEWAY_TOKEN` for the analysis route. Existing crawl routes continue using `CRAWL_GATEWAY_TOKEN`. The body has exactly one key, `maxItems`, an integer from 0 through 50 inclusive. The route performs analysis authentication, strict request validation, focused `GEMINI_API_KEY` validation, `runD1WebsiteAnalysisPipeline`, and a safe DQ-035 count summary. It reuses DQ-035 and does not duplicate selection, facts, Gemini fallback, retry, or persistence. It does not expose analysis contents or secrets. Existing crawl routes stay compatible. There is still no analysis scheduler, no GitHub Actions analysis workflow, and no automatic analysis execution. There is still no production analysis deployment. There is still no 50/day accounting. There is still no failure-history persistence. There is still no lock, lease, or claim. There is still no additional AI provider. There is still no qualification. There is still no contact discovery. There is still no outreach or mailing. Groq, Cloudflare Workers AI, and OpenRouter remain unimplemented. A validator is not AI analysis.

## P0 — Foundation

**Status: Completed**

### DQ-001 — Project Architecture

**Status: Completed**

Established a modular TypeScript architecture with explicit boundaries for configuration, persistence, leads, discovery, crawling, analysis, contacts, outreach, and later operational capabilities. The initial documentation and architectural conventions define how those modules should collaborate without collapsing into one tightly coupled system. This foundation lets later capabilities be designed, tested, and replaced independently.

### DQ-002 — Environment Configuration

**Status: Completed**

Added typed, validated environment configuration with safe development and test defaults and stricter production requirements. Future provider variables are documented as placeholders without activating or integrating those providers. Centralized parsing prevents feature modules from reading scattered raw environment values or accidentally exposing invalid configuration data.

### DQ-003 — Database Layer

**Status: Completed**

Added a small database abstraction backed by SQLite, including bound query parameters, transactions, deterministic migrations, and file-backed persistence across reopen. Domain modules can depend on the abstraction instead of importing the SQLite driver directly. This provides the durable and testable storage foundation used by lead lifecycle, audit, and compliance features.

### DQ-004 — Lead Lifecycle

**Status: Completed**

Introduced the persisted `BusinessLead` with manual source provenance, `recorded`, `reviewing`, and `archived` lifecycle states, and explicit website-presence observations. Optimistic versioning rejects stale writes and preserves a clear sequence of state changes. This lead record is the central state model that future discovery and qualification work will populate and progress.

### DQ-005 — Audit Logging

**Status: Completed**

Added append-only audit history with claimed human or system actor attribution and strictly typed event details. Lead creation, status changes, and website-observation changes commit their audit event in the same transaction as the mutation. This traceability is essential before later agent automation can make or propose consequential changes.

### DQ-006 — SSRF-safe URL Handling

**Status: Completed**

Separated network-target validation from ordinary URL storage and added an HTTP(S)-only safety policy for future outbound connections. Local, private, metadata, reserved, and other special addresses are rejected; every DNS answer is validated, and mixed safe/unsafe results fail closed. Redirects require fresh validation, and successful resolution returns an approved address set that a future transport can pin to avoid a second DNS lookup. DQ-006 does **not** crawl or fetch websites yet.

### DQ-007 — Do-not-contact Protection

**Status: Completed**

Added one persistent, one-way suppression row per lead with `manual` or `requested` reason and explicit human or system actor attribution. A fail-closed guard blocks suppressed and archived leads, and missing, malformed, or unreadable state never becomes permission to proceed. The first suppression and its audit event commit atomically, while repeated valid applications preserve the original record. Future contact discovery and outreach must check this control before relevant contact-related actions.

### DQ-008 — Git & GitHub Development Foundation

**Status: Completed**

Established the feature-branch, pull-request, CI, reviewed-merge, and post-merge cleanup workflow used by the project. Substantial implementation work follows the Architect → Builder → Analyst sequence, with human approval before high-impact progression. This creates a repeatable development process in which changes are isolated, validated, reviewed, and merged without rewriting shared history.

## P1 — Lead Discovery

**Status: Completed**

### DQ-010 — Discovery Domain and Provider Contract

**Status: Completed**

Define bounded search criteria, provider-independent normalized candidate outcomes, page validation, and the asynchronous provider boundary. This task does not activate a provider, perform network access, or persist discovered leads.

### DQ-011 — Audited Discovery Provenance and Idempotent Lead Creation

**Status: Completed**

Persist discovered leads with source provenance, idempotency, and atomic audit history.

### DQ-012 — First-provider Eligibility and Explicit Configuration

**Status: Completed**

Select Geoapify Places as the first eligible provider and add disabled-by-default, explicit, validated configuration without adding provider transport or requests.

### DQ-013 — First Approved API Provider Adapter

**Status: Completed**

Implement one bounded Geoapify provider behind the discovery contract. It supports four exact query mappings, city-scoped Places search, OSM-only identity, search-result website normalization, credential-safe fixed-endpoint transport, and an authenticated instance-local continuation cursor. It does not run multi-page discovery or persist results.

### DQ-014 — Bounded Discovery Run and Persistence Orchestration

**Status: Completed**

Run one injected discovery provider across bounded pages and persist accepted outcomes through `recordDiscoveredLead`. A valid page consumes one examined slot per normalized outcome before persistence. The frozen summary reports those slots separately from successful writes. Rejected outcomes are not persisted. The run does not construct a provider, read configuration, decode cursors, retry, or add a command.

### DQ-015 — Controlled Discovery Command and Phase 1 Integration

**Status: Completed**

Expose the completed discovery flow through one controlled command, `npm run discover`. The command parses location, query, an explicit human actor, and an optional examined-slot budget, then calls `runBoundedDiscovery` once with the Geoapify provider. It prints the run summary and the approved attribution lines. It does not crawl websites, discover contacts, or send outreach.

## P2–P7 — Planned Product Pipeline

### DQ-020 — One-Page Pinned Crawl Fetch

**Status: Completed**

`DQ-020 — One-Page Pinned Crawl Fetch` is this architecture's decomposition of the grouped Phase 2 crawling work. It is not an old backlog title. One untrusted URL becomes one frozen HTML page. Every connection goes through DQ-006, the socket is pinned to the first approved address, and redirects are revalidated. The fetcher does not add a crawl command, a spider, analysis, contact extraction, outreach, or crawl persistence.

### DQ-021 — Lead-Linked Single-Page Crawl Evidence

**Status: Completed**

`DQ-021 — Lead-Linked Single-Page Crawl Evidence` joins one caller-held `BusinessLead` to one `fetchCrawlPage` call. A present website observation is required. The stored URL is passed unchanged and remains untrusted. The result is one frozen in-memory evidence value: fetched HTML, or a failed attempt whose code is a known `NetworkTargetError` or `CrawlPageError` code. Other errors propagate. The lead, the observation, and the database stay unchanged by DQ-021. DQ-021 does not select leads, batch, add a command, spider, analyze, discover contacts, or send outreach.

### DQ-022 — Persisted Single-Page Crawl Evidence

**Status: Completed**

`DQ-022 — Persisted Single-Page Crawl Evidence` stores one already-built single-page attempt, fetched or failed, and reads it back by id. The table is append-only. HTML is untrusted stored data. A failure stores an allowlisted code and no raw error message. The current lead version and website URL do not rewrite the attempt. There is no lead selection, crawl command, spider, attempt list, audit event, or actor.

### DQ-023 — Bounded Single-Page Crawl Run

**Status: Completed**

`DQ-023 — Bounded Single-Page Crawl Run` selects at most 60 eligible lead snapshots, crawls them one at a time, and persists each finished attempt immediately. Eligible leads are recorded or reviewing, with a present website, manual or discovered. Archived, unknown, and missing leads are excluded. Suppression is not a crawl gate. A finished attempt for the exact current URL blocks another automatic selection. `CANCELLED` does not. The result is five counters and a stop. There is no migration, index, crawl command, retry, actor, audit event, analysis, contact extraction, or outreach.

### DQ-024 — D1 Crawl Store and Async Run Core

**Status: Completed**

`DQ-024 — D1 Crawl Store and Async Run Core` separates the bounded crawl loop from the Node database and adds a D1 store for `business_leads` and `single_page_crawl_evidence`. The local Node crawler still runs. Miniflare module mode is test infrastructure only and is not a deployed module Worker. DQ-024 does not deploy a Worker, add Cron, create a production D1 database, or perform a deployment.

### DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway

**Status: Completed**

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is completed. Production activation was verified through GitHub Actions run 39773510876. That `workflow_dispatch` run on `main` at `a1ad31fddfcd9860f37320d46461062afa7644bf` succeeded: selected 1, attempted 1, fetched 1, failed 0, persisted 1. The stored evidence outcome was fetched for `https://example.com/`, HTTP 200, `text/html`.

The active path is a GitHub Actions scheduled or manual run, then the Node crawl runner, then the authenticated Worker gateway for D1 select and persist. The same Node runner uses the existing DQ-020 pinned transport to fetch the public website, and evidence is persisted to production D1. The Worker does not fetch business websites. The production crawl workflow is active at cron `17 6 * * *` with timezone `Europe/Warsaw`, and `workflow_dispatch`. Mac participation is not required for scheduled runtime execution. Discovery still uses local SQLite and does not currently feed production D1 automatically.

The crawl still uses the network-target safety established by DQ-006. Crawling uses bounded HTTP behavior, manually validated redirects, and resource limits. One bounded run selects leads and stores each finished attempt. The Worker does not fetch business websites. The crawler gathers evidence but does not decide whether a business is qualified. The expected output is structured crawl results ready for website analysis.

### DQ-030 — Deterministic Website Facts

**Status: Completed**

`DQ-030 — Deterministic Website Facts` consumes one persisted fetched crawl evidence record. `extractWebsiteFacts` returns one frozen deterministic `WebsiteFacts` value. It extracts metadata and objective structural facts, and creates cleaned visible text capped at 12,000 UTF-16 code units. Failed evidence is rejected with `WebsiteFactsError` and code `EVIDENCE_NOT_ANALYZABLE`. It uses stored HTML only. It performs no network request, no AI analysis, no persistence, no qualification, and no outreach.

### DQ-031 — Provider-Neutral Website Analysis Contract

**Status: Completed**

`DQ-031 — Provider-Neutral Website Analysis Contract` validates one untrusted candidate against one `WebsiteFacts` value. `validateWebsiteAnalysis` returns one frozen provider-neutral `WebsiteAnalysis`, or throws `WebsiteAnalysisError`. Categories are design, usability, seo, accessibility, and conversion. Severities are low, medium, and high. Every finding requires evidence. At most 8 findings are accepted, and at most 3 findings are accepted in one category. Identity must match the supplied `WebsiteFacts`. It performs no AI call. It does not add a provider adapter, real AI analysis, fallback routing, 50/day enforcement, persistence, qualification, contacts, or outreach. A validator is not AI analysis.

### DQ-032 — Gemini Website Analysis Adapter

**Status: Completed**

`DQ-032 — Gemini Website Analysis Adapter` analyzes one `WebsiteFacts` value with Gemini through direct REST. It uses transport-only fallback across `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, and `gemini-3.1-flash-lite`, validates the candidate with `validateWebsiteAnalysis()`, and returns one `WebsiteAnalysis` plus provider, model, and attempted models. Single-website Gemini analysis now exists. It does not add a multi-website run, a 90-second retry, a 50/day budget, persistence, cross-provider fallback, qualification, contacts, or outreach.

### DQ-033 — Bounded Website Analysis Run

**Status: Completed**

`DQ-033 — Bounded Website Analysis Run` provides an explicit `WebsiteFacts[]` input and runs it through `analyzeWebsiteWithGemini`. One run accepts 0–50 unique `evidenceId` values. More than 50 items, or a duplicate `evidenceId`, rejects the whole run. Analysis is strictly sequential. Known per-website failures, including known Gemini failures and `WebsiteAnalysisError`, stay on that website and do not stop the next website. Only `GEMINI_TRANSPORT_UNAVAILABLE` is deferred. That website is retried once, no earlier than its first transport failure plus 90 seconds, and only after the first pass finishes. There is one retry round only. The run returns ordered terminal results in original input order. 50/run is not 50/day. DQ-033 does not select crawl evidence from D1, load crawl evidence from SQLite, persist website analyses, implement daily accounting, add concurrency, add cross-provider fallback, qualify leads, discover contacts, or perform outreach.

### DQ-034 — D1 Website Analysis Persistence

**Status: Completed**

D1 is the authoritative website-analysis store. `persistD1WebsiteAnalysis()` persists one successful `GeminiWebsiteAnalysisResult`. The referenced `single_page_crawl_evidence` row must exist and have `outcome = 'fetched'`. `evidenceId`, `leadId`, and `leadVersion` must match exactly. `website_analyses` is append-only. Multiple analyses for the same evidence are allowed. Successful analysis plus Gemini provenance is stored: summary, findings, provider, successful model, attempted models, and explicit `storedAt`. Findings and attempted models are stored as JSON text and validated on read-back. INSERT metadata and the persisted row are verified before returning a frozen `StoredWebsiteAnalysis`. DQ-034 does not add SQLite analysis persistence and does not wire DQ-033 to persistence automatically.

### DQ-035 — Bounded D1 Website Analysis Pipeline

**Status: Completed**

`runD1WebsiteAnalysisPipeline` selects 0–50 fetched crawl-evidence rows from D1. Evidence with any existing `website_analyses` row is excluded. Order is `attempted_at ASC, id ASC`. Stored evidence is reconstructed with `evidenceFromRow`. Facts come from `extractWebsiteFacts`. Selected facts go through one DQ-033 `runWebsiteAnalysis` invocation. Successful terminal results persist through DQ-034. Failed terminal results persist nothing and remain eligible later. Persistence is sequential. Partial successful persistence remains durable if a later persistence call fails. `storedAt` is owned by DQ-035. `website_analyses_evidence_id_idx` is non-unique, and multiple historical analyses for the same evidence remain supported. DQ-035 does not add a scheduler, a GitHub Actions analysis workflow, a Worker analysis endpoint, a production analysis deployment, 50/day accounting, failure-history or analysis-attempt persistence, a lock, lease, or claim, qualification, contacts, or outreach.

### DQ-036 — Manual Authenticated Website Analysis Runtime

**Status: Completed**

`DQ-036 — Manual Authenticated Website Analysis Runtime` adds `POST /internal/analysis/run` to the existing Worker `delta-qoralis-crawl-gateway`. The analysis route uses `ANALYSIS_GATEWAY_TOKEN`. Existing crawl routes continue using `CRAWL_GATEWAY_TOKEN`. The body has exactly one key, `maxItems`, an integer from 0 through 50 inclusive. The route performs analysis authentication, strict request validation, focused `GEMINI_API_KEY` validation, `runD1WebsiteAnalysisPipeline`, and a safe DQ-035 count summary. It reuses DQ-035 and does not duplicate selection, facts, Gemini fallback, retry, or persistence. It does not expose analysis contents or secrets. Existing crawl routes stay compatible. DQ-036 does not add an analysis scheduler, a GitHub Actions analysis workflow, automatic analysis execution, 50/day accounting, failure-history persistence, a lock, lease, or claim, an additional AI provider, qualification, contact discovery, or outreach or mailing.

### DQ-037–039 — Website Analysis

**Status: Planned**

Phase 3 — Website Analysis remains current and is not complete. DQ-037–039 remain planned and have not yet been architected. The next Phase 3 slice begins with DQ-037 and has not yet been architected. There is still no analysis scheduler, no GitHub Actions analysis workflow, and no automatic analysis execution. There is still no production analysis deployment. There is still no 50/day accounting. There is still no failure-history persistence. There is still no lock, lease, or claim. There is still no additional AI provider. There is still no qualification. There is still no contact discovery. There is still no outreach or mailing. Groq, Cloudflare Workers AI, and OpenRouter remain unimplemented. Later analysis may inspect stored crawl evidence for outdated design, poor usability, missing functionality, or other potential improvement opportunities, and produce structured observations linked to supporting evidence. The expected output is website audit information for qualification, not contact or outreach activity.

### DQ-040–043 — Qualification

Decide which leads are commercially relevant using explicit rules and the evidence produced by earlier phases. Leads may be scored or classified for suitability, with understandable reasons retained for review. Qualification remains separate from permission to contact and cannot override do-not-contact protection. The expected output is qualified or rejected lead state with supporting evidence.

### DQ-050–054 — Contact Discovery

Discover legitimate public business contact channels and preserve where each contact came from. The design must avoid speculative or private personal data and must run DQ-007 protection before relevant contact-related processing. Contact provenance and validation rules will be defined when these items are architected. The expected output is traceable contact records suitable for controlled outreach, not sent messages.

### DQ-060–066 — Outreach

Create professional, reviewable outreach drafts using approved lead, audit, qualification, and contact context. Drafts may support plain text and HTML where useful, but every workflow requires fresh do-not-contact checks and explicit human review and approval gates. Drafting is not the same as autonomous sending, and this range does not by itself authorize email delivery. The expected output is approved or review-pending outreach content.

### DQ-070–072 — MVP Pipeline

Connect discovery, crawling, analysis, qualification, contact discovery, contact protection, and outreach drafting into one controlled workflow. The orchestration should preserve audit history, recoverable state, safety gates, and human checkpoints across phase boundaries. It must surface failures rather than silently skipping required protections. The expected output is the first usable end-to-end Delta Qoralis MVP under human control.

## Later Priorities

Later work has no assigned DQ numbers yet and is not currently implemented.

### Real Sending and Replies

Future work may add explicitly approved email sending, inbound reply handling, conversation summaries, and human-reviewable reply drafts. Controlled autonomous replies would come only after the required safety and approval model is proven.

### CRM and Client State

Future work may support conversion from lead to client, conversation and customer state, requirements gathering, and ongoing support records. These capabilities should build on rather than bypass lead history and audit controls.

### Website Delivery

Future delivery work may cover website generation, revision loops, client previews, project GitHub repositories, hosting, and deployment. The existing development-repository workflow is separate from any future client-project automation.

### Payments and Subscriptions

Future commerce work may integrate providers such as Stripe or PayPal for project payments, support subscriptions, and service-status tracking. Production financial operations will require separate approval and security boundaries.

### Expanded Autonomy

Higher autonomy is considered only after safety controls, auditability, reliability, approval policy, and operational testing are in place. It will require separately architected backlog items and must not weaken human oversight of high-impact actions.
