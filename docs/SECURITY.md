# Security Boundaries

The following are non-negotiable:

- No real email sending without explicit approval.
- No automatic client replies.
- No production deployments or production payment operations.
- No force pushes and no committed secrets.
- Without explicit human approval: no history rewriting, shared-branch deletion, CI bypassing, GitHub security-check disabling, repository visibility or ownership changes, production-secret changes, automatic pull-request merges, or production deployment credentials pushed to the repository.
- No direct Google Maps webpage scraping.
- Network targets allow only normalized HTTP(S) default-port URLs whose direct address or every DNS answer is public. The classifier treats fec0::/10, 3fff::/20, 64:ff9b:1::/48, and 100:0:0:1::/64 as non-public. Local names, unsafe addresses, mixed safe/unsafe DNS answers, and unsafe redirects fail closed.
- Website page fetches go through `fetchCrawlPage`. Every connection goes through DQ-006, and the socket is pinned to that hop's first approved address. Redirects are revalidated. An HTTPS-to-HTTP hop is refused. Crawl errors use fixed messages and do not reflect URLs, hosts, addresses, DNS text, headers, bodies, certificates, or abort reasons.
- Lead-specific do-not-contact suppression is insert-only, audited atomically, and checked through a fresh fail-closed guard before any future contact action.
- Discovered lead identity is provider-specific and enforced by a case-sensitive partial unique index. Rediscovery never refreshes lead fields, clears suppression, or appends another creation event.
- Future unsubscribe ingestion and any future suppression-clearing workflow require separate design and review; neither exists in DQ-007.

New external providers must be introduced behind provider interfaces and reviewed for least-privilege access.

DQ-006 supplies validation and approved-address results only. It does not fetch URLs, follow redirects, parse content, or provide an HTTP transport.

DQ-020 fetches one HTML page through that validation. Each hop is approved again, then the socket is pinned to the first approved address. The fetcher does not add a second address list, a crawl command, a spider, analysis, contact extraction, outreach, or crawl persistence. A stored website URL is still untrusted until `fetchCrawlPage` revalidates it.

DQ-021 calls `fetchCrawlPage` once for one caller-held lead whose website observation is present. The stored URL stays untrusted and is not treated as an approved target. Failure evidence stores a `NetworkTargetError` or `CrawlPageError` code and does not store the error message, response body, or network details. The contact guard is not consulted. The operation does not persist evidence, write an audit event, or change the lead.

DQ-007 stores only a reason code, canonical timestamp, and claimed human or system actor for a lead. It adds no contact details, notes, consent model, outreach, or sending behavior. Suppression and audit tables use database triggers against accidental update or deletion; this is not protection from a database administrator.

DQ-011 validates discovery provenance again at the persistence boundary and treats malformed stored rows, schema failures, contention, and audit failures as generic persistence errors. Provider identities, references, business names, website URLs, SQL, and raw database causes are not exposed through those errors or copied into audit details. A persisted discovery website URL is storage-only and is not approved for network access; future connections must still pass DQ-006 validation. This capability performs no HTTP, DNS, provider access, crawling, or outreach.

DQ-012 keeps discovery disabled unless `DISCOVERY_PROVIDER` is exactly `geoapify` and a valid `GEOAPIFY_API_KEY` is present. Keys never activate a provider by themselves; the Google placeholder is ignored and cannot act as a fallback. Configuration errors use fixed messages and never reflect provider values, keys, environment objects, or raw causes. Parsing performs no I/O and does not instantiate a provider.

DQ-013 sends the Geoapify credential only in the `x-api-key` header to two fixed HTTPS endpoints; URLs, cursors, public errors, and returned domain values never contain the key. Redirects are refused, retries are disabled, each operation has a 15-second deadline, and decoded bodies are incrementally capped at 1 MiB. Provider and malformed-response errors use fixed allowlisted messages without response bodies, URLs, headers, query values, native causes, or abort reasons.

The adapter accepts only four exact query tokens, requires one city result, and uses only OpenStreetMap node/way/relation identity from the Places datasource. It ignores geometry, address, contacts, ratings, raw tags, and every alternate identity or website field. A returned website is storage-only and still requires DQ-006 validation before any future connection. Cursors are HMAC-authenticated with a random adapter-local key, bound to normalized criteria, capped at 2,048 ASCII characters, and intentionally invalid after adapter restart. DQ-013 adds no automatic provider activation, persistence, crawling, contact processing, or outreach.

DQ-014 runs one injected provider and persists accepted outcomes one at a time through the existing lead boundary. It does not construct a provider, read credentials or environment variables, decode cursors, retry, or roll back earlier committed leads. A returned run result contains only the provider id, slot and persistence counters, and a stop code. It omits criteria text, cursors, candidate fields, raw errors, response bodies, SQL, and credentials. Cancellation leaves examined slots from a valid page in the summary and leaves unpersisted accepted outcomes unpersisted.

DQ-015 prints that same run summary plus the two approved attribution lines. Stdout and stderr never include the API key, raw provider bodies, cursors, lead ids, business names, websites, the actor id, SQL, or stack traces. Configuration, database, and provider failures use fixed sentences. A failed or cancelled run does not exit 0. The command does not retry, schedule work, or open a live network in tests. `GOOGLE_PLACES_API_KEY` remains unread. Suppression is not applied, cleared, or bypassed by the command.
