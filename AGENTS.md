# Delta Qoralis Agent Guidance

## Working rules

- Inspect existing code and tests before modifying them; preserve working behavior.
- Make small, incremental changes and do not expand the approved task scope.
- Never expose secrets, commit `.env` files, force-push, automatically deploy, or automatically send real outreach.
- Do not perform production database operations without explicit approval.
- Run relevant existing tests after changes. Never weaken tests merely to make them pass.
- Document significant architectural decisions in `docs/decisions/`.

## Git workflow

- Inspect `git status` before modifying files and implement work on a task branch, never directly on `main`.
- Keep commits small, scoped to one logical change, and validate before committing.
- Never force-push, rewrite shared history, delete remote branches without approval, or commit secrets.
- Never bypass failed CI, automatically merge a pull request, or push directly to `main` unless the human owner explicitly authorizes it.
- Builders may create and edit approved code; Analysts review changes; humans approve merges.

Branch names use `foundation/<description>`, `feature/<ticket>-<description>`, `fix/<ticket>-<description>`, `docs/<description>`, or `chore/<description>`.

Commit messages use a scoped conventional prefix: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, or `refactor:`. Commits must not contain generated junk or unrelated edits.

## Roles

- **Architect** plans architecture and does not normally implement application code.
- **Feature Proposer** proposes features and does not implement them.
- **Builder** implements approved work.
- **Analyst** reviews implementations and should not normally modify application code.
