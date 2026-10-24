# DQ-038 Scheduled Production Analysis Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing D1 website-analysis pipeline once per calendar day at 15:00 Europe/Warsaw from Cloudflare Cron Triggers on the current crawl-gateway Worker.

**Architecture:** The same Worker default export gains `scheduled` beside the unchanged two-argument `fetch`. `scheduled` awaits `handleScheduledAnalysis`. That boundary reads `controller.scheduledTime`, formats it with `Intl.DateTimeFormat` in `Europe/Warsaw`, and returns immediately unless the local time is 15:00. An active event reuses `geminiConfigFromEnv` and calls `runD1WebsiteAnalysisPipeline(env.DB, config, 50)` with no pipeline options. Two UTC crons, `0 13 * * *` and `0 14 * * *`, are the only schedule; the Warsaw comparison chooses the one that is 15:00.

**Tech Stack:** TypeScript, Cloudflare Workers Cron Triggers, Wrangler 4.152.0, `Intl.DateTimeFormat`, existing `node:test` / `node:assert/strict` runner, `tsc`, no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-24-dq-038-scheduled-production-analysis-runner-design.md`

## Global Constraints

- Delta Qoralis is the company. Analyzing and Mailing Agent is the agent. Do not describe the agent as Delta Qoralis. The Worker name `delta-qoralis-crawl-gateway` stays. Do not create a second Worker.
- Implement only the approved spec and this plan. Do not edit the spec, this plan, `docs/PLAN.md`, or `docs/BACKLOG.md`. Do not start DQ-039.
- The later Builder creates `feature/dq-038-scheduled-production-analysis-runner` from the approved plan commit on `design/dq-038-scheduled-production-analysis-runner`. Do not implement on `main` or on the design branch.
- Do not commit, push, or open a pull request during Builder execution. Each task's commit block is a logical review boundary only. The Builder does not run it and leaves the implementation unstaged and uncommitted until the Implementation Analyst records APPROVED. After APPROVED, the Builder validates again and makes one implementation commit of the four files listed in Task 4. This plan does not authorize the later push, pull request, deploy, or merge.
- Cron expressions are exactly `"0 13 * * *"` and `"0 14 * * *"`. The Wrangler 4.152.0 form, verified against the current `wrangler.toml` which has no `[triggers]` table, is:

```toml
[triggers]
crons = ["0 13 * * *", "0 14 * * *"]
```

- The local target is 15:00 Europe/Warsaw every calendar day. The guard input is `controller.scheduledTime`, not handler execution time, not `Date.now()`, and not `new Date()` with no argument. `controller.cron` is not the decision.
- Format with `Intl.DateTimeFormat`, `timeZone: "Europe/Warsaw"`, `hourCycle: "h23"`, and `hour` / `minute` set to `"2-digit"`. Compare the local `HH:mm` to `15:00`. Do not use the machine timezone, `getHours()`, a timezone package, a hardcoded offset, a DST date list, or a month map.
- A non-finite `scheduledTime`, and a finite value whose `Date` is invalid, fails the invocation with `Error("Scheduled analysis failed.")`. It is not a no-op and not a run. `isWarsawDailyAnalysisTime` returns false for those inputs, and that false must not skip the failure.
- An inactive trigger returns before `geminiConfigFromEnv`, before any read of `GEMINI_API_KEY` or `GEMINI_DAILY_REQUEST_LIMIT`, before `env.DB` `prepare` or `batch`, and before selection, admission, reservation, Gemini, and persistence. `runD1WebsiteAnalysisPipeline` is called 0 times. No exception, no application log, no quota consumption, and no Gemini configuration requirement.
- An active event calls the pipeline exactly once: `runPipeline(env.DB, config, 50)`. The `50` is a call-site literal. Do not declare `SCHEDULED_ANALYSIS_MAX_ITEMS`. Do not add configuration. The approved design uses that identifier to mean this literal; this plan keeps the value and does not introduce the name. Do not pass a fourth argument. Do not pass `scheduledTime` as `options.now` or any other DQ-037 clock override. The pipeline keeps its runtime UTC clock.
- Do not change DQ-037 quota semantics. Reuse 50 unique evidence IDs per UTC day, `GEMINI_DAILY_REQUEST_LIMIT`, batch size at most 5, reservation before fetch, same-day admission, fallback and retry accounting, and the existing selection and persistence. The production limit is 10. Do not bake 10 into source. Tests may pass the string `"10"` as a fixture. There is no second quota system.
- Reuse the current Worker env: `DB`, `CRAWL_GATEWAY_TOKEN`, `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, `GEMINI_DAILY_REQUEST_LIMIT`. Active invalid configuration throws `Error("Scheduled analysis configuration is invalid.")` and does not call the pipeline or touch D1. An inactive event does not evaluate Gemini configuration. Do not call `loadConfig()`. Do not add a config service or a dependency-injection container.
- The safe wrapping point is only the pipeline call and the success log. A pipeline rejection is caught there and rethrown as `new Error("Scheduled analysis failed.")` with no `cause` and without reading the caught value. Do not wrap the configuration error in that catch. Do not log the caught error. The rejection text must not contain SQL, a provider response, a key, a token, HTML, a prompt, or analysis text.
- One successful active run writes one `console.log(JSON.stringify(summary))`. Copy `selected`, `succeeded`, `failed`, `retried`, `persisted`, `utcDate`, `websitesAdmitted`, `websiteLimit`, `geminiRequestsUsed`, `geminiRequestLimit`, and `stoppedReason`. Do not log the result object by reference. The inactive opportunity logs nothing. Failure logs nothing beyond the fixed rejection. No logging framework and no history tables.
- Add `scheduled` on the same default export as `fetch`. Await the boundary. Do not call `ctx.waitUntil`. Do not change `fetch`. `worker.fetch.length === 2` stays valid. `fetch` still calls `handleCrawlGatewayRequest(request, env)` with no pipeline override.
- `POST /internal/analysis/run`, `ANALYSIS_GATEWAY_TOKEN`, `{"maxItems": N}`, auth, validation, statuses, the response schema, and `maxItems` 0 through 50 stay unchanged. Cron does not HTTP-call that route and needs no bearer token. `/internal/crawl/select`, `/internal/crawl/evidence`, and `CRAWL_GATEWAY_TOKEN` stay unchanged.
- No lock, lease, claim, queue, mutex, singleton table, or Durable Object. Overlap uses the existing DQ-037 atomic admission and request reservation. A concurrent invocation may spend another request unit inside those limits. Do not make the pipeline a global singleton.
- No migration. Do not create `migrations/0005` or alter schema. Do not edit `.github/workflows/crawl.yml`.
- Tests use `node:test` and `node:assert/strict`. No Vitest, Jest, new dependency, real Cloudflare, production D1, Gemini, production Worker, or network. Use a pipeline substitute and a database whose `prepare` and `batch` throw if the boundary touches them.
- Do not deploy, enable Cron, run `wrangler deploy`, or run `wrangler triggers deploy`. The activation checklist at the end is not a Builder task.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one is a named test in the owning task.

