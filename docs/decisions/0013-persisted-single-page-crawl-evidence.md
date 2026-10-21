# 0013 — Persisted single-page crawl evidence

## Status

Accepted and implemented by DQ-022.

## Context

DQ-021 builds one frozen in-memory `SinglePageCrawlEvidence` value and does not store it. Phase 3 needs that attempt, with its provenance, after the process exits. This decision is a new decomposition. `docs/PLAN.md` and `docs/BACKLOG.md` left DQ-022 untitled before this task. Persistence follows DQ-021: the caller already holds the finished value.

## Decision

`DQ-022 — Persisted Single-Page Crawl Evidence` stores one already-built fetched or failed `SinglePageCrawlEvidence` and reads that attempt back by id. `SinglePageCrawlEvidenceService.persist` validates the value, requires the referenced `business_leads` row to exist, inserts one immutable row, and returns the stored attempt with its database id. `findById` reads that one row. There is no `listForLead`, latest-attempt query, pagination, or global list.

The table is append-only `single_page_crawl_evidence`. Identity is an `INTEGER PRIMARY KEY` without `AUTOINCREMENT`. Two deep-equal values are two rows and two ids. An identical `attemptedAt` is valid and is two ids. There is no uniqueness on lead, version, time, URL, body, or failure code, and no update or delete API. Triggers reject `UPDATE` and `DELETE`. Future retention needs an explicit schema-policy change.

`leadVersion` and `requestedUrl` are historical provenance copied from the evidence. A current lead version or website URL does not rewrite or reject an older attempt. The lead row must exist. The foreign key is `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`. Archived and suppressed leads remain eligible. The lead is not mutated.

Fetched rows store untrusted HTML as UTF-8 `TEXT`, capped at 1,048,576 bytes. Failed rows store an allowlisted `NetworkTargetError` or `CrawlPageError` code and no body, status, or raw error message. Migration `022-single-page-crawl-evidence` is public as `singlePageCrawlEvidenceMigration` and the sole member of frozen `crawlerMigrations`. Before creating the table it verifies the current post-DQ-011 `business_leads` schema and that foreign keys are enabled with a valid existing foreign-key state. The discovery command does not apply `crawlerMigrations`. A caller composes `leadMigrations` and `crawlerMigrations` explicitly.

DQ-022 does not fetch, select leads, add a command, write an audit event, record an actor, consult do-not-contact state, analyze HTML, extract contacts, or send outreach.

## Consequences

One accepted persist is one new attempt that `findById` can return after the process exits. The discovery migration list is unchanged. DQ-023 and DQ-024 stay untitled and unstarted. Phase 2 remains current. Phase 3 remains planned. A future renderer must treat `bodyText` as untrusted. Deleting or rewriting evidence is not available through this repository.
