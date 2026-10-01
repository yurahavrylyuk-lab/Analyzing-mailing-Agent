# Security Boundaries

The following are non-negotiable:

- No real email sending without explicit approval.
- No automatic client replies.
- No production deployments or production payment operations.
- No force pushes and no committed secrets.
- No direct Google Maps webpage scraping.
- The future crawler must enforce SSRF protection.
- Future do-not-contact and unsubscribe states must fail closed.

New external providers must be introduced behind provider interfaces and reviewed for least-privilege access.
