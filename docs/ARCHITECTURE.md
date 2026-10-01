# Architecture

Delta Qoralis will be a modular TypeScript application. Configuration, domain logic, provider integrations, persistence, and delivery interfaces will stay separate so modules can be tested and changed independently.

## Planned modules

- `config`: validated application configuration, separated from business logic.
- `core`: shared domain primitives and narrow cross-cutting contracts.
- `db`: persistence interfaces and implementations.
- `discovery`: business-source discovery.
- `crawler`: safe website retrieval and crawl results.
- `website-analysis`: analysis of crawler results.
- `contacts`: contact discovery and consent-related contact state.
- `leads`: lead lifecycle and qualification.
- `outreach`: draft creation and approval-gated delivery requests.
- `conversations`: reply and conversation state.
- `clients`, `projects`, `subscriptions`: post-conversion client work.
- `payments`, `deployment`: replaceable provider adapters for payments and hosting.
- `dashboard`, `cli`, `workflows`: human-facing and orchestration entry points.
- `compliance`, `logging`: safety controls and auditable operational records.

## Dependency boundaries

- Discovery does not depend on outreach or email delivery.
- The crawler has no payment concerns; website analysis consumes crawler results rather than managing discovery.
- Outreach consumes qualified lead data and does not select or crawl businesses.
- Provider-facing modules use interfaces owned by the application, keeping external services replaceable.
- Configuration and auditability are cross-cutting concerns, not hidden inside feature logic.
- High-impact actions remain approval-gated.

The source directories will be added with real code as their owning backlog items are implemented; this foundation deliberately creates no placeholder feature code.

Until application source exists, the TypeScript project validates the repository package manifest. This keeps the strict compiler configuration executable without inventing application code.

## Development workflow

Task → Branch → Builder → Tests → Analyst → Pull Request → CI → Human approval → Merge.

GitHub is currently development infrastructure: it hosts the repository, pull requests, and CI checks. It is not an application dependency. A future application-level GitHub provider may live near `src/integrations/github/` and, after explicit implementation approval, support approved client repository creation, branch creation, commits, pushes, repository-state retrieval, and preview/deployment metadata.

That future provider must require explicit human approval for repository creation, production-branch modification, merges, production deployment, and destructive operations. It must never force-push.
