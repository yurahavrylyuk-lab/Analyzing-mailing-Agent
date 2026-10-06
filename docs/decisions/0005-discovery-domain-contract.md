# 0005 — Use a bounded provider-independent discovery contract

## Status

Accepted and completed in DQ-010.

## Context

Phase 1 needs a stable discovery vocabulary before any external provider, network access, or persistence behavior is introduced. Provider-specific response types and optional data must not leak into the application domain, and a requested lead count must not hide the cost of invalid or rejected provider results.

## Decision

Represent discovery input as normalized location and query text plus `maxResults`, bounded from 1 to 60 and defaulting to 20. `maxResults` is a budget of provider result slots examined, not a promised accepted-lead count. Every returned slot consumes the budget regardless of whether it is accepted, rejected, invalid, or later found to be a duplicate.

Normalize each provider result into one ordered allowlisted outcome. Accepted candidates contain only a stable provider identifier, opaque case-sensitive provider reference, normalized business name, and an unknown-or-present website observation. Invalid references and business names become safe rejection codes; an invalid optional website becomes unknown with a safe warning. Website values reuse the lead storage normalizer and are not approved network targets.

Providers implement a small asynchronous page contract with an `AbortSignal`, page sizes capped at 20, an optional opaque bounded cursor, and consistent provider identity. Provider SDK and HTTP types cannot escape this boundary.

## Consequences

DQ-010 can be tested entirely offline with deterministic fake page sequences. It adds no provider configuration or activation, API integration, HTTP or DNS behavior, pagination runner, retry behavior, database migration, persistence, audit event, or lead creation. Those capabilities require later, separately reviewed DQ-011–015 work.
