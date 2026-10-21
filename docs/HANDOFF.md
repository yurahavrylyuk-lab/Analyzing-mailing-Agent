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

Phase 0 — Foundation is completed. Phase 1 — Lead Discovery is completed. Phase 2 — Website Crawling is current and is not completed.

Completed: DQ-010, DQ-011, DQ-012, DQ-013, DQ-014, DQ-015, DQ-020, and DQ-021.

DQ-022, DQ-023, and DQ-024 remain untitled and have not started.

No implementation item is currently active.

## Completed Discovery Capabilities

- **DQ-010** established the provider-independent discovery contract and slot-budget semantics. Examined provider slots are bounded; an accepted-lead count is not promised.
- **DQ-011** added audited, idempotent persistence for accepted discovered leads through `LeadService.recordDiscoveredLead()`.
- **DQ-012** added explicit, disabled-by-default Geoapify configuration. A present API key does not activate discovery or perform a request.
- **DQ-013** added a bounded Geoapify `DiscoveryProvider` for `bakery`, `bookshop`, `cafe`, and `restaurant`. The first page geocodes the city. Each `searchPage()` makes one Places request. A continuation uses the provider cursor. Accepted identity is an OSM `providerReference`. The credential travels in the `x-api-key` header. Endpoints are fixed and transport is bounded. The adapter does not retry and does not persist.
- **DQ-014** added `runBoundedDiscovery()`. One injected provider serves the whole run. A valid page consumes one examined slot per normalized outcome before persistence. Accepted outcomes are recorded in order through `recordDiscoveredLead()`. Rejected outcomes are not persisted. The frozen summary reports slots separately from successful writes. The function does not construct a provider, read configuration, decode cursors, or retry.
- **DQ-015** added `npm run discover`. It is the only operator entry that starts a discovery run. The command passes explicit criteria, one Geoapify provider, one human actor, and one `AbortSignal` into `runBoundedDiscovery()`. It does not reimplement paging or persistence.
- **DQ-020** added `fetchCrawlPage`. One untrusted URL becomes one frozen HTML page. Every connection goes through DQ-006. The socket is pinned to the first approved address. Redirects are revalidated. There is no crawl command, spider, analysis, contact extraction, outreach, or crawl persistence.
- **DQ-021** added `collectSinglePageCrawlEvidence` in `src/crawler/single-page-evidence.ts`. One caller-held `BusinessLead` with a present website observation becomes one frozen in-memory evidence value through one `fetchCrawlPage` call. The stored URL is passed unchanged. Known network and crawl errors become failure codes. Other errors propagate. The lead is not mutated, and nothing is persisted.

## Current Discovery Pipeline

The implemented path is:

`npm run discover` → `runDiscoveryCommand()` → `loadConfig()` → existing SQLite migrations and `LeadService` → `createGeoapifyProvider()` → `runBoundedDiscovery()` → bounded `searchPage()` pages → accepted outcomes → `LeadService.recordDiscoveredLead()` → text summary and exit code.

The operator supplies `--location`, `--query`, `--actor`, and an optional `--max-results`. The runner still does not construct a provider, read environment configuration, decode cursors, or retry. There is no HTTP route, scheduler, or second command. A live run starts only when the operator invokes this command with discovery enabled.

## Important Existing Controls

- Append-only audit history, written in the same transaction as the lead mutation it records.
- Idempotent discovery provenance. A repeated provider and provider reference returns the stored lead.
- SSRF-safe validation for website connection targets. DQ-006 prepares approved addresses and does not itself fetch websites. The one-page crawl fetch is the caller that connects, and every hop still goes through that validation.
- One-way do-not-contact suppression, with a fail-closed contact guard.
- Disabled-by-default discovery configuration.
- Credential-safe Geoapify transport.
- No Google Maps scraping. Google Places is not an approved discovery provider.
- Human approval for consequential actions.

## What Is Not Implemented Yet

- Crawl persistence, lead selection, a crawl command, a spider, website analysis, contact extraction, and outreach. One present lead website can become in-memory single-page crawl evidence. That evidence is not stored.
- Website analysis.
- Qualification.
- Contact discovery.
- Outreach.
- Real email.
- Payments, deployment, subscriptions, client conversion, website delivery, and support operations.

## Next Planned Task

**Phase 2 — Website Crawling** is current and is not completed. DQ-020 — One-Page Pinned Crawl Fetch is completed. DQ-021 — Lead-Linked Single-Page Crawl Evidence is completed. The next work is the rest of Phase 2, not a named later scope. DQ-022, DQ-023, and DQ-024 remain untitled and have not started. Later Phase 2 work still owns persistence, selection and orchestration, and a controlled operator entry. Phase 3 — Website Analysis remains planned. No later implementation item is active.

DQ-015 is completed. Its operator command is `npm run discover`. It calls `runBoundedDiscovery()` and does not reimplement paging or persistence. Completing the command completed Phase 1. That command does not fetch a page, discover contacts, or send outreach.

## DQ-020 Boundary

DQ-020 owns `fetchCrawlPage` in `src/crawler`. One untrusted URL and one `AbortSignal` produce one frozen HTML result. Every connection goes through DQ-006. The socket is pinned to that hop's first approved address. Redirects are revalidated. There is no crawl command, spider, analysis, contact extraction, outreach, or crawl persistence. Lead linkage is DQ-021. DQ-022, DQ-023, and DQ-024 are not part of this task.

## DQ-021 Boundary

DQ-021 owns `collectSinglePageCrawlEvidence` in `src/crawler/single-page-evidence.ts`. One caller-held `BusinessLead` with a present website observation and one `AbortSignal` produce one frozen in-memory `SinglePageCrawlEvidence` value. The stored URL is passed unchanged to `fetchCrawlPage` once. `NetworkTargetError` and `CrawlPageError` become failed evidence codes. Every other error propagates. `attemptedAt` is the start of that attempt. `leadVersion` is the caller snapshot's `BusinessLead.version`. The operation does not persist, audit, mutate the lead, select leads, or consult the contact guard. Tests inject a fetcher through `collectSinglePageCrawlEvidenceWithDependencies`, which `src/crawler/index.ts` does not export. DQ-022, DQ-023, and DQ-024 stay untitled and are not part of this task.

## DQ-015 Boundary

DQ-015 owns the one controlled operator command, its arguments, the explicit human actor, configuration loading, database open and close, one Geoapify provider, one `runBoundedDiscovery()` call, SIGINT cancellation, text output, attribution, and exit codes. It does not add retries, a scheduler, a run-history table, crawling, contacts, or outreach.

## Source of Truth

Code, `docs/PLAN.md`, `docs/BACKLOG.md`, the ADRs in `docs/decisions/`, and `AGENTS.md` are authoritative. `docs/HANDOFF.md` is an orientation and checkpoint document. Update it when the project meaningfully advances.
