# Delta Qoralis Lead Discovery & Outreach Agent

Delta Qoralis is planned as a human-controlled lead discovery, website analysis, and outreach system that can eventually support client delivery.

## Status

The repository is at **Phase 0 — Foundation**. SQLite persistence, the BusinessLead lifecycle, append-only audit events, SSRF-safe network-target validation, and lead-specific do-not-contact protection exist. Discovery, crawling, analysis, qualification, contact discovery, outreach, AI, messaging, payments, deployment, dashboard, and workflows do not.

## Local setup

1. Install Node.js 22 or newer.
2. Install package dependencies with `npm install`.
3. Run `npm run typecheck` and `npm test`.

## Commands

- `npm test` — compiles and runs unit tests with Node's built-in test runner.
- `npm run typecheck` — checks the TypeScript project without emitting files.

## Configuration

The application currently validates only `NODE_ENV` (`development`, `test`, or `production`) and `LOG_LEVEL` (`debug`, `info`, `warn`, or `error`). Defaults are development/debug, test/warn, and production/info.

[.env.example](.env.example) lists future provider variables as documentation only; they are optional and are not interpreted yet. `dotenv` is intentionally not installed: deployment environments and local commands can provide variables directly through `process.env`. Never commit a real `.env` file.

## Database

The local development database defaults to `DATABASE_URL=file:./data/delta-qoralis.sqlite`. The `data/` directory is local runtime state and is not committed. Tests use an in-memory SQLite database unless they explicitly verify file persistence.

## Lead lifecycle

The initial lead API records manually sourced businesses, retrieves them, manages recorded/reviewing/archived transitions, and stores website presence observations. Mutations use optimistic version checks; URL handling validates storage format only and performs no network requests.

Every actual lead mutation requires a claimed human or system actor and writes one allowlisted audit event in the same SQLite transaction. Audit history is ordered by its database ID and protected against updates and deletes. Audit details intentionally exclude business names, source references, and raw website URLs.

## Network target safety

`src/network-safety` normalizes HTTP(S) targets, permits only default ports, blocks local hostnames and non-public IP addresses, validates every injected DNS answer, and returns the exact approved addresses for future connection pinning. Redirect targets receive the same complete validation. This module performs no HTTP requests and is separate from lead website URL storage validation.

## Do-not-contact protection

`src/compliance` applies an insert-only suppression to a BusinessLead and records one attributable audit event in the same transaction. Repeated valid applications preserve the original reason, actor, and timestamp. The contact guard checks current lead and suppression state on every call, allows only unsuppressed recorded or reviewing leads, and fails closed when it cannot make a reliable decision. DQ-007 adds no contacts, outreach, sending, or unsuppression workflow.

## Development workflow

Repository: <https://github.com/yurahavrylyuk-lab/Analyzing-mailing-Agent>

Create task branch → implement → validate → commit → push → pull request → review → merge.

Direct feature development on `main` is discouraged. Human approval is required before merging.

## Documentation

- [Product](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Development plan](docs/PLAN.md)
- [Backlog](docs/BACKLOG.md)
- [Security boundaries](docs/SECURITY.md)
- [Planned data model](docs/DATA_MODEL.md)
