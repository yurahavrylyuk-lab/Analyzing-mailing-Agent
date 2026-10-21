# 0012 — Lead-linked single-page crawl evidence

## Status

Accepted and completed in DQ-021.

## Context

DQ-020 fetches one untrusted URL into one frozen HTML page and does not know about leads. A stored website URL remains business data. It is not an approved connection target. Before this decision, nothing joined one caller-held `BusinessLead` to that fetch, and a thrown crawl error carried no lead, timestamp, or evidence value. This decision is a new decomposition. `docs/PLAN.md` and `docs/BACKLOG.md` left DQ-021 untitled before this task.

## Decision

`DQ-021 — Lead-Linked Single-Page Crawl Evidence` accepts one caller-held `BusinessLead` and one `AbortSignal`. A present website observation is required. The stored URL is untrusted and is passed unchanged to `fetchCrawlPage`. That function is the only production fetch, and it is called once.

The result is one frozen in-memory value. Fetched evidence copies the page. Failed evidence records a `NetworkTargetError` or `CrawlPageError` code. Known network and crawl errors become those codes. Other errors propagate. There is no `UNEXPECTED` category. `attemptedAt` is the ISO timestamp taken when the attempt begins. `leadVersion` is snapshot provenance from `BusinessLead.version` on the caller-held lead.

DQ-021 does not re-validate `CrawlPageResult`. It adds no persistence, audit event, lead mutation, command, selection, batch, spider, do-not-contact check, analysis, contact discovery, or outreach. `collectSinglePageCrawlEvidenceWithDependencies` is the test-only dependency seam. `src/crawler/index.ts` does not export it.

## Consequences

A stored URL is still revalidated by DQ-020 on every call. Later persistence and selection consume this in-memory value. DQ-022, DQ-023, and DQ-024 stay untitled and unstarted. Phase 2 remains current. Phase 3 remains planned.
