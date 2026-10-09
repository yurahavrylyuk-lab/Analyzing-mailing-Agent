# 0007 — Select Geoapify with explicit discovery configuration

## Status

Accepted and completed in DQ-012.

## Context

Phase 1 needs one eligible provider before an adapter can be designed. The provider must support internal retention of the business identity, name, and available website used by the existing `BusinessLead` model without silently activating through the presence of a credential.

Official sources were reviewed on 2026-10-09. [Geoapify's Places documentation](https://www.geoapify.com/places-api/) permits Places results to be cached and stored, says the service is primarily backed by OpenStreetMap, and requires attribution. [OpenStreetMap's copyright guidance](https://www.openstreetmap.org/copyright) identifies the ODbL and its attribution and share-alike obligations. This record documents an engineering decision based on the reviewed terms, not legal advice.

Google Places is not approved for the DQ-013 adapter. [Google's Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) allow place IDs to be stored as a specific exception but otherwise restrict caching and storage of Places content. That exception does not establish the durable retention needed here for business names and website values. `GOOGLE_PLACES_API_KEY` therefore remains only an inactive documentation placeholder.

## Decision

Geoapify Places, provider ID `geoapify`, is the selected first discovery provider for future DQ-013 integration. Internal Phase 1 retention of provider reference, business name, and an available business website is approved. This decision does not approve public lead-database redistribution, client data exports, resale, unlimited production use, or automatic business contact.

Discovery configuration is a frozen discriminated union. It defaults to `{ provider: "disabled" }`. Geoapify is eligible only when `DISCOVERY_PROVIDER` is exactly `geoapify` and `GEOAPIFY_API_KEY` is present and contains no whitespace or control characters. The opaque key is preserved unchanged. Unset or explicit `disabled` selection ignores all provider keys and returns no key field. Google values are neither parsed nor validated and have no runtime effect or fallback role.

Attribution remains mandatory. The baseline for future visible output is:

- © OpenStreetMap contributors
- Powered by Geoapify

Geoapify Places is primarily OpenStreetMap-derived, so underlying OSM/ODbL obligations remain relevant. DQ-012 adds no runtime attribution UI and no licensing storage.

The reviewed [Geoapify pricing page](https://www.geoapify.com/pricing/) lists Free at 3,000 credits per day and up to 5 requests per second, and API 10 at 10,000 credits per day, up to 12 requests per second, and $59 per month on monthly billing. [Places pricing documentation](https://apidocs.geoapify.com/docs/places/) states that up to 20 returned places cost one credit and larger result counts consume additional credits. Daily quotas are soft operational limits, not guaranteed hard spending caps. Geocoding, Place Details, and other auxiliary calls consume additional credits. DQ-012 implements no counters, scheduler, monitoring, billing, or plan detection.

Geoapify's current Places examples authenticate with an `apiKey` request parameter. DQ-013 must use a documented authentication method and prevent credentials from reaching application logs, HTTP diagnostics, exceptions, traces, controllable reverse-proxy logs, or printed request URLs.

## Consequences

Configuration parsing only reads the supplied environment. It performs no HTTP, DNS, file, or database access; creates no provider; and starts no runner or health check. There is no provider adapter or operational discovery pipeline in DQ-012.

Before DQ-013 implementation, a separately reviewed design must resolve Geoapify category and query mapping, location resolution and possible geocoding, provider-reference stability, whether initial website state remains unknown, whether Place Details is justified, auxiliary API costs, credential-safe query-string transport, and attribution in future visible output.
