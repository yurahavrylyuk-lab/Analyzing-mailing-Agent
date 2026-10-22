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

Phase 0 — Foundation is completed. Phase 1 — Lead Discovery is completed. Phase 2 — Website Crawling is completed. Phase 3 — Website Analysis is current.

Completed: DQ-010, DQ-011, DQ-012, DQ-013, DQ-014, DQ-015, DQ-020, DQ-021, DQ-022, DQ-023, DQ-024, and DQ-025.

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is completed. Production activation was verified through GitHub Actions run 39773510876. That `workflow_dispatch` run on `main` at `a1ad31fddfcd9860f37320d46461062afa7644bf` succeeded: selected 1, attempted 1, fetched 1, failed 0, persisted 1. The stored evidence outcome was fetched for `https://example.com/`, HTTP 200, `text/html`.

The active path is a GitHub Actions scheduled or manual run, then the Node crawl runner, then the authenticated Worker gateway for D1 select and persist. The same Node runner uses the existing DQ-020 pinned transport to fetch the public website, and evidence is persisted to production D1. The Worker does not fetch business websites. Discovery still uses local SQLite and does not currently feed production D1 automatically. The whole discovery-to-crawl pipeline is not autonomous. What is autonomous is an eligible production D1 lead, then the scheduled GitHub Actions crawl, then production D1 evidence. The production crawl workflow is active at cron `17 6 * * *` with timezone `Europe/Warsaw`, and `workflow_dispatch`. Mac participation is not required for scheduled runtime execution.

DQ-030–039 remain planned. The next development action is to architect the first Phase 3 website-analysis slice before implementation. Phase 3 is not implemented.

## Completed Discovery Capabilities

- **DQ-010** established the provider-independent discovery contract and slot-budget semantics. Examined provider slots are bounded; an accepted-lead count is not promised.
- **DQ-011** added audited, idempotent persistence for accepted discovered leads through `LeadService.recordDiscoveredLead()`.
- **DQ-012** added explicit, disabled-by-default Geoapify configuration. A present API key does not activate discovery or perform a request.
- **DQ-013** added a bounded Geoapify `DiscoveryProvider` for `bakery`, `bookshop`, `cafe`, and `restaurant`. The first page geocodes the city. Each `searchPage()` makes one Places request. A continuation uses the provider cursor. Accepted identity is an OSM `providerReference`. The credential travels in the `x-api-key` header. Endpoints are fixed and transport is bounded. The adapter does not retry and does not persist.
- **DQ-014** added `runBoundedDiscovery()`. One injected provider serves the whole run. A valid page consumes one examined slot per normalized outcome before persistence. Accepted outcomes are recorded in order through `recordDiscoveredLead()`. Rejected outcomes are not persisted. The frozen summary reports slots separately from successful writes. The function does not construct a provider, read configuration, decode cursors, or retry.
- **DQ-015** added `npm run discover`. It is the only operator entry that starts a discovery run. The command passes explicit criteria, one Geoapify provider, one human actor, and one `AbortSignal` into `runBoundedDiscovery()`. It does not reimplement paging or persistence.
- **DQ-020** added `fetchCrawlPage`. One untrusted URL becomes one frozen HTML page. Every connection goes through DQ-006. The socket is pinned to the first approved address. Redirects are revalidated. DQ-020 does not store the page. There is no crawl command, spider, analysis, contact extraction, or outreach.
- **DQ-021** added `collectSinglePageCrawlEvidence` in `src/crawler/single-page-evidence.ts`. One caller-held `BusinessLead` with a present website observation becomes one frozen in-memory evidence value through one `fetchCrawlPage` call. The stored URL is passed unchanged. Known network and crawl errors become failure codes. Other errors propagate. The lead is not mutated. Durable storage is DQ-022.
- **DQ-022** added `SinglePageCrawlEvidenceService` and migration `022-single-page-crawl-evidence`. One already-built fetched or failed attempt becomes one append-only row and can be read by id. HTML is untrusted stored text. Failures store an allowlisted code and no raw error message. The lead is not mutated. There is no crawl command, spider, attempt list, audit event, or actor.
- **DQ-023** added `runBoundedSinglePageCrawl` in `src/crawler/run.ts`. One call selects at most 60 eligible lead snapshots, ends that read, then collects and immediately persists one single-page attempt at a time. The summary is five counters. A finished attempt for the current website URL is not selected again. `CANCELLED` leaves that URL eligible for a later run. There is no crawl command, retry, migration, index, actor, audit event, or contact guard.
- **DQ-024** moved the bounded loop to `src/crawler/run-loop.ts` and added a D1 crawl store for `business_leads` and `single_page_crawl_evidence`. The Node function `runBoundedSinglePageCrawl(database, request)` still runs the local crawler. Miniflare module mode is test infrastructure only. DQ-024 itself does not deploy a Worker, add Cron, or create a production D1 database.
- **DQ-025** added the GitHub Actions crawl workflow and the authenticated Worker gateway. The Worker selects and persists production D1 rows. The Node runner fetches the public website through the DQ-020 pinned transport. Production activation was verified through GitHub Actions run 39773510876.

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

