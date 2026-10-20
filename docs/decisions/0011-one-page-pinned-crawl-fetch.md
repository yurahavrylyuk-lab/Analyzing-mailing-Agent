# 0011 — Fetch one pinned HTML page

## Status

Accepted and completed in DQ-020.

## Context

DQ-006 approves a normalized HTTP(S) target and the exact public addresses for that hop. It does not open a socket, follow a redirect, or read a body. Stored website URLs remain storage syntax and are not approved connection targets. The grouped Phase 2 backlog did not give DQ-020 its own title. This decision decomposes that phase into one page fetch. It does not name DQ-021, DQ-022, DQ-023, or DQ-024.

## Decision

`DQ-020 — One-Page Pinned Crawl Fetch` is this architecture's decomposition, not an old backlog title. `fetchCrawlPage` accepts one untrusted URL and one `AbortSignal` and returns one frozen HTML page, or a fixed error. Redirect hops are part of retrieving that page. They are not extra crawled pages.

Every hop calls DQ-006. The first hop uses `resolveSafeTarget`. Each later hop uses `resolveSafeRedirect`. Production always passes `createNodeDnsResolver()`. The socket connects to the first approved address only. There is no failover and no second DNS lookup. `node:http` serves port 80 and `node:https` serves port 443. The hostname stays on the request for the Host header, TLS SNI, and certificate checks. Automatic redirects stay off. The transport is not on the public crawler API.

At most five redirects are followed, so one call makes at most six transport requests. An HTTPS target followed by an HTTP target is refused before the cleartext connection. HTTP to HTTPS is allowed after revalidation. Any other non-200 status fails. One 15-second deadline covers DNS, every hop, and the body. The body cap is 1,048,576 bytes. `Content-Encoding` must be absent or `identity`. The final body must be fatal-checked UTF-8 `text/html` or `application/xhtml+xml`.

Crawl failures use fixed messages. `NetworkTargetError` propagates unchanged. There is no persistence, no crawl command, no retry, and no spider. The loopback transport test dials `127.0.0.1` through an internal `connectPort` because DQ-006 rejects loopback before `fetchCrawlPage` can connect. That test does not widen the approved port set and does not call `fetchCrawlPage`.

## Consequences

Later tasks may call `fetchCrawlPage` with a stored URL. That call still revalidates through DQ-006. Callers must not follow redirects inside a client, and they must not treat a stored URL as an approved target. The internal transport and its `connectPort` seam stay off the public API. Phase 2 remains current. DQ-021 through DQ-024 stay untitled and unstarted. A successful page is not a lead mutation, a qualification, a contact, or an outreach action.