1. **Delayed execution still uses `scheduledTime`.** The scheduled instant is `2026-07-15T13:00:00.000Z` (15:00 Warsaw). Zero-argument `new Date()` and `Date.now()` report `2026-07-15T16:00:00.000Z` (18:00 Warsaw). The pipeline still runs once. Test: `a delayed execution still runs from scheduledTime` in Task 2.
2. **An inactive Cron with broken Gemini config stays a no-op.** Winter `2026-01-15T13:00:00.000Z` fulfills when `GEMINI_API_KEY` and `GEMINI_DAILY_REQUEST_LIMIT` throw if read, `prepare` and `batch` throw if called, and the pipeline substitute is never entered. Test: `an inactive event with invalid Gemini config does not call the pipeline` in Task 2.
3. **A DST day has exactly one of 13:00Z and 14:00Z at 15:00 Warsaw.** `2026-03-29T13:00:00.000Z` is active and `2026-03-29T14:00:00.000Z` is not. `2026-10-25T13:00:00.000Z` is not and `2026-10-25T14:00:00.000Z` is active. Test: `a DST boundary day activates exactly one of the two UTC hours` in Task 1.
4. **An active pipeline rejection fails the invocation.** The substitute throws a message that contains a fixture secret. The boundary rejects with exactly `Scheduled analysis failed.` and that text does not contain the substitute message or the secret. Test: `a pipeline rejection fails the scheduled invocation` in Task 2.
5. **Manual overlap adds no lock and passes into the existing pipeline.** Two active calls start together and both enter the substitute before either returns, with the same `env.DB` reference, `maxItems` 50, and no fourth argument. Test: `overlapping scheduled calls both reach the existing pipeline` in Task 2. The existing manual test `the pipeline is called once with the forwarded DB, Gemini config, and maxItems` stays unchanged and is not edited.

