# DQ-038 Scheduled Production Analysis Runner

## Status

```text
design, not implemented, not production-activated
```

This document is the implementation contract. It is not an implementation plan. It does not authorize a deploy, a Cron Trigger activation, a Gemini request, or DQ-039.

## Intent

Delta Qoralis is the company. Analyzing and Mailing Agent is the agent. This design does not rename the agent to the company, and it does not rename the Worker `delta-qoralis-crawl-gateway`.

DQ-038 runs the existing production analysis pipeline once each calendar day at 15:00 Europe/Warsaw. Cloudflare Cron Triggers on that same Worker are the scheduler. The scheduled handler calls `runD1WebsiteAnalysisPipeline` directly. It does not fetch the manual analysis route, and it does not add a second quota system.

## Current state

DQ-030 through DQ-037 are completed. DQ-036 and DQ-037 are production-verified. DQ-038 and DQ-039 are planned. This design covers DQ-038 only.

The production Worker is `delta-qoralis-crawl-gateway`, entry `src/crawl-gateway/worker.ts`. `wrangler.toml` sets `compatibility_date = "2026-10-22"`, `compatibility_flags = ["nodejs_compat"]`, and one D1 binding `DB` for database `delta-qoralis-crawl`, ID `59efef60-8acd-4277-b808-8220de5521eb`. The file has no `[triggers]`, no secrets, and no `GEMINI_DAILY_REQUEST_LIMIT`. Wrangler 4.152.0 is the operator CLI available on this machine. `package.json` does not depend on Wrangler and has no deploy script. The crawl schedule in `.github/workflows/crawl.yml` is a separate GitHub Actions cron and is not an analysis scheduler.

`handleCrawlGatewayRequest` serves `POST /internal/crawl/select`, `POST /internal/crawl/evidence`, and `POST /internal/analysis/run`. Crawl routes use `CRAWL_GATEWAY_TOKEN`. The analysis route uses `ANALYSIS_GATEWAY_TOKEN` and a body of exactly `{ maxItems }` for an integer 0 through 50. `geminiConfigFromEnv` is private to the Worker. It accepts `GEMINI_API_KEY` only when the value is a non-empty string with no whitespace or control characters, and `GEMINI_DAILY_REQUEST_LIMIT` only when it is a canonical integer from 1 through 10000. The Worker does not call `loadConfig()`. The default export is `{ fetch }`. `fetch` has arity 2 and calls `handleCrawlGatewayRequest` with no pipeline override. `tests/unit/crawl-gateway-analysis.test.ts` asserts `worker.fetch.length === 2`.

`runD1WebsiteAnalysisPipeline(database, config, maxItems, options?)` is the DQ-037 boundary. `maxItems` 50 is already valid. The pipeline owns selection, batches of at most 5, the 50-website UTC-day cap, request reservation, model fallback, the single deferred transport retry, persistence, and the returned counters plus `budget`. Production `GEMINI_DAILY_REQUEST_LIMIT` is 10. That value is a non-secret Worker var set outside `wrangler.toml`. A deploy that omits `--keep-vars` deletes plain vars that are not in the file. Secrets are not deleted by deploy. This design does not change that variable strategy.

The default export has no `scheduled` handler. Nothing in the repository invokes analysis on a clock.

## Goals

- Run analysis once per calendar day at 15:00 Europe/Warsaw, including across CET and CEST.
- Use two Cloudflare UTC Cron Triggers on the existing Worker, and decide from the event's `scheduledTime`.
- Leave an off-time event as a true no-op before configuration, D1, and the pipeline.
- On the active event, call the existing pipeline once with fixed `maxItems` 50.
- Keep the manual HTTP route, crawl routes, and DQ-037 quota behavior unchanged.
- Make the timezone guard, the scheduled boundary, and HTTP `fetch` independently testable.
- Keep production activation behind a later human approval. This design does not perform it.

## Non-goals

- DQ-039 run history, failure history, request history, or token, cost, or latency tables.
- A new D1 migration, quota table, lock, lease, claim, queue, mutex, or scheduler singleton.
- Another AI provider, a second Worker, GitHub Actions analysis, or Cloudflare Workflows.
- A new HTTP analysis route, a scheduler bearer token, or an HTTP hop into `POST /internal/analysis/run`.
- Qualification, contact discovery, DNC changes, outreach, or mailing.
- Changing `GEMINI_DAILY_REQUEST_LIMIT`, batch size, fallback, retry, admission identity, or eligibility.
- Activating Cron, deploying, or sending a real Gemini request.