- A spider, website analysis, contact extraction, and outreach. The repository contains `npm run crawl:cloud`, and the production crawl of an eligible D1 lead is active. There is no attempt list. Discovery remains on local SQLite and does not feed production D1 automatically.
- Website analysis.
- Qualification.
- Contact discovery.
- Outreach.
- Real email.
- Payments, deployment, subscriptions, client conversion, website delivery, and support operations.

## Next Planned Task

**Phase 2 — Website Crawling** is completed. DQ-020 through DQ-025 are completed. **Phase 3 — Website Analysis** is current and is not implemented. DQ-030–039 remain planned. The next development action is to architect the first Phase 3 website-analysis slice before implementation. Discovery still uses local SQLite and does not feed production D1 automatically.

DQ-015 is completed. Its operator command is `npm run discover`. It calls `runBoundedDiscovery()` and does not reimplement paging or persistence. Completing the command completed Phase 1. That command does not fetch a page, discover contacts, or send outreach.

## DQ-020 Boundary

DQ-020 owns `fetchCrawlPage` in `src/crawler`. One untrusted URL and one `AbortSignal` produce one frozen HTML result. Every connection goes through DQ-006. The socket is pinned to that hop's first approved address. Redirects are revalidated. There is no crawl command, spider, analysis, contact extraction, or outreach. Lead linkage is DQ-021. Persistence is DQ-022. DQ-023 and DQ-024 are not part of this task.

## DQ-021 Boundary

DQ-021 owns `collectSinglePageCrawlEvidence` in `src/crawler/single-page-evidence.ts`. One caller-held `BusinessLead` with a present website observation and one `AbortSignal` produce one frozen in-memory `SinglePageCrawlEvidence` value. The stored URL is passed unchanged to `fetchCrawlPage` once. `NetworkTargetError` and `CrawlPageError` become failed evidence codes. Every other error propagates. `attemptedAt` is the start of that attempt. `leadVersion` is the caller snapshot's `BusinessLead.version`. The operation does not persist, audit, mutate the lead, select leads, or consult the contact guard. Tests inject a fetcher through `collectSinglePageCrawlEvidenceWithDependencies`, which `src/crawler/index.ts` does not export. Persistence is DQ-022. The bounded run is DQ-023. DQ-024 is not part of this task.

## DQ-022 Boundary

DQ-022 owns `SinglePageCrawlEvidenceService` and migration `022-single-page-crawl-evidence`. One already-built fetched or failed `SinglePageCrawlEvidence` becomes one append-only `single_page_crawl_evidence` row when the lead exists. `persist` returns that stored attempt, including its integer id. `findById` reads one row. HTML is untrusted stored text. Failures store an allowlisted code and no raw error message. Historical `leadVersion` and `requestedUrl` are kept when the lead later changes. The service does not fetch, select leads, mutate the lead, write an audit event, record an actor, or consult the contact guard. `crawlerMigrations` is not applied by `npm run discover`. There is no attempt list, crawl command, spider, analysis, contact extraction, or outreach. The bounded run is DQ-023. DQ-024 is not part of this task.

## DQ-023 Boundary

DQ-023 owns `runBoundedSinglePageCrawl` in `src/crawler/run.ts`. One call validates a budget from 1 through 60 and an `AbortSignal`, selects at most that many eligible lead snapshots in one read transaction, and ends that read before collection. Eligible leads are `recorded` or `reviewing` with a present website URL. Manual and discovered leads are both eligible. Archived, unknown, and missing leads are excluded. Suppression is not consulted. A `fetched` attempt, or a `failed` attempt other than `CANCELLED`, for the exact current URL blocks another automatic selection. `CANCELLED` alone leaves that URL eligible on a later run. Each collector result is persisted immediately through `SinglePageCrawlEvidenceService`. The run does not retry, and it does not start the next lead after cancellation. The frozen summary is five counters. `crawlerMigrations` remains only `022-single-page-crawl-evidence`. There is no migration, index, crawl command, actor, audit event, analysis, contact extraction, or outreach. Tests inject selection, collection, and persistence through `runBoundedSinglePageCrawlWithDependencies`, which `src/crawler/index.ts` does not export. DQ-024 is not part of this task.

## DQ-024 Boundary

DQ-024 owns the runtime-neutral loop in `src/crawler/run-loop.ts` and the D1 crawl store in `src/crawler/d1-crawl-store.ts`. `runBoundedSinglePageCrawl(database, request)` remains the Node entry and still crawls through the existing transport. The D1 schema is `business_leads` and `single_page_crawl_evidence` only. Miniflare module mode is test infrastructure only, not a deployed module Worker. DQ-024 does not deploy a Worker, add Cron, create a production D1 database, or perform a deployment. DQ-025 is completed, and production activation was verified through GitHub Actions run 39773510876. The Worker does not fetch business websites. Scheduled runtime execution does not require the Mac.

## DQ-015 Boundary

DQ-015 owns the one controlled operator command, its arguments, the explicit human actor, configuration loading, database open and close, one Geoapify provider, one `runBoundedDiscovery()` call, SIGINT cancellation, text output, attribution, and exit codes. It does not add retries, a scheduler, a run-history table, crawling, contacts, or outreach.

## Source of Truth

Code, `docs/PLAN.md`, `docs/BACKLOG.md`, the ADRs in `docs/decisions/`, and `AGENTS.md` are authoritative. `docs/HANDOFF.md` is an orientation and checkpoint document. Update it when the project meaningfully advances.
