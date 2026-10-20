# 0009 — Bound one discovery run before persistence

## Status

Accepted and completed in DQ-014.

## Context

DQ-010 defines `maxResults` as provider result slots examined. DQ-011 persists one accepted candidate idempotently and atomically. DQ-012 keeps discovery disabled unless configuration is explicit. DQ-013 can return one normalized page and does not follow its cursor or write a lead. No module connected `searchPage()` to `recordDiscoveredLead()`.

A run has to examine a bounded number of slots, persist only accepted outcomes, and stop on duplicate cursors, malformed pages, cancellation, and persistence failure. It must do that without a command, a retry, a run table, or a provider-specific cursor decoder.

## Decision

`runBoundedDiscovery` in `src/discovery/run.ts` receives one injected `DiscoveryProvider`, a recorder with `recordDiscoveredLead`, an explicit audit actor, and an `AbortSignal`. It normalizes criteria and the actor before any provider call. Every page uses that same provider, the same normalized criteria, and the same signal.

The requested page size is `min(MAX_DISCOVERY_PAGE_SIZE, remaining slots)`. A response is validated before persistence. An over-return is a malformed page: nothing from that response is persisted and its outcomes are not counted. A valid page consumes one examined slot per normalized outcome immediately, including outcomes that are later rejected, duplicated, cancelled, or fail to persist.

Accepted outcomes are then passed to `recordDiscoveredLead` in order with the explicit actor. Rejected outcomes are not persisted. Each successful return increments the persisted counters. `leadsCreated` and `leadsDuplicate` distinguish new leads from stored identities, including archived and suppressed leads. The runner does not refresh, restore, or unsuppress a stored lead.

Cursors stay opaque. The next cursor is blocked when it equals any cursor already observed or followed in the run, including a cycle `A → B → A`. An empty page that still carries a cursor is blocked. A page with no next cursor completes as `results_exhausted`. A further cursor is not followed when no slots remain, which completes as `budget_exhausted`.

Writes stay sequential. There is no run-level transaction and no rollback of an earlier successful write. A persistence failure or cancellation stops the run, leaves the valid page's slot counts in place, and does not persist later accepted outcomes. Provider `CANCELLED` is a cancelled run. Other provider failures and malformed pages add no slots from the attempt that did not yield a valid page. Preflight failures reject before any provider call or write. After preflight, the promise resolves with a frozen result that contains the provider id, the summary counters, and a stop code. The result omits criteria text, cursors, candidate fields, raw errors, response bodies, SQL, and credentials.

The runner imports no Geoapify module, reads no environment, constructs no provider, and decodes no cursor. Network access occurs only inside the injected provider's `searchPage`.

## Consequences

DQ-014 does not add a CLI, HTTP route, scheduler, UI, retry, checkpoint, run table, dependency, or attribution surface. DQ-015 remains planned and has not started. It may call `runBoundedDiscovery` and should not reimplement paging or persistence. A later invocation is safe because rediscovery returns the stored lead. Earlier committed leads remain after a partial failure.