## File structure

Create:

- `tests/unit/crawl-gateway-scheduled.test.ts` — Warsaw instants, the scheduled boundary, the default `scheduled` export, the safe log, and the static cron strings.

Modify:

- `src/crawl-gateway/worker.ts` — `isWarsawDailyAnalysisTime`, `handleScheduledAnalysis`, and `scheduled` on the existing default export. `fetch` stays a two-argument function.
- `wrangler.toml` — append the `[triggers]` block above. Do not add vars or secrets.
- `tests/unit/crawl-workflow.test.ts` — assertion-only. `wrangler config binds production DB and does not store the gateway token` currently requires `[triggers]` and `crons` to be absent. Those two absent checks become false once this slice adds the schedule. Remove only those two strings from that absent list. Do not change the crawl workflow assertions, and do not edit `.github/workflows/crawl.yml`.

Do not modify:

- `migrations/`
- `src/website-analysis/daily-usage.ts`
- `src/website-analysis/d1-analysis-pipeline.ts`
- `src/config/env.ts`
- `docs/PLAN.md`
- `docs/BACKLOG.md`
- `docs/superpowers/specs/2026-10-24-dq-038-scheduled-production-analysis-runner-design.md`
- `.github/`
- `package.json`
- `package-lock.json`
- `tests/unit/crawl-gateway-worker.test.ts`
- `tests/unit/crawl-gateway-analysis.test.ts`
- `tests/integration/d1-website-analysis-pipeline.test.ts`

`tests/unit/crawl-gateway-worker.test.ts` and `tests/unit/crawl-gateway-analysis.test.ts` must keep passing, including `worker fetch runs maxItems 0 without a pipeline override` (`worker.fetch.length === 2`) and `wrangler.toml does not gain analysis secrets`.

## Test command

Targeted command, from the repository root. Replace the compiled path with the file named in the task. This shell is zsh; use `exit_code`, not `status`.

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/crawl-gateway-scheduled.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

`scripts/run-tests.cjs` compiles with `tsc --noEmit false --outDir .test-build`, runs every compiled `*.test.js`, and deletes `.test-build` in a `finally` block. Full offline verification is:

```bash
node scripts/run-tests.cjs
npm run typecheck
git diff --check
```

`npm run typecheck` is `tsc --noEmit`. Do not add an npm script. After every targeted or full run, `.test-build` must be absent. `package.json` has no Wrangler dependency; do not add one. Wrangler 4.152.0 is the operator CLI already used to confirm the cron table form.

## Interfaces

Task 1 produces the guard. Task 2 consumes it and produces the boundary. Task 3 consumes neither at runtime; it only publishes the cron list. These signatures stay stable across the tasks.

```ts
export function isWarsawDailyAnalysisTime(scheduledTime: number): boolean;

export type ScheduledAnalysisController = Readonly<{
  scheduledTime: number;
  cron?: string;
}>;

export async function handleScheduledAnalysis(
  controller: ScheduledAnalysisController,
  env: CrawlGatewayEnv,
  dependencies?: CrawlGatewayDependencies,
): Promise<void>;
```

