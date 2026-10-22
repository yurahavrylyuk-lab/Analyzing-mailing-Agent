# 0016 — GitHub Actions crawl runner

## Status

Accepted. Production activation is verified.

## Context

DQ-024 left `runBoundedSinglePageCrawlWithDependencies` and the D1 store. The old DQ-025 title assumed the Worker would pin HTTPS. This decision leaves website transport on the Node crawler.

## Decision

GitHub Actions runs `npm run crawl:cloud` once per schedule. The Worker authenticates `CRAWL_GATEWAY_TOKEN` and calls `selectD1CrawlCandidates` and `persistD1CrawlEvidence`. The schedule is `17 6 * * *` with `timezone: "Europe/Warsaw"`. Schema remains `migrations/0001_delta_qoralis_crawl.sql`. Website collection stays on the existing Node crawler. The Worker does not fetch business websites.

## Consequences

`DQ-025 — GitHub Actions Scheduled Crawl Runner and D1 Worker Gateway` is completed. Production activation was verified through GitHub Actions run 39773510876. That `workflow_dispatch` run on `main` at `a1ad31fddfcd9860f37320d46461062afa7644bf` succeeded: selected 1, attempted 1, fetched 1, failed 0, persisted 1. The stored evidence outcome was fetched for `https://example.com/`, HTTP 200, `text/html`. Phase 2 — Website Crawling is completed. Discovery stays on local SQLite and does not feed production D1 automatically. Decision 0015 stays the DQ-024 record. The Worker does not fetch business websites. Scheduled runtime execution does not require the Mac. Phase 3 — Website Analysis is current. DQ-030–039 remain planned.
