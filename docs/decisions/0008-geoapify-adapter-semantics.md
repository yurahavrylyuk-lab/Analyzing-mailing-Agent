# 0008 — Define bounded Geoapify adapter semantics

## Status

Accepted and completed in DQ-013.

## Context

ADR 0007 selected Geoapify and explicit disabled-by-default configuration but intentionally deferred adapter behavior. DQ-013 needs one narrow implementation of the DQ-010 `DiscoveryProvider` contract without introducing a discovery runner, persistence orchestration, crawling, or outreach.

## Decision

The adapter supports exactly four normalized application query tokens:

- `bakery` → `commercial.food_and_drink.bakery`
- `bookshop` → `commercial.books`
- `cafe` → `catering.cafe`
- `restaurant` → `catering.restaurant`

The first page resolves the normalized location through the fixed Geoapify city-geocoding endpoint and requires exactly one `city` result with a bounded place ID. It then makes one request to the fixed Places endpoint using `filter=place:<area-id>`. A continuation page reuses the authenticated area ID and makes only the Places request. The first page therefore normally consumes two provider requests or credits; a continuation normally consumes one. Failed operations may still be billable under provider policy, and DQ-013 adds no quota or billing monitor.

Accepted identity comes only from an OpenStreetMap datasource with type `n`, `w`, or `r` and a positive JavaScript-safe integer ID. The provider reference is `osm:<type>:<decimal-id>`. There is no fallback to Geoapify place IDs, feature IDs, names, addresses, coordinates, or websites. Each returned feature slot produces one ordered accepted or rejected outcome and advances the raw offset even when rejected.

The business name comes only from `properties.name`. The optional stored website comes only from `properties.website` in the Places search response and passes through the existing storage-only URL normalization. The adapter does not request Place Details, inspect raw OSM website tags or contacts, fetch a website, or approve it as a network target.

Continuation state is a Geoapify-local base64url JSON cursor authenticated with HMAC-SHA-256. It contains only version, bounded area ID, positive safe next offset, and a SHA-256 digest of normalized criteria. A fresh random 32-byte signing key belongs to one adapter instance, so cursors do not survive restart or work across instances. The encoded cursor is capped at 2,048 ASCII characters.

Both requests use fixed HTTPS endpoints, GET, `URLSearchParams`, `Accept: application/json`, `x-api-key`, and manual redirect handling. Every redirect is refused. Each HTTP operation has one 15-second deadline and a 1 MiB decoded-body limit enforced while streaming. There are no retries, endpoint overrides, arbitrary caller headers, or fallback providers.

## Consequences

DQ-013 supplies one explicitly constructed provider that can return a single normalized page. It does not enforce an overall run budget, follow its own cursor, deduplicate across pages, call `recordDiscoveredLead()`, write a database, produce a run summary, expose a CLI, or make discovery operational. DQ-014 and DQ-015 remain separately planned work.