`CrawlGatewayEnv` and `CrawlGatewayDependencies` already exist in `src/crawl-gateway/worker.ts`. `dependencies.runPipeline`, when supplied, has the existing pipeline signature:

```ts
runD1WebsiteAnalysisPipeline(
  database: D1WebsiteAnalysisPipelineDatabase,
  config: GeminiWebsiteAnalysisConfig,
  maxItems: number,
  options?: D1WebsiteAnalysisPipelineOptions,
): Promise<D1WebsiteAnalysisPipelineResult>
```

The default export becomes:

```ts
{
  fetch(request: Request, env: CrawlGatewayEnv): Promise<Response>;
  scheduled(
    controller: ScheduledAnalysisController,
    env: CrawlGatewayEnv,
    ctx: unknown,
  ): Promise<void>;
}
```

`scheduled` awaits `handleScheduledAnalysis(controller, env)` and does not pass `dependencies` or `ctx`. `fetch` is unchanged. `noUnusedParameters` is off in `tsconfig.json`, so an unread `ctx` typechecks. Do not read `ctx` and do not call `waitUntil`.

`geminiConfigFromEnv` stays private. It already returns `Object.freeze({ provider: "gemini", apiKey, dailyRequestLimit })` or `undefined`. The scheduled path calls it only after the Warsaw guard is true.

### Task 1: Warsaw scheduled-time guard

**Files:**
- Create: `tests/unit/crawl-gateway-scheduled.test.ts`
- Modify: `src/crawl-gateway/worker.ts`
- Test: `tests/unit/crawl-gateway-scheduled.test.ts`

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: `isWarsawDailyAnalysisTime(scheduledTime: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/crawl-gateway-scheduled.test.ts` with `node:test` and `node:assert/strict`. Import `isWarsawDailyAnalysisTime` from `../../src/crawl-gateway/worker`. Convert each ISO instant with `Date.parse` and pass that number. Do not assert with a fixed `+1` or `+2`.

Tests:

- `summer 2026-07-15 runs at 13:00Z and not at 14:00Z` — `2026-07-15T13:00:00.000Z` is true. `2026-07-15T14:00:00.000Z` is false.
- `winter 2026-01-15 runs at 14:00Z and not at 13:00Z` — `2026-01-15T13:00:00.000Z` is false. `2026-01-15T14:00:00.000Z` is true.
- `a DST boundary day activates exactly one of the two UTC hours` — on `2026-03-29`, 13:00Z is true and 14:00Z is false. On `2026-10-25`, 13:00Z is false and 14:00Z is true. Each day has exactly one true result.
- `the day before each 2026 DST change follows that calendar day` — `2026-03-28T13:00:00.000Z` is false and `2026-03-28T14:00:00.000Z` is true. `2026-10-24T13:00:00.000Z` is true and `2026-10-24T14:00:00.000Z` is false.
- `a non-finite or invalid scheduled time is not the daily analysis time` — `Number.NaN`, `Number.POSITIVE_INFINITY`, `Number.NEGATIVE_INFINITY`, and `Number.MAX_VALUE` are false.
- `the Warsaw guard source does not hardcode offsets or the sample dates` — read `src/crawl-gateway/worker.ts` and assert it contains `Europe/Warsaw` and does not contain `2026-07-15`, `2026-01-15`, `2026-03-28`, `2026-03-29`, `2026-10-24`, `2026-10-25`, `UTC+1`, or `UTC+2`.

- [ ] **Step 2: Run the test to verify the RED**

Run the targeted command for `.test-build/tests/unit/crawl-gateway-scheduled.test.js`.

Expected RED: `tsc` exits non-zero because `isWarsawDailyAnalysisTime` is not exported. Do not add a stub to turn this into a runtime failure.

- [ ] **Step 3: Implement the minimum**

