# 0004 — Use one-way lead contact suppression

## Status

Accepted and completed in DQ-007.

## Context

Future contact discovery and outreach must not treat missing or unreadable suppression state as permission. The foundation needs a small lead-level control before any contact or sending capability exists.

## Decision

Represent do-not-contact state as one insert-only `lead_contact_suppressions` row per BusinessLead. Row existence means suppression is active; the row records only an allowlisted reason, canonical UTC timestamp, and normalized human or system actor. Suppression is independent from lead lifecycle, website observations, timestamps, and optimistic versioning.

The service writes the first suppression and one `lead.do_not_contact_applied` audit event atomically through repositories constructed from the same database. Repeated valid requests return the original persisted row without mutation or another event. A fresh contact guard permits only unsuppressed recorded or reviewing leads and fails closed when lead or suppression state cannot be read and validated reliably.

## Consequences

DQ-007 provides no update, delete, clear, restore, contact, consent, unsubscribe-ingestion, or outreach API. SQLite triggers protect suppression and audit rows from accidental mutation. Any future suppression-clearing capability requires a separate, explicitly designed and audited feature.
