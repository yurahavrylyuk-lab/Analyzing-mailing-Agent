# 0010 — Add one controlled discovery command

## Status

Accepted and completed in DQ-015.

## Context

DQ-010 through DQ-014 left discovery as separate pieces: explicit configuration, one Geoapify page adapter, audited lead persistence, and `runBoundedDiscovery`. No operator entry called them together. Phase 1 needed one intentional command that starts a single bounded run and then exits. It did not need a second provider, a scheduler, a run history, or any Phase 2 behavior.

## Decision

`npm run discover` is the only discovery command. `scripts/run-discovery.cjs` compiles the repository with the existing TypeScript compiler into a temporary `.command-build/` directory and spawns `node` on `.command-build/src/cli/discover.js`. The launcher removes that directory afterward, including after success, usage failure, command failure, and cancellation. `.command-build` is scratch, not a production build.

`src/cli/discover.ts` is a thin wrapper. `main` accepts explicit argv, env, writers, and a SIGINT registration function so tests do not mutate process globals. With no argument it uses `process.argv.slice(2)`, `process.env`, and `process.stdout` / `process.stderr`. It registers one SIGINT handler that only aborts an `AbortController`, removes that listener when the command finishes, and returns the exit code. It does not call `process.exit`. The compiled file calls `main` only when it is the process entry. SIGTERM is not handled. A second SIGINT does not force exit.

Arguments are `--location`, `--query`, `--actor`, and optional `--max-results`, parsed with `node:util.parseArgs` in strict mode. There are no positional arguments. `--help` and `-h` are the only short option. Help exits 0 before configuration, database, or provider work. The actor is `normalizeAuditActor({ type: "human", id })` on the raw `--actor` string. There is no default actor, system actor, actor type flag, or authentication check. The id is claimed, not verified, and it is not printed.

The command calls `loadConfig` from `src/config/env.ts`. It does not import `src/config/index.ts` and it does not load a `.env` file. Disabled or invalid discovery exits before any database or provider work. `GOOGLE_PLACES_API_KEY` stays unread. The default database bootstrap opens SQLite, applies the existing lead, audit, and compliance migrations, and constructs `LeadService`. There is no new migration and no run table. The command then constructs `createGeoapifyProvider` from the validated Geoapify config, with no custom fetch, and calls `runBoundedDiscovery` once. It does not reimplement paging, cursors, budgets, or persistence.

Stdout for a run is the runner's provider id, stop, and counters, plus `© OpenStreetMap contributors` and `Powered by Geoapify`. It does not include keys, raw bodies, cursors, names, websites, lead ids, or the actor. Stderr uses fixed sentences. Exit codes are 0 for help or a completed run, 1 for an unexpected composition failure, 2 for usage, criteria, or actor errors, 3 for configuration or provider-factory failure, 4 for database failure, 5 for a failed discovery stop, and 130 for cancellation. A failed or cancelled run does not exit 0. Zero leads on a completed run may exit 0. There are no retries and no background work.

## Consequences

DQ-015 completes Phase 1 — Lead Discovery. An operator can turn approved criteria into persisted candidate leads. Phase 2 — Website Crawling stays planned. DQ-020 has not started. The command does not crawl websites, discover contacts, or send outreach. ADR 0009's runner contract is unchanged. ADR 0007's attribution lines are now printed by this command.