No migration is required. The schedule decision is a pure function of `scheduledTime`. Overlap with a manual run is already enforced by the DQ-037 admission primary key and request reservation. A delayed event does not need a new row to remember that it was scheduled.

## Approved architecture

```text
Cloudflare Cron "0 13 * * *" or "0 14 * * *"
  → Worker scheduled(controller, env, ctx)
  → handleScheduledAnalysis(controller, env)
  → Warsaw guard on controller.scheduledTime
       off-time: return
       15:00: geminiConfigFromEnv
            invalid: fail the invocation
            valid: runD1WebsiteAnalysisPipeline(env.DB, config, 50)
```

The manual path stays separate:

```text
POST /internal/analysis/run
  → ANALYSIS_GATEWAY_TOKEN
  → handleCrawlGatewayRequest
  → existing maxItems body
  → runD1WebsiteAnalysisPipeline
```

Cron does not call `fetch`. `fetch` does not call the scheduled handler.

## Schedule and timezone

Cloudflare Cron is UTC. Wrangler 4.152.0 configuration, matching the current Wrangler triggers documentation, is a five-field cron list:

```toml
[triggers]
crons = ["0 13 * * *", "0 14 * * *"]
```

Those two expressions are the whole schedule. `"0 13 * * *"` is 13:00 UTC every day. `"0 14 * * *"` is 14:00 UTC every day. Exactly one of those instants is 15:00 Europe/Warsaw on every calendar day:

- Summer, CEST, UTC+2: 13:00 UTC is 15:00 Warsaw and runs. 14:00 UTC is 16:00 Warsaw and is a no-op.
- Winter, CET, UTC+1: 13:00 UTC is 14:00 Warsaw and is a no-op. 14:00 UTC is 15:00 Warsaw and runs.

Europe/Warsaw changes offset on the last Sunday of March and the last Sunday of October at 01:00 UTC. That fold and gap are around 02:00 local, not around 15:00, so 15:00 exists once on a transition day. The implementation must not list DST dates, offsets, or a cron-to-season map. `Intl` with `timeZone: "Europe/Warsaw"` is the time source for the local clock.

The guard reads `controller.scheduledTime`. Cloudflare defines that value as milliseconds since 1970-01-01 UTC for when the event was scheduled, parsed as `new Date(controller.scheduledTime)`. It is not `Date.now()` and not `new Date()` at handler execution. A late isolate must not turn 15:00 into a no-op, and must not turn the paired hour into a run.

`controller.cron` is not the decision. A winter `scheduledTime` paired with `"0 13 * * *"` is still a no-op. A summer `scheduledTime` paired with `"0 14 * * *"` is still a no-op.

Local comparison is `HH:mm` equal to `15:00`. Format the scheduled instant with `hourCycle: "h23"` so the hour is `00` through `23`. Hour `15` and minute `00` run. Every other local time is a no-op. Do not compare the runtime's local `getHours()`.

Checked with the platform timezone data, not as constants for production code:

- `2026-07-15T13:00:00.000Z` is 15:00 CEST and runs. `2026-07-15T14:00:00.000Z` is 16:00 CEST and does not.
- `2026-01-15T13:00:00.000Z` is 14:00 CET and does not. `2026-01-15T14:00:00.000Z` is 15:00 CET and runs.
- `2026-03-28T14:00:00.000Z`, the day before the spring change, is 15:00 CET and runs. `2026-03-29T13:00:00.000Z`, after the change, is 15:00 CEST and runs.
- `2026-10-24T13:00:00.000Z`, the day before the autumn change, is 15:00 CEST and runs. `2026-10-25T14:00:00.000Z`, after the change, is 15:00 CET and runs.

A `scheduledTime` that is not a finite number fails the invocation. It is not a no-op and it is not a run. `handleScheduledAnalysis` checks that before the Warsaw comparison. `isWarsawDailyAnalysisTime` returns false for a non-finite input, and that false result must not be used to skip the failure.

## Scheduled handler

Add two exports beside the existing HTTP handler in `src/crawl-gateway/worker.ts`:

- `isWarsawDailyAnalysisTime(scheduledTime: number): boolean`
- `handleScheduledAnalysis(controller, env, dependencies?): Promise<void>`

`controller` needs only `scheduledTime: number`. `dependencies` is the existing `CrawlGatewayDependencies` seam, `{ runPipeline?: typeof runD1WebsiteAnalysisPipeline }`. Production does not pass a substitute.

The default export gains `scheduled` and keeps `fetch` as a two-argument function:

