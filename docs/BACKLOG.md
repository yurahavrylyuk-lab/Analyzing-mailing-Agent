# Backlog

## Current

- No active backlog item.

## P0 foundation

- DQ-001 — Project architecture *(completed)*. Established the modular boundaries, documentation foundation, and development conventions.
- DQ-002 — Environment configuration *(completed)*. Added validated, typed runtime configuration with safe defaults and non-reflective errors.
- DQ-003 — Database layer *(completed)*. Added the SQLite abstraction, adapter, and deterministic migration system.
- DQ-004 — Lead lifecycle *(completed)*. Added persisted BusinessLead creation, retrieval, lifecycle transitions, website observations, and optimistic concurrency.
- DQ-005 — Audit logging *(completed)*. Added attributable, append-only audit events committed atomically with lead mutations.
- DQ-006 — SSRF-safe URL handling *(completed)*. Adds strict network URL, address, DNS, and redirect validation without fetching content.
- DQ-007 — Do-not-contact protection *(completed)*. Added fail-closed, lead-specific contact suppression before future outreach capabilities.
- DQ-008 — Git & GitHub Development Foundation *(completed)*. Established the reviewed branch, pull-request, CI, and human-approved merge workflow.

## P1 product pipeline

- DQ-010 through DQ-015 — Discovery. Introduce approved business-source providers and persist discovered leads without scraping prohibited sources.
- DQ-020 through DQ-024 — Crawling. Retrieve approved public website targets through bounded, SSRF-safe transport and retain crawl results.
- DQ-030 through DQ-039 — Analysis. Analyze persisted website evidence behind replaceable interfaces while keeping results attributable and reviewable.
- DQ-040 through DQ-043 — Qualification. Apply explicit qualification criteria to evidence without initiating contact or delivery.
- DQ-050 through DQ-054 — Contact discovery. Discover and validate contact data while enforcing suppression and provenance requirements.
- DQ-060 through DQ-066 — Outreach. Create human-reviewable drafts and approval-gated delivery workflows; real sending remains separately controlled.
- DQ-070 through DQ-072 — MVP pipeline. Orchestrate the reviewed stages with observable, recoverable workflow state and human checkpoints.

## Later priorities

P2/P3/P4 cover controlled real sending and replies, CRM, website delivery, deployments, payments, subscriptions, and expanded autonomy.

The DQ-008 development repository workflow is separate from the future application/client GitHub provider and its approved client-delivery automation.
