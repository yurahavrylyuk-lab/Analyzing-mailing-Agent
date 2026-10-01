# Security Boundaries

The following are non-negotiable:

- No real email sending without explicit approval.
- No automatic client replies.
- No production deployments or production payment operations.
- No force pushes and no committed secrets.
- Without explicit human approval: no history rewriting, shared-branch deletion, CI bypassing, GitHub security-check disabling, repository visibility or ownership changes, production-secret changes, automatic pull-request merges, or production deployment credentials pushed to the repository.
- No direct Google Maps webpage scraping.
- The future crawler must enforce SSRF protection.
- Future do-not-contact and unsubscribe states must fail closed.

New external providers must be introduced behind provider interfaces and reviewed for least-privilege access.