```text
fetch(request, env) → handleCrawlGatewayRequest(request, env)
scheduled(controller, env, ctx) → handleScheduledAnalysis(controller, env)
```

`scheduled` awaits that call. It does not use `ctx.waitUntil` for the pipeline. Returning before the pipeline finishes would let Cloudflare record success while analysis is still running. A rejection fails the scheduled invocation.

`handleScheduledAnalysis` does these steps in order:

1. If `scheduledTime` is not a finite number, throw `Error("Scheduled analysis failed.")`. Do not read Gemini configuration, D1, or the pipeline.
2. If `isWarsawDailyAnalysisTime(scheduledTime)` is false, return the no-op.
3. Otherwise run the active event.

`SCHEDULED_ANALYSIS_MAX_ITEMS` is the literal `50` in the Worker module. It is not an environment variable and it is not read from the cron payload.

## Off-time no-op

If the guard is false, `handleScheduledAnalysis` returns without doing anything else. That return happens before `geminiConfigFromEnv`, before any read of `GEMINI_API_KEY` or `GEMINI_DAILY_REQUEST_LIMIT`, before `env.DB` is prepared or batched, before candidate selection, before admission, before request reservation, before Gemini, and before persistence. It does not call `runD1WebsiteAnalysisPipeline`. It writes no admission and consumes no request unit. It logs nothing. It does not throw.

Missing or invalid Gemini configuration on an off-time event is irrelevant. The no-op must still succeed when those values are absent, so a test can prove the config was not required.

## Active event

When the guard is true:

1. Resolve Gemini configuration with the existing `geminiConfigFromEnv`. Do not add a second parser and do not call `loadConfig()`.
2. If that returns `undefined`, throw `Error("Scheduled analysis configuration is invalid.")`. Do not call the pipeline and do not touch D1. The message contains no key, limit, SQL, or response body.
3. Call `runPipeline(env.DB, config, 50)` with no pipeline options. The production binding is `env.DB`. The substitute, when a test supplies `dependencies.runPipeline`, receives that same database, the frozen config, and `50`.
4. On fulfillment, emit one log and return.
5. On rejection, do not log the caught error. Throw `Error("Scheduled analysis failed.")`. That message is generic. It does not copy the pipeline message, a provider body, SQL, or a secret.

The pipeline's own UTC clock, retry sleep, and `storedAt` stay as DQ-037 implemented them. The scheduled guard does not pass `scheduledTime` into `options.now`. A late run still runs because of `scheduledTime`, and the admission date remains the UTC date the pipeline already uses at execution. That is not a second quota and it does not need a migration.

`maxItems` 50 asks the pipeline for a full invocation. DQ-037 may still stop at `request_cap`, `website_cap`, or `no_evidence`. With production limit 10, request accounting can stop the run before 50 websites. The scheduler does not reimplement that stop.

## Logging

A successful active invocation writes one `console.log` of `JSON.stringify` of one object, and nothing else. Copy the fields. Do not log the pipeline result object by reference. Do not add a logger.

```text
selected
succeeded
failed
retried
persisted
utcDate
websitesAdmitted
websiteLimit
geminiRequestsUsed
geminiRequestLimit
stoppedReason
```

Do not log `GEMINI_API_KEY`, gateway tokens, cron secrets, HTML, prompts, page text, summaries, or findings. Do not log `controller.cron`. A no-op logs nothing. A failure logs nothing beyond the fixed rejection message Cloudflare records for the failed invocation.

There is no run table and no failure table. Those belong to DQ-039.

## Concurrency

A manual `POST /internal/analysis/run` and the daily scheduled call may overlap. DQ-038 adds no lock, lease, claim, queue, or mutex.

DQ-037 already treats `(utc_date, evidence_id)` as the admission identity and reserves the first request unit of a batch before Gemini. The loser of a duplicate admission recomposes once and, when a request unit remains, continues without a second website slot. Both invocations can still spend distinct request units. That limitation stays. DQ-038 does not solve it again.

## HTTP compatibility

`POST /internal/analysis/run` keeps `ANALYSIS_GATEWAY_TOKEN`, the `{ maxItems }` body, and the current status codes. Crawl routes and `CRAWL_GATEWAY_TOKEN` stay as they are. Neither token authorizes the other. Cron has no bearer token.

`worker.fetch.length` stays 2. The scheduled path is a different method. Existing crawl and analysis tests keep their assertions.

## Tests

Add unit coverage with `node:test`. The pipeline is a substitute. No real Gemini, no production D1, and no outbound network.

