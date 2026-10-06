# 0006 — Persist discovery provenance with provider-scoped idempotency

## Status

Accepted and completed in DQ-011.

## Context

Accepted discovery candidates need durable BusinessLead records without confusing provider identity with application UUIDs, duplicating the same provider result, leaking provenance into audit details, or weakening existing do-not-contact state. The existing suppression table references `business_leads`, so extending lead provenance requires a migration that preserves that dependency safely.

## Decision

BusinessLead provenance is an explicit union. Manual leads retain `sourceKind: manual`, a source reference, and no provider property. Discovered leads use `sourceKind: discovery`, a stable lowercase provider ID, and an opaque case-sensitive provider reference. A partial binary unique index on `(source_provider, source_reference)` applies only to discovery rows; UUID generation remains independent and manual duplicates remain valid.

`recordDiscoveredLead` validates its leads-owned input and actor before duplicate handling, then uses the existing audited database transaction. A new identity inserts the lead and existing `lead.created` event atomically. Rediscovery returns the authoritative stored lead and does not refresh its name, website observation, lifecycle, timestamps, version, suppression, or audit history.

Migration 011 backs up suppression values without a foreign key, replaces `business_leads`, recreates the exact suppression schema and immutability triggers, restores and verifies every suppression, checks foreign-key integrity, and removes its temporary table inside the existing migration transaction. It does not rebuild audit storage.

## Consequences

Database uniqueness is authoritative under contention. A competing caller either returns the committed winner or receives a generic `LeadPersistenceError`; it cannot silently overwrite or create a second identity. Discovery provenance remains on the lead and is intentionally absent from audit details. DQ-011 adds no provider configuration, provider adapter, HTTP or DNS operation, pagination runner, crawling, qualification, contacts, or outreach.