Add the exported function to `src/crawl-gateway/worker.ts`. Keep it a function, not a class. Return false when `Number.isFinite(scheduledTime)` is false or when `Number.isNaN(new Date(scheduledTime).getTime())` is true. Otherwise format that `Date` with `Intl.DateTimeFormat("en-US", { timeZone: "Europe/Warsaw", hourCycle: "h23", hour: "2-digit", minute: "2-digit" })` and `formatToParts`. Return true only when the `hour` part is `"15"` and the `minute` part is `"00"`. Do not read `Date.now()`. Do not add a module.

- [ ] **Step 4: Run the test to verify the GREEN**

Run the same targeted command.

Expected: exit 0. `.test-build` is removed by the command.

- [ ] **Step 5: Review boundary**

Stop for review. Do not `git add` or commit. The logical boundary is the guard and its tests, recorded as `feat: add Warsaw scheduled analysis guard`. That command is not executed before Implementation Analyst approval, and it is not a separate commit after approval.

### Task 2: Scheduled analysis boundary and Worker scheduled()

**Files:**
- Modify: `src/crawl-gateway/worker.ts`
- Modify: `tests/unit/crawl-gateway-scheduled.test.ts`
- Test: `tests/unit/crawl-gateway-scheduled.test.ts`

**Interfaces:**
- Consumes: `isWarsawDailyAnalysisTime(scheduledTime: number): boolean` from Task 1.
- Produces: `ScheduledAnalysisController`, `handleScheduledAnalysis(controller, env, dependencies?): Promise<void>`, and `scheduled` on the default export. Production `scheduled` does not pass `dependencies`.

- [ ] **Step 1: Write the failing tests**

Append these tests to `tests/unit/crawl-gateway-scheduled.test.ts`. Import `handleScheduledAnalysis` and the default export. Build `env.DB` so `prepare` and `batch` throw `Error("d1 touched")`. The pipeline substitute records its `arguments` and is not the real pipeline.

Tests:

- `an inactive event with invalid Gemini config does not call the pipeline` — controller `scheduledTime` is `Date.parse("2026-01-15T13:00:00.000Z")` and `cron` is `"0 13 * * *"`. `GEMINI_API_KEY` and `GEMINI_DAILY_REQUEST_LIMIT` are getters that throw `Error("config read")`. The call fulfills. The substitute was entered 0 times. No log line was captured. D1 was not touched.
- `the cron string does not decide the Warsaw guard` — `2026-07-15T14:00:00.000Z` with `cron` `"0 14 * * *"` fulfills and does not enter the substitute. The same inactive proof as the previous test: throwing config getters and a throwing database.
- `a delayed execution still runs from scheduledTime` — `scheduledTime` is `Date.parse("2026-07-15T13:00:00.000Z")`. For the duration of the call, `Date.now()` and a zero-argument `new Date()` report `Date.parse("2026-07-15T16:00:00.000Z")`. A one-argument `new Date(value)` still represents `value`. Restore `Date` in a `finally`. Valid fixture config is present. The substitute is entered once.
- `an active event calls the pipeline once with the caller database and maxItems 50` — `scheduledTime` is `Date.parse("2026-07-15T13:00:00.000Z")`. Env strings are a fixture key and `GEMINI_DAILY_REQUEST_LIMIT: "10"`. The substitute receives exactly three arguments: the same `env.DB` reference, a frozen `{ provider: "gemini", apiKey, dailyRequestLimit: 10 }`, and `50`. It is entered once.
- `an active event with invalid Gemini config fails before the pipeline` — one active summer controller against each of: missing key, a key containing a space, missing limit, and limit `"0"`. Each call rejects with `Error` whose message is exactly `Scheduled analysis configuration is invalid.`. The substitute is entered 0 times. D1 is not touched. The message does not contain the fixture key.
- `a non-finite or invalid scheduled time fails closed` — `Number.NaN` and `Number.MAX_VALUE`, each with throwing config getters and a throwing database. Each rejects with exactly `Scheduled analysis failed.`. The substitute is entered 0 times.
- `a pipeline rejection fails the scheduled invocation` — the substitute throws `Error("provider body " + fixtureKey)`. The boundary rejects with exactly `Scheduled analysis failed.`. `error.cause` is `undefined`. The rejection string does not contain `provider body` or the fixture key. Captured `console.log` calls are 0.
- `a successful active run logs one safe summary` — replace `console.log` for the call and restore it in `finally`. The substitute resolves a frozen result with distinctive counters and budget `utcDate` `"2026-07-15"`, `websitesAdmitted` `7`, `websiteLimit` `50`, `geminiRequestsUsed` `4`, `geminiRequestLimit` `10`, `stoppedReason` `"request_cap"`. Exactly one log line is captured. `JSON.parse` of that line equals the copied ten fields in this order: `selected`, `succeeded`, `failed`, `retried`, `persisted`, `utcDate`, `websitesAdmitted`, `websiteLimit`, `geminiRequestsUsed`, `geminiRequestLimit`, `stoppedReason`. The line does not contain the fixture key. The logged object is not the pipeline result.
- `the default scheduled export fulfills an off-time event without a pipeline override` — call `worker.scheduled` with the winter no-op controller, an env whose Gemini getters throw, a throwing database, and an unused context object. The promise fulfills. `worker.fetch.length` is 2. The source of `src/crawl-gateway/worker.ts` does not contain `waitUntil` or `SCHEDULED_ANALYSIS_MAX_ITEMS`.
- `overlapping scheduled calls both reach the existing pipeline` — two active summer calls share one env. The substitute increments an entered count and returns a deferred promise. After both calls have been started, and before either deferred promise resolves, the entered count is 2. Each call received the same `env.DB`, the literal `50`, and three arguments. Resolve both results and await both calls.