- Summer: `2026-07-15T13:00:00.000Z` runs. `2026-07-15T14:00:00.000Z` does not.
- Winter: `2026-01-15T13:00:00.000Z` does not. `2026-01-15T14:00:00.000Z` runs.
- DST boundary: `2026-03-28T14:00:00.000Z` runs and `2026-03-29T13:00:00.000Z` runs. `2026-10-24T13:00:00.000Z` runs and `2026-10-25T14:00:00.000Z` runs. The opposite UTC hour on each of those days does not. Expectations come from Europe/Warsaw, not from a fixed `+1` or `+2` in production code.
- Delay: a 15:00 Warsaw `scheduledTime` still runs when `Date.now()` is a different hour. The guard's only time input is the number.
- Cron string: `"0 13 * * *"` with a winter `scheduledTime` is a no-op. `"0 14 * * *"` with a summer `scheduledTime` is a no-op.
- No-op: the pipeline substitute is called 0 times. Database `prepare` and `batch` throw if touched. Gemini configuration is absent. The call fulfills and logs nothing.
- Active: the substitute is called once with `env.DB`, the frozen Gemini config, and `50`, and with no pipeline options. The log contains only the ten fields above.
- Invalid active configuration: a missing or invalid key, or a missing or invalid limit, rejects with `Scheduled analysis configuration is invalid.` The pipeline is called 0 times and D1 is not touched.
- Non-finite `scheduledTime`: the invocation rejects with `Scheduled analysis failed.` and the pipeline is called 0 times.
- Pipeline failure: a rejecting substitute rejects `handleScheduledAnalysis` with `Scheduled analysis failed.` The rejection text does not include the substitute's message. The call is not reported as success.
- Default `scheduled` on an off-time event fulfills without a pipeline override and without config.
- Manual analysis and crawl tests stay behaviorally unchanged, including `worker.fetch.length === 2`.

## Production activation

Activation is a later human-approved stage. The implementation pull request may add the `[triggers]` block to `wrangler.toml`. Merging that file does not deploy it. The implementation must not run `wrangler deploy` or `wrangler triggers deploy`.

Wrangler replaces previously deployed crons when a deploy includes `triggers.crons`. Leaving `crons` unset would leave an already deployed schedule in place. An empty list would remove crons. Neither is this design. The later activation deploy is:

```text
npx wrangler deploy --keep-vars
```

`--keep-vars` is required so the existing plain var `GEMINI_DAILY_REQUEST_LIMIT` survives. Do not put that value in `wrangler.toml`. Do not pass a new `--var`. Do not run `wrangler secret put`. `ANALYSIS_GATEWAY_TOKEN`, `GEMINI_API_KEY`, and `CRAWL_GATEWAY_TOKEN` stay as they are.

Immediate checks after that deploy, with no Gemini analysis:

- The Worker is deployed.
- Both cron expressions are configured.
- Authenticated `POST /internal/analysis/run` with `{"maxItems":0}` still returns HTTP 200 and does not spend quota.
- The analysis route without a token returns 401.
- A crawl route without a token returns 401.
- The existing vars and secrets are still present, by name only.

There is no production test route that simulates Cron. `wrangler dev --test-scheduled` is a local development aid, not a production proof.

Full proof waits for one natural 15:00 Europe/Warsaw occurrence. One of the two UTC triggers runs the pipeline. The paired trigger is a no-op. Cron therefore executes the pipeline at most once for that local day. DQ-037 counters move only as that one pipeline call accounts for them. If that natural run already shows this, no second real analysis is required.

## Alternatives

Chosen: two Cloudflare UTC Cron Triggers plus a Europe/Warsaw guard on `scheduledTime`. The local time stays 15:00 all year, DST follows the timezone database, the Worker and D1 binding stay the ones already in production, and there is no GitHub runner, HTTP hop, or scheduler token.

Rejected: one fixed UTC cron. 15:00 Warsaw is 13:00 UTC in summer and 14:00 UTC in winter. One expression is wrong for half the year.

Rejected: a GitHub Actions analysis schedule. The crawl workflow already uses GitHub cron, but analysis would then need a scheduler credential and an HTTP call into the Worker. The pipeline already runs inside the Worker.

Rejected: Cloudflare Workflows. One bounded daily pipeline does not need workflow steps, instance ids, or a second schedule binding.

## Scope exclusions

Do not edit the DQ-037 design or implementation except for the scheduled entry, the guard, the shared config call, the Wrangler cron list, and tests of those additions. Do not edit `.github/workflows/crawl.yml`. Do not add a migration. Do not start DQ-039.
