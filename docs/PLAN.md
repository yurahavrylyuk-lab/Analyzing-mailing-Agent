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

**Status: Current**

**Tasks: DQ-010–015**

**Objective:** Build the first mechanism for discovering real candidate businesses through approved sources.

**Inputs:** Location, category, and search criteria together with future validated provider configuration.

**Expected outputs:** Traceable candidate `BusinessLead` records with preserved source provenance, ready to be handed to website investigation.

**Important boundaries:** Discovery will use approved APIs or sources, will not scrape Google Maps pages directly, will not contact businesses, and will not crawl websites except through explicitly designed later phases. Provider behavior, normalization, filtering, and deduplication must be architected within the DQ-010–015 range before implementation.

### Approved Sequence

- **DQ-010 — Discovery Domain and Provider Contract (Completed):** Established bounded criteria, normalized candidate outcomes, page validation, and the provider-independent asynchronous contract.
- **DQ-011 — Audited Discovery Provenance and Idempotent Lead Creation (Completed):** Added traceable, idempotent persistence for discovered leads.
- **DQ-012 — First-provider Eligibility and Explicit Configuration (Planned):** Define which first provider may run and how its configuration is enabled explicitly.
- **DQ-013 — First Approved API Provider Adapter (Planned):** Implement the approved provider behind the DQ-010 contract.
- **DQ-014 — Bounded Discovery Run and Persistence Orchestration (Planned):** Coordinate bounded provider pages with persistence.
- **DQ-015 — Controlled Discovery Command and Phase 1 Integration (Planned):** Add a controlled entry point and complete Phase 1 integration.

No implementation item is currently active. DQ-012–015 remain planned and do not authorize provider activation or network access.

### Completion Outcome

When Phase 1 is complete, the system should be able to turn approved search criteria into a reviewable set of persisted candidate leads with enough provenance to understand where every candidate came from.

## Phase 2 — Website Crawling

**Status: Planned**

**Tasks: DQ-020–024**

**Objective:** Safely retrieve website content from selected candidate leads.

**Dependencies:** DQ-006 network-target validation and its approved-address model.

**Expected output:** Bounded, structured crawl evidence that later analysis can inspect.

**Important boundaries:** Crawling must enforce SSRF controls, manually validate redirects, connect only to approved targets, and apply explicit time, size, and resource limits. It gathers content and metadata but does not produce qualification conclusions.

## Phase 3 — Website Analysis

**Status: Planned**

**Tasks: DQ-030–039**

**Objective:** Turn stored crawl results into structured observations about website quality, missing capabilities, and potential improvement opportunities.

**Expected output:** Reviewable `WebsiteAudit` information and supporting evidence that qualification can consume.

Analysis remains separate from contact and outreach. Replaceable AI-backed analysis may be introduced behind defined interfaces in later design work, but it is not currently implemented.

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

Phase 1 — Lead Discovery: Current.

DQ-010 — Discovery Domain and Provider Contract: Completed.

DQ-011 — Audited Discovery Provenance and Idempotent Lead Creation: Completed.

No development item is currently active.

## Next Planned Step

Architect DQ-012 — First-provider Eligibility and Explicit Configuration and obtain implementation approval before work begins. DQ-012–015 have not started.
