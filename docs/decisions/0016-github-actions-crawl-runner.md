# 0016 — GitHub Actions crawl runner

## Status

Accepted for implementation. Production activation is not done. Production activation has not been performed.

## Context

DQ-024 left `runBoundedSinglePageCrawlWithDependencies` and the D1 store. The old DQ-025 title assumed the Worker would pin HTTPS. This decision leaves website transport on the Node crawler.

## Decision

GitHub Actions runs `npm run crawl:cloud` once per schedule. The Worker authenticates `CRAWL_GATEWAY_TOKEN` and calls `selectD1CrawlCandidates` and `persistD1CrawlEvidence`. The schedule is `17 6 * * *` with `timezone: "Europe/Warsaw"`. Schema remains `migrations/0001_delta_qoralis_crawl.sql`. Website collection stays on the existing Node crawler. The Worker does not fetch business websites.

## Consequences

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is implemented in the repository and is not production-complete. Production activation has not been performed. Phase 2 stays current until the ten production checks in the spec succeed. Phase 2 is not completed. Discovery stays on local SQLite. Decision 0015 stays the DQ-024 record. Cloudflare autonomous crawling is not yet enabled. Phase 3 stays planned.