Capture logs by saving and restoring `console.log`. The repository has no console mock and needs no new dependency. This assignment is the log test.

- [ ] **Step 2: Run the tests to verify the RED**

Run the targeted command for `.test-build/tests/unit/crawl-gateway-scheduled.test.js`.

Expected RED: `tsc` exits non-zero because `handleScheduledAnalysis` is not exported. Task 1's guard tests are already green inside that file; this step adds the missing boundary.

- [ ] **Step 3: Implement the minimum**

Add `ScheduledAnalysisController`, `handleScheduledAnalysis`, and `scheduled` in `src/crawl-gateway/worker.ts`. Keep `fetch` exactly as it is. Handler order:

1. Read `controller.scheduledTime`. If it is not finite, or `new Date(scheduledTime)` is invalid, throw `new Error("Scheduled analysis failed.")`.
2. If `isWarsawDailyAnalysisTime(scheduledTime)` is false, return.
3. Call the existing private `geminiConfigFromEnv(env)`. If it returns `undefined`, throw `new Error("Scheduled analysis configuration is invalid.")`.
4. This is the only catch. `const runPipeline = dependencies?.runPipeline ?? runD1WebsiteAnalysisPipeline`. `try { const result = await runPipeline(env.DB, config, 50); console.log(JSON.stringify({ selected, succeeded, failed, retried, persisted, utcDate, websitesAdmitted, websiteLimit, geminiRequestsUsed, geminiRequestLimit, stoppedReason })); } catch { throw new Error("Scheduled analysis failed."); }`. Copy each field from `result` and `result.budget`. Do not pass the result object to `JSON.stringify`. Do not use the caught value. Do not set `cause`.
5. `scheduled(controller, env, ctx)` awaits `handleScheduledAnalysis(controller, env)` and ignores `ctx`.

Do not branch on `controller.cron`. Do not call `loadConfig()`. Do not add a fourth pipeline argument.

- [ ] **Step 4: Run the tests to verify the GREEN**

Run the same targeted command, then the targeted command with these compiled files in one `node --test` invocation:

