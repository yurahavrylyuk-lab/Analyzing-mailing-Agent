# Delta Qoralis Lead Discovery & Outreach Agent

Delta Qoralis is planned as a human-controlled lead discovery, website analysis, and outreach system that can eventually support client delivery.

## Status

**Phase 1 — Lead Discovery** is complete. Phase 0 is complete. Phase 2 — Website Crawling is current and is not completed. DQ-010 established the provider-independent discovery contract, DQ-011 completed audited and idempotent persistence for accepted candidates, DQ-012 selected Geoapify with explicit configuration, DQ-013 completed the bounded Geoapify page adapter, DQ-014 completed the bounded discovery run, and DQ-015 added the controlled discovery command. `npm run discover` is the only operator entry. It calls `runBoundedDiscovery` once and persists accepted outcomes through the existing lead boundary. DQ-020 added one offline-tested page fetch. Every connection goes through DQ-006, the socket is pinned, and redirects are revalidated. There is no crawl command, spider, analysis, contact extraction, outreach, or crawl persistence. Qualification, contact discovery, AI, messaging, payments, deployment, dashboard, and workflow automation are not implemented. DQ-021 through DQ-024 remain untitled and have not started.

## Local setup

1. Install Node.js 22 or newer.
2. Install package dependencies with `npm install`.
3. Run `npm run typecheck` and `npm test`.

## Commands

- `npm test` — compiles and runs unit tests with Node's built-in test runner.
- `npm run typecheck` — checks the TypeScript project without emitting files.
- `npm run discover -- --location <location> --query <query> --actor <id> [--max-results <count>]` — runs one bounded Geoapify discovery.
- `npm run discover -- --help` and `npm run discover -- -h` — print usage and exit 0.

## Configuration

The application validates `NODE_ENV` (`development`, `test`, or `production`), `LOG_LEVEL` (`debug`, `info`, `warn`, or `error`), `DATABASE_URL`, and discovery selection. Defaults are development/debug, test/warn, production/info, and discovery disabled.

Set `DISCOVERY_PROVIDER=geoapify` together with a nonblank, whitespace-free `GEOAPIFY_API_KEY` to make Geoapify configuration eligible. A key by itself never activates discovery or performs a request. Discovery stays disabled unless both are set in the environment of `npm run discover`. The command does not read a `.env` file. `--actor` is the claimed human id for the audit row; it is not authentication and it is not printed. `--max-results` is the examined-slot budget from 1 through 60 and defaults to 20. `GOOGLE_PLACES_API_KEY` remains an unused and unapproved placeholder with no runtime effect; it cannot satisfy Geoapify configuration. `dotenv` is intentionally not installed: deployment environments and local commands can provide variables directly through `process.env`. Never commit a real `.env` file.

Example:

```text
DISCOVERY_PROVIDER=geoapify GEOAPIFY_API_KEY=<key> npm run discover -- --location "Kyiv" --query cafe --actor ada
```

## Geoapify discovery adapter

DQ-013 provides one `DiscoveryProvider` for the exact application queries `bakery`, `bookshop`, `cafe`, and `restaurant`. A first page resolves one city and then performs one Places search bounded to that Geoapify place; a continuation uses its signed, instance-local cursor and performs only the Places request. The fixed Geoapify endpoints receive the credential only through `x-api-key`, reject redirects, use no retries, and enforce per-operation time and body limits. Results retain only OSM identity (`osm:n|w|r:<id>`), name, and the Places response's direct website field. This adapter does not run itself, persist leads, or crawl returned websites. DQ-014 orchestration is provider-generic and does not construct this adapter. DQ-015 constructs it from validated configuration and calls the runner once. Visible output includes `© OpenStreetMap contributors` and `Powered by Geoapify`.

## Database

The local development database defaults to `DATABASE_URL=file:./data/delta-qoralis.sqlite`. The `data/` directory is local runtime state and is not committed. Tests use an in-memory SQLite database unless they explicitly verify file persistence.

## Lead lifecycle

The lead API records manually sourced businesses and accepted provider-independent discovery candidates, retrieves them, manages recorded/reviewing/archived transitions, and stores website presence observations. Discovery provenance is explicit and repeated provider/reference identities return the stored lead without refreshing it. Mutations use optimistic version checks; URL handling validates storage format only and performs no network requests.

Every actual lead mutation requires a claimed human or system actor and writes one allowlisted audit event in the same SQLite transaction. Audit history is ordered by its database ID and protected against updates and deletes. Audit details intentionally exclude business names, source references, and raw website URLs.

## Network target safety

`src/network-safety` normalizes HTTP(S) targets, permits only default ports, blocks local hostnames and non-public IP addresses, validates every injected DNS answer, and returns the exact approved addresses for connection pinning. Redirect targets receive the same complete validation. This module performs no HTTP requests and is separate from lead website URL storage validation.

## One-page crawl fetch

`fetchCrawlPage` retrieves one HTML page. Every connection goes through DQ-006. The socket is pinned to the first approved address, and redirects are revalidated. The result is frozen in memory. There is no crawl command, spider, analysis, contact extraction, outreach, or crawl persistence. Tests for this fetch stay offline.

## Do-not-contact protection

`src/compliance` applies an insert-only suppression to a BusinessLead and records one attributable audit event in the same transaction. Repeated valid applications preserve the original reason, actor, and timestamp. The contact guard checks current lead and suppression state on every call, allows only unsuppressed recorded or reviewing leads, and fails closed when it cannot make a reliable decision. DQ-007 adds no contacts, outreach, sending, or unsuppression workflow.

## Development workflow

Repository: <https://github.com/yurahavrylyuk-lab/Analyzing-mailing-Agent>

Task architecture → implementation → validation → Analyst review → APPROVED → commit/push/PR → CI → human-approved merge → cleanup.

`AGENTS.md` holds the detailed rules. Commit, push, and pull request follow Analyst approval. Human approval is required before merging. Work stays off `main`.

## Documentation

- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development plan](docs/PLAN.md)
- [Backlog](docs/BACKLOG.md)
- [Security boundaries](docs/SECURITY.md)
- [Planned data model](docs/DATA_MODEL.md)
