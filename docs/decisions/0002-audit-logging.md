# 0002 — Atomic append-only lead audit events

## Status

Accepted and completed in DQ-005.

## Context

Lead mutations need durable attribution and history without allowing an audit record to claim a change that did not commit, or a lead change to commit without its matching event. Audit details must remain deliberately narrow so operational history does not become a second store for sensitive business or provider data.

## Decision

Store typed lead audit events in SQLite behind an append-and-list repository. LeadService accepts the database through its production constructor and internally creates a lead-specific unit of work; callers cannot substitute its lead repository, audit repository, or transaction context. The unit of work constructs both repositories over that database instance and wraps both writes in one database transaction. LeadService requires a validated claimed actor, appends exactly one event after each actual mutation, and uses the resulting lead timestamp. No-op and rejected operations append nothing.

Event details use strict event-specific allowlists and a 2048-byte serialized limit. They never contain business names, source references, or raw website URLs. Integer IDs define history order. The repository offers no mutation methods, and database triggers reject direct updates and deletes. Audit entity IDs intentionally have no foreign key so history can remain durable across future entity-lifecycle choices.

## Consequences

An audit insertion failure rolls back its lead insert or update, and optimistic lead concurrency remains intact. Histories are deterministic even when timestamps match. Attribution is claimed context only; authentication, authorization, audit search, analytics, and backfill are deferred.
