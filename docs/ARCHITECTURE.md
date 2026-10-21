# Architecture

Delta Qoralis will be a modular TypeScript application. Configuration, domain logic, provider integrations, persistence, and delivery interfaces will stay separate so modules can be tested and changed independently.

## Planned modules

- `config`: validated application configuration, separated from business logic.
- `core`: shared domain primitives and narrow cross-cutting contracts.
- `db`: persistence interfaces and implementations.
- `network-safety`: URL, address, DNS, and redirect validation for outbound connections.
- `discovery`: bounded search criteria, normalized candidate outcomes, page validation, the provider-independent discovery contract, and the bounded discovery run.
- `crawler`: one pinned HTML page fetch, in-memory lead-linked single-page crawl evidence, and append-only persistence of one already-built attempt. Lead selection, a crawl command, and later crawl tasks are not started.
- `website-analysis`: analysis of crawler results.
- `contacts`: future contact discovery and contact records.
- `leads`: persisted lead lifecycle and its audited unit of work; qualification remains future work.
- `audit`: attributable, append-only event persistence and history reads.
- `outreach`: draft creation and approval-gated delivery requests.
- `conversations`: reply and conversation state.
- `clients`, `projects`, `subscriptions`: post-conversion client work.
- `payments`, `deployment`: replaceable provider adapters for payments and hosting.
- `dashboard`, `cli`, `workflows`: human-facing and orchestration entry points.
- `compliance`: lead-specific do-not-contact suppression and the fail-closed contact guard.
- `logging`: future operational diagnostics.

## Dependency boundaries

- Discovery does not depend on outreach or email delivery.
- The crawler has no payment concerns; website analysis consumes crawler results rather than managing discovery.
- Outreach consumes qualified lead data and does not select or crawl businesses.
- Provider-facing modules use interfaces owned by the application, keeping external services replaceable.
- Configuration and auditability are cross-cutting concerns, not hidden inside feature logic.
- High-impact actions remain approval-gated.

The source directories will be added with real code as their owning backlog items are implemented; this foundation deliberately creates no placeholder feature code.

The TypeScript project validates real application source and unit tests in strict mode without emitting production artifacts during typechecking.

## Configuration flow

External environment → config parser → validated deeply readonly config → feature modules.

`src/config` is the only current module that reads `process.env`. Feature modules should consume its typed configuration instead of independently reading environment variables. The parser accepts an explicit environment object so it can be tested without changing the process environment. Discovery configuration is a frozen discriminator: `{ provider: "disabled" }` by default, or `{ provider: "geoapify", apiKey }` only after exact explicit selection and key validation. Unused keys do not activate a provider, and Google configuration is not parsed.

## Database flow

Validated configuration → database factory → database abstraction → SQLite adapter → migrations → repositories and domain services.

Feature modules depend on the database abstraction and must not import the SQLite driver directly. Migrations currently own the `business_leads`, `audit_events`, `lead_contact_suppressions`, and `single_page_crawl_evidence` domain tables in addition to `schema_migrations`. `crawlerMigrations` is not applied by the discovery command. A caller that needs crawl evidence composes the lead, audit, compliance, and crawler migration lists explicitly.

## Lead lifecycle flow

Database-backed lifecycle service plus validated manual or discovery lead input and actor → internal audited lead unit of work → lead and audit repositories → one database transaction → `business_leads` plus `audit_events`.

The service owns lifecycle transitions, website-observation rules, URL storage validation, optimistic version checks, discovery provenance validation, and the mapping from successful mutations to typed audit events. Its public constructor accepts the database, not a substitutable persistence unit, and internally constructs the unit of work that supplies both repositories with that database instance and transaction. An audit failure therefore rolls back its lead change. No-op and rejected operations produce no event. Database-backed repositories contain only persistence operations and do not import the SQLite driver. Provider access, qualification, and outreach remain separate future modules. The one-page crawl fetch is a separate module and does not mutate leads. Lead-linked crawl evidence reads a caller-held lead and does not mutate it.

## Discovery domain flow

Untrusted criteria → bounded criteria normalization → injected provider pages → validated ordered page outcomes → bounded discovery run → accepted outcomes persisted through the lead service.

The discovery module owns a small provider-independent vocabulary. `maxResults` limits provider result slots examined rather than promising a number of accepted or persisted leads; accepted, rejected, invalid, and later duplicate slots all consume that budget. Each page preserves one allowlisted outcome per returned slot, is capped by its requested size of at most 20, and may carry an opaque bounded cursor. Provider identity remains stable across accepted candidates.

