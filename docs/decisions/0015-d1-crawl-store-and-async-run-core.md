# 0015 — D1 crawl store and async run core

## Status

Accepted and implemented by DQ-024.

## Context

DQ-023 selects leads and stores each finished attempt through a synchronous SQLite database. Importing that loop also loads the Node crawl transport. A later Worker needs the same run behavior without that module graph. Workers still cannot pin HTTPS to an approved address, keep the logical hostname, send it as SNI, verify that certificate, and reach Cloudflare-fronted sites. workerd issue 6903 remains the DQ-025 blocker. A passing local workerd experiment is not production evidence.

## Decision

`DQ-024 — D1 Crawl Store and Async Run Core` adds a runtime-neutral loop and a crawl-only D1 store. It does not rewrite application persistence around an async database interface. `runBoundedSinglePageCrawl(database, request)` stays the Node public API.

`runBoundedSinglePageCrawlWithDependencies` lives in `src/crawler/run-loop.ts`. It takes no database argument. `select` is required and may return a promise. `persist` is awaited before the next candidate. The Node wrapper still selects with SQLite, collects with `collectSinglePageCrawlEvidence`, and persists with one `SinglePageCrawlEvidenceService`.

`CRAWL_CANDIDATE_WHERE_SQL` is the only eligibility predicate. Both selectors append the same order and bound limit.

`migrations/0001_delta_qoralis_crawl.sql` creates only `business_leads`, `business_leads_discovery_identity_idx`, `single_page_crawl_evidence`, and the two append-only triggers. Each statement is one physical line. There is no audit table, suppression table, `schema_migrations` table, run table, or scheduler table.

The local DQ-022 migration still uses one canonical `attempted_at` GLOB. D1 limits one LIKE or GLOB pattern to 50 bytes, and that GLOB is longer. The D1 evidence check uses short fixed-position GLOBs plus the existing length, numeric range, `date`, and `strftime` checks. `src/crawler/migration.ts` is unchanged. This is not a shared portability layer. `normalizeSinglePageCrawlEvidence` still measures UTF-8 size with Node `Buffer`. DQ-025 must later choose `nodejs_compat` `Buffer` or a proven-equivalent `TextEncoder`.

Miniflare `4.20260730.0` hosts the D1 test with `modules: true` on an emulated Worker string. That module mode is test infrastructure only. It is not a deployed module Worker. Production source does not import Miniflare. There is no Wrangler dependency, no Worker, no Cron, and no deployment.

## Consequences

The local Node crawler still runs. The D1 store is tested locally and is not a production database. `DQ-025 — Worker Pinned Transport and Scheduled Runner` stays blocked and unstarted. Phase 2 stays current and is not complete. Cloudflare autonomous crawling is not yet enabled. Phase 3 stays planned.
