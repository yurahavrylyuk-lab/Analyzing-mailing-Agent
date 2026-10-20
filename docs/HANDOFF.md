# Delta Qoralis Project Handoff

## Product Goal

Delta Qoralis is a short, human-controlled pipeline:

business discovery → website inspection → analysis → qualification → contact discovery → outreach drafting → human approval.

Later work covers sending, replies, client conversion, website delivery, payments, subscriptions, and support.

## Development Workflow

`AGENTS.md` is authoritative.

Architect → Builder → Analyst → Human approval → Commit → Push → Pull Request → CI → Merge → Branch cleanup.

The Architect inspects the repository and designs only. The Builder implements only the approved scope, validates it, and leaves it unstaged and uncommitted until the Analyst finishes with APPROVED or CHANGES REQUIRED. After APPROVED, the Builder does final bookkeeping and validation, then commits, pushes, and opens the pull request. CI runs on that pull request. Merge waits for green CI and human authorization. Feature branches are cleaned up after the merge.

## Current Project Position

Phase 0 — Foundation is completed. Phase 1 — Lead Discovery is current.

Completed: DQ-010, DQ-011, DQ-012, DQ-013, and DQ-014.

Planned: DQ-015.

No implementation item is currently active.

## Completed Discovery Capabilities

- **DQ-010** established the provider-independent discovery contract and slot-budget semantics. Examined provider slots are bounded; an accepted-lead count is not promised.
- **DQ-011** added audited, idempotent persistence for accepted discovered leads through `LeadService.recordDiscoveredLead()`.
- **DQ-012** added explicit, disabled-by-default Geoapify configuration. A present API key does not activate discovery or perform a request.
- **DQ-013** added a bounded Geoapify `DiscoveryProvider` for `bakery`, `bookshop`, `cafe`, and `restaurant`. The first page geocodes the city. Each `searchPage()` makes one Places request. A continuation uses the provider cursor. Accepted identity is an OSM `providerReference`. The credential travels in the `x-api-key` header. Endpoints are fixed and transport is bounded. The adapter does not retry and does not persist.
- **DQ-014** added `runBoundedDiscovery()`. One injected provider serves the whole run. A valid page consumes one examined slot per normalized outcome before persistence. Accepted outcomes are recorded in order through `recordDiscoveredLead()`. Rejected outcomes are not persisted. The frozen summary reports slots separately from successful writes. The function does not construct a provider, read configuration, decode cursors, or retry.

## Current Discovery Pipeline

The implemented path is:

caller-supplied `DiscoveryProvider` → `runBoundedDiscovery()` → bounded `searchPage()` pages → validated outcomes consume the slot budget → accepted outcomes → `LeadService.recordDiscoveredLead()` → durable leads and a frozen run summary.

The caller supplies one provider, the criteria, an explicit actor, and an `AbortSignal`. The runner does not construct a provider, read environment configuration, decode cursors, or retry. Configuration parsing remains separate and does not start a run.

No CLI, HTTP route, scheduler, or other operator command exists. Nothing in the repository starts a live discovery run.

## Important Existing Controls

- Append-only audit history, written in the same transaction as the lead mutation it records.
- Idempotent discovery provenance. A repeated provider and provider reference returns the stored lead.
- SSRF-safe validation for future website connection targets. The control prepares approved addresses and does not fetch websites.
- One-way do-not-contact suppression, with a fail-closed contact guard.
- Disabled-by-default discovery configuration.
- Credential-safe Geoapify transport.
- No Google Maps scraping. Google Places is not an approved discovery provider.
- Human approval for consequential actions.

## What Is Not Implemented Yet

- A CLI or other controlled discovery command.
- Website crawling.
- Website analysis.
- Qualification.
- Contact discovery.
- Outreach.
- Real email.
- Payments, deployment, subscriptions, client conversion, website delivery, and support operations.

## Next Planned Task

**DQ-015 — Controlled Discovery Command and Phase 1 Integration** is planned and has not started.

DQ-014 is completed. Its callable function is `runBoundedDiscovery()`. DQ-015 owns the operator entry point and may call that function. It should not reimplement paging or persistence.

## DQ-015 Boundary

DQ-015 owns the controlled operator entry point, invocation UX, a CLI or command if one is selected, and final Phase 1 integration. DQ-014 does not implement those. No operator command is implemented.

## Source of Truth

Code, `docs/PLAN.md`, `docs/BACKLOG.md`, the ADRs in `docs/decisions/`, and `AGENTS.md` are authoritative. `docs/HANDOFF.md` is an orientation and checkpoint document. Update it when the project meaningfully advances.
