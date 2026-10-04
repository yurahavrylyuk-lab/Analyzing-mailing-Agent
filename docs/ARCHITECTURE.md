# Architecture

Delta Qoralis will be a modular TypeScript application. Configuration, domain logic, provider integrations, persistence, and delivery interfaces will stay separate so modules can be tested and changed independently.

## Planned modules

- `config`: validated application configuration, separated from business logic.
- `core`: shared domain primitives and narrow cross-cutting contracts.
- `db`: persistence interfaces and implementations.
- `network-safety`: URL, address, DNS, and redirect validation for future outbound connections.
- `discovery`: business-source discovery.
- `crawler`: safe website retrieval and crawl results.
- `website-analysis`: analysis of crawler results.
- `contacts`: contact discovery and consent-related contact state.
- `leads`: persisted lead lifecycle and its audited unit of work; qualification remains future work.
- `audit`: attributable, append-only event persistence and history reads.
- `outreach`: draft creation and approval-gated delivery requests.
- `conversations`: reply and conversation state.
- `clients`, `projects`, `subscriptions`: post-conversion client work.
- `payments`, `deployment`: replaceable provider adapters for payments and hosting.
- `dashboard`, `cli`, `workflows`: human-facing and orchestration entry points.
- `compliance`, `logging`: future safety controls and operational diagnostics.

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

External environment → config parser → validated readonly config → feature modules.

`src/config` is the only current module that reads `process.env`. Feature modules should consume its typed configuration instead of independently reading environment variables. The parser accepts an explicit environment object so it can be tested without changing the process environment.

## Database flow

Validated configuration → database factory → database abstraction → SQLite adapter → migrations → repositories and domain services.

Feature modules depend on the database abstraction and must not import the SQLite driver directly. Migrations currently own the `business_leads` and `audit_events` domain tables in addition to `schema_migrations`.

## Lead lifecycle flow

Database-backed lifecycle service plus validated lead input and actor → internal audited lead unit of work → lead and audit repositories → one database transaction → `business_leads` plus `audit_events`.

The service owns lifecycle transitions, website-observation rules, URL storage validation, optimistic version checks, and the mapping from successful mutations to typed audit events. Its public constructor accepts the database, not a substitutable persistence unit, and internally constructs the unit of work that supplies both repositories with that database instance and transaction. An audit failure therefore rolls back its lead change. No-op and rejected operations produce no event. Database-backed repositories contain only persistence operations and do not import the SQLite driver. Discovery, qualification, crawling, and outreach remain separate future modules.

## Audit flow

Lead creation uses the resulting `createdAt`; status and website-observation changes use the resulting `updatedAt`. The service does not call a second clock, and SQLite accepts only the same canonical `YYYY-MM-DDTHH:mm:ss.sssZ` UTC representation produced by `Date.toISOString()`. Event details are discriminated, strictly allowlisted, and limited to 2048 UTF-8 bytes. Audit history uses bound entity parameters and ascending integer IDs, while database triggers enforce append-only storage. Attribution records a claimed actor and does not provide authentication or authorization.

## Network target safety flow

Untrusted URL → HTTP(S) normalization and host policy → injected DNS resolver → validate every A/AAAA answer → immutable safe target containing the normalized URL, hostname, port, and approved addresses.

Lead website storage validation remains separate and performs no DNS work. The future crawler must disable automatic redirects, validate every `Location` as a new target, cap redirects (for example, at five), and connect only to an address returned by the matching validation result. It must retain the hostname separately for HTTP authority, TLS SNI, and certificate verification instead of allowing the transport to resolve DNS again.

## Development workflow

Task → Branch → Builder → Tests → Analyst → Pull Request → CI → Human approval → Merge.

GitHub is currently development infrastructure: it hosts the repository, pull requests, and CI checks. It is not an application dependency. A future application-level GitHub provider may live near `src/integrations/github/` and, after explicit implementation approval, support approved client repository creation, branch creation, commits, pushes, repository-state retrieval, and preview/deployment metadata.

That future provider must require explicit human approval for repository creation, production-branch modification, merges, production deployment, and destructive operations. It must never force-push.