Candidate normalization keeps only provider identity, opaque provider reference, business name, and an unknown-or-present website observation. It reuses lead website-storage validation, which performs no DNS lookup and does not approve a URL for connection.

DQ-011 adds the compatible leads-owned persistence boundary: validated provider/reference identity → lookup inside the audited transaction → insert-if-absent → existing `lead.created` event. Database uniqueness is authoritative. Rediscovery returns the stored winner without refreshing any lead, suppression, or audit state. Current-schema composition applies historical migrations 004, 005, and 007 before migration 011. Migration 011 rebuilds `business_leads` while retaining the exact dependent suppression rows and foreign-key protections; historical migration fixtures continue to exercise their original schemas explicitly. The provider adapter does not depend on or invoke this persistence boundary.

DQ-012 selects Geoapify Places as the first eligible discovery provider and adds disabled-by-default configuration. Parsing reads the supplied environment and performs no HTTP, DNS, file, database, provider construction, health check, or runner work.

DQ-013 keeps its Geoapify implementation under `src/discovery/providers/geoapify`. The exact application tokens `bakery`, `bookshop`, `cafe`, and `restaurant` map to one Geoapify category each. A first page performs city geocoding followed by one Places request filtered with `place:<area-id>`; a continuation validates its adapter-instance HMAC cursor and performs only the Places request. OSM node, way, or relation identity becomes `osm:<type>:<positive-safe-integer>` with no fallback. Each raw feature remains one accepted or rejected outcome, and only `properties.name` and `properties.website` enter existing discovery normalization. The transport uses fixed HTTPS endpoints, `x-api-key`, manual redirects, one 15-second deadline per operation, and a 1 MiB decoded-body limit, with no retries or Place Details. DQ-013 does not supply a runner, multi-page budget, persistence coordination, or CLI.

DQ-014 adds `runBoundedDiscovery` in `src/discovery/run.ts`. The caller injects one `DiscoveryProvider` for the whole run. Requested page size is the remaining slot budget capped at 20. A page that passes validation consumes one examined slot per normalized outcome before any persistence on that page. Accepted outcomes then go to `recordDiscoveredLead` in order with the explicit actor. Rejected outcomes are not persisted. The frozen result reports examined slots separately from successful writes. Opaque cursors are compared as exact strings. The runner does not construct a Geoapify provider, read the environment, decode cursors, open a run transaction, retry, or expose a command.

DQ-015 adds the operator command flow: argv → `runDiscoveryCommand` → existing `runBoundedDiscovery` → text result. `src/cli/discover.ts` is only the process wrapper. It parses `--location`, `--query`, `--actor`, and optional `--max-results`, loads configuration through `loadConfig`, opens the existing lead, audit, and suppression migrations, constructs `createGeoapifyProvider` from that configuration, and calls the runner once with an explicit human actor and one `AbortSignal`. Ctrl+C aborts that signal. The wrapper does not reimplement paging, persistence, or provider transport. `src/cli/discover.ts` passes `process.env` into the command when it is the process entry. `runDiscoveryCommand` does not read `process.env`. It calls `loadConfig` from `src/config/env.ts` and does not import the eager config barrel.

## Audit flow

Lead creation uses the resulting `createdAt`; status and website-observation changes use the resulting `updatedAt`. The service does not call a second clock, and SQLite accepts only the same canonical `YYYY-MM-DDTHH:mm:ss.sssZ` UTC representation produced by `Date.toISOString()`. Event details are discriminated, strictly allowlisted, and limited to 2048 UTF-8 bytes. Audit history uses bound entity parameters and ascending integer IDs, while database triggers enforce append-only storage. Attribution records a claimed actor and does not provide authentication or authorization.

## Network target safety flow

Untrusted URL → HTTP(S) normalization and host policy → injected DNS resolver → validate every A/AAAA answer → immutable safe target containing the normalized URL, hostname, port, and approved addresses.

Lead website storage validation remains separate and performs no DNS work. A stored website URL is not an approved connection target.

## One-page crawl fetch

