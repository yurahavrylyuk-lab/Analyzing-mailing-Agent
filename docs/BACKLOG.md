# Delta Qoralis Backlog

## Current Status

Phase 0 — Foundation is completed. Phase 1 — Lead Discovery is completed. DQ-010, DQ-011, DQ-012, DQ-013, DQ-014, and DQ-015 are completed. Phase 2 — Website Crawling is current and is not completed. DQ-020 — One-Page Pinned Crawl Fetch is completed. DQ-021 — Lead-Linked Single-Page Crawl Evidence is completed. DQ-022 — Persisted Single-Page Crawl Evidence is completed. DQ-023 — Bounded Single-Page Crawl Run is completed. DQ-024 — D1 Crawl Store and Async Run Core is completed. `DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is implemented in the repository and is not production-complete. Production activation has not been performed. Cloudflare autonomous crawling is not yet enabled. Phase 3 — Website Analysis remains planned. No later implementation item is active.

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

**Status: Repository implementation exists; production activation pending**

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is implemented in the repository and is not production-complete. Production activation has not been performed. Production D1, the Worker deploy, the Worker secret, and the GitHub Actions crawl run are still human-controlled and have not been performed. Phase 2 — Website Crawling remains current and is not completed. Cloudflare autonomous crawling is not yet enabled. Phase 3 — Website Analysis remains planned.

The crawl still uses the network-target safety established by DQ-006. Crawling uses bounded HTTP behavior, manually validated redirects, and resource limits. One bounded run selects leads and stores each finished attempt. The Worker does not fetch business websites. The crawler gathers evidence but does not decide whether a business is qualified. The expected output is structured crawl results ready for website analysis.

### DQ-030–039 — Website Analysis

Inspect stored crawl evidence for outdated design, poor usability, missing functionality, or other potential improvement opportunities. Produce structured observations linked to supporting evidence so later decisions remain reviewable. Replaceable AI analysis may be introduced in this range after it is designed, but no AI analysis exists yet. The expected output is website audit information for qualification, not contact or outreach activity.

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
