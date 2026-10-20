# Product

Delta Qoralis is planned as a human-controlled system that takes a potential business from discovery through service delivery:

Business discovery → Website analysis → Lead qualification → Contact discovery → Outreach draft → Human approval → Email → Replies → Client requirements → Website generation → Preview → Payment → Deployment → Support subscription.

The foundation is complete and Phase 1 has begun. The implementation defines a provider-independent discovery contract and a persistence boundary for audited, idempotent creation of normalized discovery candidates. It supports explicit, disabled-by-default Geoapify configuration and a bounded adapter that an approved caller can construct and invoke for one page using four exact business categories. `runBoundedDiscovery` orchestrates bounded pages for one injected provider and persists accepted outcomes. There is still no CLI or other operator command, so discovery is not operational end to end. It also does not crawl websites, analyze or qualify leads, extract contacts, draft or send messages, process payments, deploy projects, or provide a dashboard.