`fetchCrawlPage` accepts one untrusted URL and one `AbortSignal`. The first hop calls `resolveSafeTarget`. Every later hop calls `resolveSafeRedirect`. Production uses `createNodeDnsResolver()` and connects with `node:http` on port 80 or `node:https` on port 443. The socket is pinned to the first approved address for that hop. The hostname is kept for the Host header, TLS SNI, and certificate checks. Automatic redirects stay off. The fetcher follows at most five 301, 302, 303, 307, and 308 responses after revalidation and refuses an HTTPS-to-HTTP hop. One 15-second deadline covers DNS, every hop, and the body. The body cap is 1,048,576 bytes. The final response must be identity-encoded UTF-8 `text/html` or `application/xhtml+xml`. Success returns one frozen `CrawlPageResult`.

Every connection goes through DQ-006. The public entry does not accept a resolver, a transport, a pinned address, or a connect port. The fetch does not persist the page. There is no crawl command, spider, analysis, contact extraction, or outreach. Lead storage validation stays separate from this fetch. `fetch-page.ts` does not import `src/leads`.

## Lead-linked single-page crawl evidence

`collectSinglePageCrawlEvidence` accepts one caller-held `BusinessLead` and one `AbortSignal`. The evidence module may read that lead. It requires a present website observation whose `url` is a string. `unknown` and `missing` throw `CrawlEvidenceError` with `INVALID_REQUEST` before the clock and before any fetch. A present stored URL is passed unchanged to `fetchCrawlPage` once. Storage validation stays separate from that fetch: the stored URL remains untrusted until `fetchCrawlPage` revalidates it.

A returned `CrawlPageResult` becomes frozen fetched evidence. `leadId` and `leadVersion` come from the caller snapshot. `leadVersion` is `BusinessLead.version`. `attemptedAt` is the ISO timestamp taken immediately before the fetch. A `NetworkTargetError` or `CrawlPageError` becomes frozen failed evidence with that code and no error message. Any other thrown value propagates. The evidence module does not re-validate the page result, persist evidence, write an audit event, or change the lead or its observation.

Production always binds `fetchCrawlPage` and a clock that returns `new Date()`. The dependency seam stays on `collectSinglePageCrawlEvidenceWithDependencies` inside `src/crawler/single-page-evidence.ts`. `src/crawler/index.ts` does not export that seam. There is still no crawl command, spider, analysis, contact discovery, or outreach.

## Persisted single-page crawl evidence

`SinglePageCrawlEvidenceService` accepts a `Database` and persists one already-built `SinglePageCrawlEvidence`. It does not call `collectSinglePageCrawlEvidence` or `fetchCrawlPage`. `persist` validates outside the transaction, then in one transaction checks that the lead row exists, inserts one append-only row, and reads that row back by its new integer id. `findById` reads one primary-key row. A missing valid id is absence. There is no list, latest-attempt, or history query.

Migration `022-single-page-crawl-evidence` lives in `src/crawler/migration.ts` and is exported as `singlePageCrawlEvidenceMigration` and frozen `crawlerMigrations`. It verifies the current `business_leads` column order and foreign-key state before creating `single_page_crawl_evidence`. The discovery command's migration list remains the lead, audit, and compliance migrations. The service and repository depend on the database abstraction and do not import the SQLite driver. The repository is not on the public crawler entry. The write does not mutate the lead, write an audit event, or record an actor. Stored HTML stays untrusted text.

## Do-not-contact flow

Validated lead, reason, and actor → one database transaction → insert suppression if absent → append `lead.do_not_contact_applied` → commit. The service constructs its suppression, lead, and audit repositories from the same `Database`; an audit failure therefore rolls back a new suppression. A pre-existing suppression is an idempotent no-op that returns the original row and emits no event.

Suppression is one-way and independent from lead lifecycle and versioning. A fresh guard query joins `business_leads` with `lead_contact_suppressions`, permits only unsuppressed `recorded` or `reviewing` leads, and blocks or fails closed for every other state. Clearing suppression, contact discovery, and outreach remain future, separately reviewed features.

## Development workflow

Task → Branch → Builder → Tests → Analyst → Pull Request → CI → Human approval → Merge.

GitHub is currently development infrastructure: it hosts the repository, pull requests, and CI checks. It is not an application dependency. A future application-level GitHub provider may live near `src/integrations/github/` and, after explicit implementation approval, support approved client repository creation, branch creation, commits, pushes, repository-state retrieval, and preview/deployment metadata.

That future provider must require explicit human approval for repository creation, production-branch modification, merges, production deployment, and destructive operations. It must never force-push.