- `.test-build/tests/unit/crawl-gateway-scheduled.test.js`
- `.test-build/tests/unit/crawl-gateway-analysis.test.js`
- `.test-build/tests/unit/crawl-gateway-worker.test.js`

Expected: exit 0. `worker fetch runs maxItems 0 without a pipeline override` still passes. `.test-build` is removed.

- [ ] **Step 5: Review boundary**

Stop for review. Do not `git add` or commit. The logical boundary is the scheduled handler, `scheduled`, and their tests, recorded as `feat: run scheduled analysis at 15:00 Warsaw`. That command is not executed before Implementation Analyst approval, and it is not a separate commit after approval.

### Task 3: Wrangler Cron and compatibility

**Files:**
- Modify: `wrangler.toml`
- Modify: `tests/unit/crawl-gateway-scheduled.test.ts`
- Modify: `tests/unit/crawl-workflow.test.ts`
- Test: `tests/unit/crawl-gateway-scheduled.test.ts` and `tests/unit/crawl-workflow.test.ts`

**Interfaces:**
- Consumes: the Worker entry `src/crawl-gateway/worker.ts` from Task 2. No new runtime export.
- Produces: `[triggers]` `crons` containing `"0 13 * * *"` and `"0 14 * * *"`.

- [ ] **Step 1: Write the failing test**

