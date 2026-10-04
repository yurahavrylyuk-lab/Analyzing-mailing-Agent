# 0003 — Resolve and pin safe network targets

## Status

Accepted and completed in DQ-006.

## Context

Stored website URLs are business data, but using an untrusted URL as a network destination creates SSRF and DNS-rebinding risks. A future crawler needs a small validation boundary before it can safely add transport behavior.

## Decision

Keep storage validation and network-target validation separate. Network targets allow normalized HTTP(S) URLs on default ports, reject local names and non-public direct addresses, and resolve through an injected DNS boundary. Every A and AAAA answer must be valid and public; one unsafe answer rejects the entire target.

Return the exact immutable approved addresses with the normalized URL, hostname, and port. A future transport must connect to one of those addresses while retaining the hostname for authority, TLS SNI, and certificate verification. Every redirect, including same-host and relative redirects, requires complete URL and DNS revalidation before use.

## Consequences

DNS rebinding cannot be addressed by validating a hostname and then allowing a later independent lookup. Automatic redirect following must remain disabled; a future crawler should validate each `Location` and cap redirects, for example at five. DQ-006 performs no HTTP requests and introduces no crawler.
