# 0014 — Bounded single-page crawl run

## Status

Accepted and implemented by DQ-023.

## Context

DQ-021 builds one in-memory crawl attempt for a caller-held lead. DQ-022 stores that attempt. Nothing yet chooses which stored leads to crawl, how many, or when a previous attempt is enough. This decision is a new decomposition. `docs/PLAN.md` and `docs/BACKLOG.md` left DQ-023 untitled before this task. The run follows those two boundaries: collection stays `collectSinglePageCrawlEvidence`, and storage stays `SinglePageCrawlEvidenceService`.

## Decision

`DQ-023 — Bounded Single-Page Crawl Run` exposes `runBoundedSinglePageCrawl(database, request)`. The request is an attempt budget from 1 through 60 and an `AbortSignal`. There is no default budget. An invalid request throws `CrawlRunError` `INVALID_REQUEST` with the fixed message `Crawl run request is invalid.`

Selection is a private function in `src/crawler/run.ts`. It opens one read transaction, queries at most `maxAttempts` lead ids, loads each id with the existing `DatabaseLeadRepository.findById` in that order, freezes the snapshot list, and ends the transaction before any collection. Eligible leads are `recorded` or `reviewing`, with `website_presence` `present` and a non-null website URL. Manual and discovered leads are both eligible. Archived leads are excluded. `unknown` and `missing` are excluded. Suppression is ignored. The run does not call `DoNotContactService`.

A finished attempt for the same lead and the exact current website URL blocks another automatic selection. `fetched` is finished. A `failed` row is finished when `failure_code` is not `CANCELLED`. `CANCELLED` alone does not block a later run. A later change of the current URL makes that new URL eligible when it has no finished attempt. A status or version change that leaves the URL in place does not. There is no recrawl flag and no retry inside the run. Selection runs once. Each selected snapshot is collected at most once.

The loop is sequential. For each snapshot it calls `collectSinglePageCrawlEvidence` with the caller's signal, then immediately `SinglePageCrawlEvidenceService.persist` for the one service created for that call. Evidence the collector already returned is persisted before any later abort check. A returned safe failure is counted and the loop continues. `CANCELLED` is persisted, counted as failed, and the run stops. A collector or persist throw propagates. Earlier persists stay committed. The run does not return a summary after a throw.

`SqliteError` from selection becomes `CrawlRunError` `SELECTION_FAILED` with the fixed message `Crawl candidate selection failed.` The driver text is not copied and `cause` is not set. A selected id that `findById` cannot load, or a result longer than the budget, is the same error. `LeadPersistenceError` from lead mapping propagates unchanged.

The frozen result is five counters — `selected`, `attempted`, `fetched`, `failed`, and `persisted` — plus a stop. `completed` / `candidates_exhausted` means the selector returned fewer than `maxAttempts`. `completed` / `budget_exhausted` means it returned exactly `maxAttempts`. `cancelled` / `cancelled` is the other stop. `failed` includes a persisted `CANCELLED` attempt. The summary has no ids, URLs, HTML, or messages.

`runBoundedSinglePageCrawlWithDependencies` is the test seam on `run.ts`. `src/crawler/index.ts` does not export it. Tests may replace select, collect, and persist. Production always supplies the private selector, `collectSinglePageCrawlEvidence`, and one `SinglePageCrawlEvidenceService`.

DQ-023 adds no migration and no index. `crawlerMigrations` remains only `022-single-page-crawl-evidence`. There is no command, scheduler, run table, actor, audit event, analysis, contact extraction, or outreach.

## Consequences

One call crawls at most 60 current website URLs that do not already have a finished attempt, and stores each finished attempt before the next lead. A later run can select a URL whose only stored attempt is `CANCELLED`, or a URL that replaced an earlier one. Other finished attempts stay out of automatic selection. Phase 2 remains current. DQ-024 stays untitled and unstarted. Phase 3 remains planned. The stored URL stays untrusted until DQ-020 revalidates it on the fetch.