Append `wrangler.toml schedules both Warsaw UTC opportunities` to `tests/unit/crawl-gateway-scheduled.test.ts`. Read `wrangler.toml` with `readFileSync`, the same static style as `wrangler.toml does not gain analysis secrets`. Assert the file contains `[triggers]`, `"0 13 * * *"`, and `"0 14 * * *"`. Assert it does not contain `GEMINI_DAILY_REQUEST_LIMIT`, `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, or `CRAWL_GATEWAY_TOKEN`. Do not add a TOML parser.

- [ ] **Step 2: Run the test to verify the RED**

Run the targeted command for `.test-build/tests/unit/crawl-gateway-scheduled.test.js`.

Expected RED: `wrangler.toml schedules both Warsaw UTC opportunities` fails because the current file has no `[triggers]` table. The crawl-workflow test still passes at this moment because the cron strings are not present yet.

- [ ] **Step 3: Implement the minimum**

Append this block to `wrangler.toml` after the existing D1 binding. Leave `name`, `main`, `compatibility_date`, `compatibility_flags`, and the D1 table unchanged.

```toml
[triggers]
crons = ["0 13 * * *", "0 14 * * *"]
```

In `tests/unit/crawl-workflow.test.ts`, remove `"[triggers]"` and `"crons"` from the absent list in `wrangler config binds production DB and does not store the gateway token`. Keep every other required string and every other absent string, including `CRAWL_GATEWAY_TOKEN`. Do not edit `.github/workflows/crawl.yml`.

- [ ] **Step 4: Run the tests to verify the GREEN**

Run the targeted command with these compiled files:

- `.test-build/tests/unit/crawl-gateway-scheduled.test.js`
- `.test-build/tests/unit/crawl-gateway-analysis.test.js`
- `.test-build/tests/unit/crawl-gateway-worker.test.js`
- `.test-build/tests/unit/crawl-workflow.test.js`

Expected: exit 0. `wrangler.toml does not gain analysis secrets` still passes. `crawl workflow schedules 06:17 Europe/Warsaw and has no deploy credentials` still passes. `.test-build` is removed.

- [ ] **Step 5: Review boundary**

Stop for review. Do not `git add` or commit. The logical boundary is the cron table and the two assertion edits, recorded as `feat: schedule the crawl gateway analysis crons`. That command is not executed before Implementation Analyst approval, and it is not a separate commit after approval.

### Task 4: Full offline verification

**Files:**
- Test: the existing suite. No new product file.

**Interfaces:**
- Consumes: Tasks 1 through 3.
- Produces: no new runtime behavior.

- [ ] **Step 1: Run the full offline suite**

```bash
node scripts/run-tests.cjs
npm run typecheck
git diff --check
```

Expected: both commands exit 0. `git diff --check` prints nothing. `scripts/run-tests.cjs` deletes `.test-build`. Confirm that directory is absent. The suite stays offline.

- [ ] **Step 2: Check the diff scope**

The uncommitted implementation diff may contain only:

- `src/crawl-gateway/worker.ts`
- `wrangler.toml`
- `tests/unit/crawl-gateway-scheduled.test.ts`
- `tests/unit/crawl-workflow.test.ts`

Search that diff for `migrations/0005`, `SCHEDULED_ANALYSIS_MAX_ITEMS`, `waitUntil`, `DurableObject`, `loadConfig`, `DQ-039`, `queues`, and a new `/internal/` path. None of those belong in this slice. `fetch` still has two parameters. The pipeline and daily-usage files are absent from the diff.

- [ ] **Step 3: Review boundary**

Do not `git add`, commit, push, deploy, or enable Cron during Builder. There is no implementation commit in this task. After the Implementation Analyst records APPROVED, the Builder makes one implementation commit containing only the four files above. This plan does not authorize the later push or pull request.

## Spec coverage

- Both UTC crons and the Wrangler `[triggers]` table are Task 3.
- `Europe/Warsaw`, summer, winter, both DST days, and the day before each 2026 change are Task 1.
- `controller.scheduledTime`, delayed execution, and the ignored cron string are Task 2.
- The inactive return before config, D1, and the pipeline is Task 2.
- Literal `maxItems` 50, the same `env.DB`, the parsed fixture limit, and no pipeline clock override are Task 2.
- Invalid active configuration and non-finite or invalid `scheduledTime` are Task 2.
- The safe pipeline catch, the single safe log, and `console.log` capture are Task 2.
- `scheduled` beside unchanged `fetch`, with no `waitUntil`, is Task 2.
- Overlap without a new lock is Task 2.
- Crawl and manual analysis regressions, including `worker.fetch.length === 2`, are Tasks 2 and 3.
- No migration, no second quota, and no DQ-039 history are constraints, not tasks.
- Production activation is the checklist below. It is not a task.

## Post-Merge Production Activation Checklist

**DO NOT EXECUTE DURING BUILDER.**

This checklist is not a task. Do not deploy while planning or implementing. Do not run `wrangler deploy` or `wrangler triggers deploy` in the implementation pull request. Merging the `[triggers]` block does not activate Cron. There is no test-only production endpoint, and `wrangler dev --test-scheduled` is not production proof.

Activation starts only after implementation review, human integration approval, commit, push, pull request, green CI, human merge approval, and a normal merge commit. It then requires a separate human approval.

1. Deploy the merged Worker with `npx wrangler deploy --keep-vars`. `--keep-vars` is required on Wrangler 4.152.0 so the plain var `GEMINI_DAILY_REQUEST_LIMIT` survives. Do not put that value in `wrangler.toml`. Do not pass a new `--var`. Do not run `wrangler secret put`.
2. Preserve `GEMINI_DAILY_REQUEST_LIMIT=10` and the existing secrets `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, and `CRAWL_GATEWAY_TOKEN`. Confirm those names only. Do not print their values.
3. Confirm the deployed Worker has both `"0 13 * * *"` and `"0 14 * * *"`. A deploy that includes `triggers.crons` replaces previously deployed crons. Do not deploy an empty cron list.
4. Immediate checks, with no real Gemini analysis: authenticated `POST /internal/analysis/run` with `{"maxItems":0}` returns HTTP 200 and does not spend quota; the analysis route without a token returns 401; a crawl route without a token returns 401.
5. Do not run a manual `maxItems` greater than 0 just to activate.
6. Full proof waits for one natural 15:00 Europe/Warsaw cycle. The active UTC opportunity ran analysis. The paired opportunity was a no-op. Cron did not run analysis twice. DQ-037 admission and request accounting match that single pipeline call. If that natural cycle shows this, no second real analysis is required.
