# Delta Qoralis Lead Discovery & Outreach Agent

Delta Qoralis is planned as a human-controlled lead discovery, website analysis, and outreach system that can eventually support client delivery.

## Status

The repository is at **Phase 0 — Foundation**. No business discovery, crawler, website analysis, contact extraction, AI integration, messaging, database, payment, deployment, dashboard, or workflow features exist yet.

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
