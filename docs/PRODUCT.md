# Product

Delta Qoralis is planned as a human-controlled system that takes a potential business from discovery through service delivery:

Business discovery → Website analysis → Lead qualification → Contact discovery → Outreach draft → Human approval → Email → Replies → Client requirements → Website generation → Preview → Payment → Deployment → Support subscription.

The foundation is complete and Phase 1 — Lead Discovery is complete. The implementation defines a provider-independent discovery contract and a persistence boundary for audited, idempotent creation of normalized discovery candidates. It supports explicit, disabled-by-default Geoapify configuration and a bounded adapter for four exact business categories. `runBoundedDiscovery` orchestrates bounded pages for one injected provider and persists accepted outcomes. `npm run discover` is the controlled operator command that composes those pieces for one explicit human actor. Discovery is operational through that command. Website crawling, website analysis, lead qualification, contact discovery, outreach, messaging, payments, deployment, and a dashboard are not implemented.
