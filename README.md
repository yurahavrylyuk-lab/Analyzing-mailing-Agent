# Delta Qoralis Lead Discovery & Outreach Agent

Delta Qoralis is planned as a human-controlled lead discovery, website analysis, and outreach system that can eventually support client delivery.

## Status

The repository is at **Phase 0 — Foundation**. No business discovery, crawler, website analysis, contact extraction, AI integration, messaging, database, payment, deployment, dashboard, or workflow features exist yet.

## Local setup

1. Install Node.js 22 or newer.
2. Install package dependencies with `npm install`.
3. Run `npm run typecheck`.

## Commands

- `npm test` — runs the TypeScript validation.
- `npm run typecheck` — checks the TypeScript project without emitting files.

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
