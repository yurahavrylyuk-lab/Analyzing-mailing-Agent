# 0001 — BusinessLead lifecycle and concurrency

## Status

Accepted for DQ-004.

## Context

Business leads need a small persisted lifecycle before discovery, qualification, contacts, or outreach exist. Multiple operations may act on an earlier view of the same lead.

## Decision

Store BusinessLead in SQLite behind the database abstraction. Keep lifecycle and website-observation rules in a service, persistence in a focused repository, and use a discriminated union for website observations. Every update checks an expected positive version and uses a conditional SQL update inside a transaction. Website URLs receive syntax and normalization checks only; network and SSRF checks remain outside DQ-004.

## Consequences

Stale writes fail instead of overwriting newer state, same-value operations remain stable after version validation, and later modules can consume the lead service without importing the SQLite driver or bypassing lifecycle rules.
