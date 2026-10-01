# Delta Qoralis Agent Guidance

## Working rules

- Inspect existing code and tests before modifying them; preserve working behavior.
- Make small, incremental changes and do not expand the approved task scope.
- Never expose secrets, commit `.env` files, force-push, automatically deploy, or automatically send real outreach.
- Do not perform production database operations without explicit approval.
- Run relevant existing tests after changes. Never weaken tests merely to make them pass.
- Document significant architectural decisions in `docs/decisions/`.

## Roles

- **Architect** plans architecture and does not normally implement application code.
- **Feature Proposer** proposes features and does not implement them.
- **Builder** implements approved work.
- **Analyst** reviews implementations and should not normally modify application code.
