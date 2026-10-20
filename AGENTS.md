# Delta Qoralis Agent Guidance

## Working rules

- Inspect existing code and tests before modifying them; preserve working behavior.
- Make the smallest secure implementation that satisfies the approved task. Do not add premature future scope.
- Preserve module boundaries.
- Do not add a dependency without justification.
- Never expose secrets, commit `.env` files, force-push, automatically deploy, or automatically send real outreach.
- Do not perform production database operations without explicit approval.
- Run relevant existing tests after changes. Tests stay offline unless live access is explicitly authorized. Never weaken tests merely to make them pass.
- Do not bypass CI, including failed CI.
- Do not work directly on `main`. A direct push to `main` requires explicit human-owner authorization.
- Do not start the next DQ item before the current one is completed.
- Do not reinterpret a future backlog item as part of the current task.
- Document significant architectural decisions in `docs/decisions/`.

## Development workflow

The required order is:

Architect → Builder → Analyst → Human approval → Commit → Push → Pull Request → CI → Merge → Branch cleanup

- **Architect:** Inspect the actual repository. Do design and research only. An architecture task does not change application code or other repository files unless that change is explicitly authorized. Do not implement. Do not create a branch, commit, or push.
- **Builder:** Implement only the approved scope on the approved feature branch. Use tests and test-driven development where appropriate, and run validation. Leave the implementation unstaged and uncommitted for Analyst review. Do not commit, push, or open a pull request before the Analyst records APPROVED.
- **Analyst:** Independently inspect the actual source, diff, tests, and docs. Run validation independently. Modify nothing. Finish exactly with APPROVED or CHANGES REQUIRED.
- **After APPROVED:** The Builder does final bookkeeping, validates again, stages, commits, pushes, and creates the pull request. Wait for CI. Merge only after green CI and human authorization. Then clean up the feature branches.

Inspect `git status` before modifying files. Keep commits small, scoped to one logical change, and validate before committing. Never force-push, rewrite shared history, delete remote branches without approval, or commit secrets. Never bypass failed CI or automatically merge a pull request.

Branch names use `foundation/<description>`, `feature/<ticket>-<description>`, `fix/<ticket>-<description>`, `docs/<description>`, or `chore/<description>`.

Commit messages use a scoped conventional prefix: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, or `refactor:`. Commits must not contain generated junk or unrelated edits.

## Roles

- **Architect** inspects the actual repository and does design and research only. The Architect does not implement, does not change application code or repository files for an architecture task unless explicitly authorized, and does not create a branch, commit, or push.
- **Feature Proposer** proposes features and does not implement them.
- **Builder** implements only approved scope on the approved feature branch, uses tests where appropriate, runs validation, and leaves that work unstaged and uncommitted until the Analyst records APPROVED. The Builder does not commit, push, or open a pull request before APPROVED. After APPROVED, the Builder completes bookkeeping, validation, commit, push, pull request, the CI wait, the human-authorized merge, and feature-branch cleanup.
- **Analyst** independently inspects the actual source, diff, tests, and docs, runs validation independently, modifies nothing, and finishes exactly with APPROVED or CHANGES REQUIRED.
