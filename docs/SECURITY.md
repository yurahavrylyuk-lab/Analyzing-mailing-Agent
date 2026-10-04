# Security Boundaries

The following are non-negotiable:

- No real email sending without explicit approval.
- No automatic client replies.
- No production deployments or production payment operations.
- No force pushes and no committed secrets.
- Without explicit human approval: no history rewriting, shared-branch deletion, CI bypassing, GitHub security-check disabling, repository visibility or ownership changes, production-secret changes, automatic pull-request merges, or production deployment credentials pushed to the repository.
- No direct Google Maps webpage scraping.
- Network targets allow only normalized HTTP(S) default-port URLs whose direct address or every DNS answer is public. Local names, unsafe addresses, mixed safe/unsafe DNS answers, and unsafe redirects fail closed.
- The future crawler must disable automatic redirects, revalidate every redirect, cap redirect depth, and connect to an approved resolved address without a second DNS lookup.
- Future do-not-contact and unsubscribe states must fail closed.

New external providers must be introduced behind provider interfaces and reviewed for least-privilege access.

DQ-006 supplies validation and approved-address results only. It does not fetch URLs, follow redirects, parse content, or provide an HTTP transport.
