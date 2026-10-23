# DQ-033 Bounded Website Analysis Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved bounded sequential multi-website analysis run over already-created `WebsiteFacts`, including isolated known failures and one deferred transport-only retry after 90 seconds.

**Architecture:** DQ-033 is one small two-pass sequential orchestrator around the existing DQ-032 `analyzeWebsiteWithGemini` operation. The first pass records successes and known terminal failures while deferring only `GEMINI_TRANSPORT_UNAVAILABLE`; after the first pass, deferred items retry once when their individual 90-second deadline is reached. No storage, scheduling, concurrency, provider abstraction, or persistence is added.

**Tech Stack:** TypeScript, existing Node test stack, existing DQ-030/DQ-031/DQ-032 website-analysis modules.

**Spec:** `docs/superpowers/specs/2026-10-23-dq-033-bounded-website-analysis-run-design.md`

## Global Constraints

Every task includes this section.

- Implement only the approved spec and this plan. Do not edit the spec or this plan. Do not start DQ-034.
- Builder execution creates `feature/dq-033-bounded-website-analysis-run` from the approved plan commit on `design/dq-033-bounded-website-analysis-run`. Do not implement on `main` or on the design branch.
- Workflow: Architect, approved implementation plan, Builder implements all DQ-033 tasks, Builder runs full verification, Builder leaves all implementation changes uncommitted, Analyst reviews the actual local diff, human approval, then commit, push, pull request, and CI, then a normal merge commit. Tasks do not end with `git commit`. The Builder does not commit, push, open a pull request, or merge. Do not squash or rebase.
- One public operation: `runWebsiteAnalysis(facts: readonly WebsiteFacts[], config: GeminiWebsiteAnalysisConfig, options?: WebsiteAnalysisRunOptions): Promise<readonly WebsiteAnalysisRunItem[]>`. It calls `analyzeWebsiteWithGemini`. Do not add `runProviderAnalysis`, `AnalysisProvider`, `AnalysisRunner`, or `RetryPolicy`.
- `GeminiWebsiteAnalysisConfig` already exists in `src/config/env.ts` as `Readonly<{ provider: "gemini"; apiKey: string }>`. `GeminiWebsiteAnalysisResult` already exists in `src/website-analysis/providers/gemini/gemini-provider.ts`. Use those names. Do not invent a second config or result type.
- 0–50 `WebsiteFacts` per run. `evidenceId` must be unique within the run. More than 50 inputs rejects the whole run. A duplicate `evidenceId` rejects the whole run. Do not silently truncate. Do not deeply revalidate `WebsiteFacts`.
- 50/run is not 50/day. DQ-033 has no persisted daily accounting. A retry of the same `WebsiteFacts` is not a new input item and must not be counted against the 50 limit.
- Strict sequential execution. Concurrency is 1. No `Promise.all`, worker pool, semaphore, configurable concurrency, or queue.
- Only `GeminiWebsiteAnalysisError` with code `GEMINI_TRANSPORT_UNAVAILABLE` is retryable, and only after the first pass, and only for that item's first DQ-032 call.
- Retry deadline is that item's first transport-failure time plus `90_000` ms. `failureTime` is the `now()` value observed when that first-pass call fails. `retryAt = failureTime + 90_000`.
- Deferred retries start only after the full first pass. Process them in original input order. Compute `remaining = retryAt - now()` when that deferred item is reached, after any earlier deferred item has finished its retry. Do not precompute every sleep at the end of the first pass. Do not sort by `retryAt`.
- One second DQ-032 call maximum. No third attempt. The second call is one normal `analyzeWebsiteWithGemini` invocation and may try all four Gemini models inside DQ-032. DQ-033 does not inspect `attemptedModels`, model attempts, HTTP bodies, fetch errors, or Gemini response internals.
- `GEMINI_HTTP_ERROR`, `GEMINI_INVALID_RESPONSE`, any other `GeminiWebsiteAnalysisError` code, and `WebsiteAnalysisError` are terminal for that attempt. Known errors are isolated. The failed item stores the thrown known error object. Do not wrap it.
- An unexpected thrown value, including a generic `Error` or a plain object, propagates and fails the run. Do not convert it into a failed website result.
- Original result order is preserved. Freeze each result item and the returned array. Do not freeze the caller's input array or `WebsiteFacts` objects.
- No summary object, run id, timestamps, token usage, cost, latency, provider aggregation, database ids, or retry-count integer on the result. `retried: boolean` is sufficient.
- No D1. No SQLite. No persistence. No schema or migration. No scheduler. No queue. No generic retry framework. No additional provider. No new dependency. Do not modify `package.json` or `package-lock.json`.
- The retry delay is not configurable. Production delay is exactly `90_000`. `analyze`, `now`, and `sleep` are the only seams. They are not a container, clock framework, or scheduler.
- Tests use `node:test` and `node:assert/strict`. No real Gemini request, network, 90-second wait, D1, or SQLite. No fake-timer library and no source-text grep. Every test passes `analyze`. Do not omit `analyze` in a test that would reach the real adapter.
- The Builder does not edit `docs/PLAN.md` or `docs/BACKLOG.md`. Those docs already describe DQ-033 as the current planned, unintegrated slice. Do not mark DQ-033 Completed. Do not make DQ-034 the next step. After Analyst approval and human approval, the later integration step may set DQ-033 to Completed, DQ-034–039 to Planned, and the next step to DQ-034. That later text must keep these facts: 50/run is not 50/day, DQ-033 does not select from D1, and DQ-033 does not persist analysis.

## Review Focus

These five cases are the ones a happy-path assertion would miss. Each one has the named test in the owning task.

1. **Failure isolation.** One HTTP or validation failure must not prevent the next website from being analyzed. Test: `a known HTTP failure does not stop the next website` in Task 2. `a WebsiteAnalysisError is terminal` in Task 2 covers the validation failure the same way.
2. **Deferred timing.** A retry must not happen until that specific item's first transport failure is at least 90 seconds old. Test: `retry waits until that item's transport failure is 90 seconds old` in Task 3.
3. **Sequential first pass.** A deferred retry must never jump ahead of unprocessed first-pass items. Test: `a deferred retry does not run before the rest of the first pass` in Task 3.
4. **Retry ceiling.** A second transport-unavailable outcome must be terminal, not scheduled again. Test: `a second transport-unavailable result is terminal` in Task 3.
5. **Unexpected exceptions.** Arbitrary programmer or system exceptions must escape instead of becoming normal failed results. Tests: `an unexpected first-pass error escapes` in Task 2, and `an unexpected retry error escapes` in Task 3.

## File structure

Create:

- `src/website-analysis/run.ts` — the run error, the batch check, the two-pass loop, and the private success and failure item builders.
- `tests/unit/website-analysis-run.test.ts` — deterministic run behavior through `analyze`, `now`, and `sleep`.

Modify:

- `src/website-analysis/index.ts` — re-export the run function, error, code array, and run types.

Do not modify `docs/PLAN.md` or `docs/BACKLOG.md` in the Builder diff. They stay the description of the planned, unintegrated DQ-033 slice.

Do not create another production file. Do not add a repository, service, factory, provider registry, retry utility, scheduler, clock class, queue class, configuration file, persistence file, or migration. `runWebsiteAnalysis` does not already exist. Keep that name.

`WebsiteAnalysisRunError` lives in `src/website-analysis/run.ts`. The existing website-analysis errors are one frozen code array, one fixed message, `readonly name`, `constructor(readonly code)`, and no `cause`. Match that. Do not put this error in `src/crawler/run-loop.ts` or `src/config/errors.ts`.

## Public contract

```ts
export const WEBSITE_ANALYSIS_RUN_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
] as const);

export type WebsiteAnalysisRunErrorCode =
  (typeof WEBSITE_ANALYSIS_RUN_ERROR_CODES)[number];

export type WebsiteAnalysisRunItem =
  | Readonly<{
      status: "succeeded";
      facts: WebsiteFacts;
      result: GeminiWebsiteAnalysisResult;
      retried: boolean;
    }>
  | Readonly<{
      status: "failed";
      facts: WebsiteFacts;
      error: Error;
      retried: boolean;
    }>;

export type WebsiteAnalysisRunOptions = Readonly<{
  analyze?: typeof analyzeWebsiteWithGemini;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;

export function runWebsiteAnalysis(
  facts: readonly WebsiteFacts[],
  config: GeminiWebsiteAnalysisConfig,
  options?: WebsiteAnalysisRunOptions,
): Promise<readonly WebsiteAnalysisRunItem[]>;
```

`src/website-analysis/index.ts` adds:

```ts
export {
  WEBSITE_ANALYSIS_RUN_ERROR_CODES,
  WebsiteAnalysisRunError,
  runWebsiteAnalysis,
} from "./run";
export type {
  WebsiteAnalysisRunErrorCode,
  WebsiteAnalysisRunItem,
  WebsiteAnalysisRunOptions,
} from "./run";
```

Leave the existing facts, DQ-031, and Gemini exports in that file unchanged. `run.ts` imports `analyzeWebsiteWithGemini`, `GeminiWebsiteAnalysisError`, and the `GeminiWebsiteAnalysisResult` type from `./providers/gemini`. It imports `WebsiteAnalysisError` from `./analysis-errors`, `WebsiteFacts` from `./facts`, and `GeminiWebsiteAnalysisConfig` from `../config/env`. It must not import `./index`, because that barrel re-exports `run.ts`.

The fixed message is `Website analysis run request is invalid.` Both more than 50 inputs and a duplicate `evidenceId` use `new WebsiteAnalysisRunError("INVALID_REQUEST")`. The message does not include the input length, any evidenceId, `WebsiteFacts`, `visibleText`, Gemini configuration, or an API key.

## Locked algorithms

Task 1 owns validation and the success-only loop. Task 2 owns known-error isolation. Task 3 owns deferral and the second pass. Do not implement a later task's branch early. That would make the next task's new tests pass before their implementation step.

### Input validation

Run this before any `analyze`, `now`, or `sleep` call. Length uses the input array length. Uniqueness uses `Set<number>`, which treats two `evidenceId` values as duplicates under SameValueZero. Do not compare `leadId`. Do not coerce ids. The 50 check runs once, on the input, and is not repeated before a retry.

```ts
const MAX_WEBSITE_FACTS_PER_RUN = 50;

function assertValidRun(facts: readonly WebsiteFacts[]): void {
  if (facts.length > MAX_WEBSITE_FACTS_PER_RUN) {
    throw new WebsiteAnalysisRunError("INVALID_REQUEST");
  }
  const seen = new Set<number>();
  for (const item of facts) {
    if (seen.has(item.evidenceId)) {
      throw new WebsiteAnalysisRunError("INVALID_REQUEST");
    }
    seen.add(item.evidenceId);
  }
}
```

An empty array passes this check. The function then returns `Object.freeze([])`, a new array, and does not call the seams.

### Known-error recognition

Recognize only these two classes. A matching `name` or `code` on any other object is not enough.

```ts
function isKnownAnalyzerError(
  error: unknown,
): error is GeminiWebsiteAnalysisError | WebsiteAnalysisError {
  return error instanceof GeminiWebsiteAnalysisError || error instanceof WebsiteAnalysisError;
}
```

On the first pass, `GeminiWebsiteAnalysisError` whose `code` is exactly `"GEMINI_TRANSPORT_UNAVAILABLE"` is deferred. Every other known analyzer error is a terminal failure for that attempt, including `GEMINI_HTTP_ERROR`, `GEMINI_INVALID_RESPONSE`, and any current or future `GeminiWebsiteAnalysisError` code. On the second pass, transport-unavailable is terminal too. Anything that fails `isKnownAnalyzerError` is rethrown.

### Two-pass run

Call `now()` only to record `failureTime` after a first-pass transport failure, and once per deferred item when computing `remaining`. Call `sleep` only when `remaining > 0`, once, with that remaining value. Call `analyze(websiteFacts, config)` with two arguments. Do not pass Gemini options, `fetch`, or the run options into DQ-032.

```ts
const analyze = options?.analyze ?? analyzeWebsiteWithGemini;
const now = options?.now ?? Date.now;
const sleep = options?.sleep ?? delay;
const results: Array<WebsiteAnalysisRunItem | undefined> = new Array(facts.length);
const deferredItems: Array<{ index: number; facts: WebsiteFacts; retryAt: number }> = [];

for (let index = 0; index < facts.length; index += 1) {
  const websiteFacts = facts[index];
  if (websiteFacts === undefined) {
    throw new Error("Website analysis run left an input without a terminal result.");
  }
  try {
    const result = await analyze(websiteFacts, config);
    results[index] = Object.freeze({
      status: "succeeded",
      facts: websiteFacts,
      result,
      retried: false,
    });
  } catch (error) {
    if (
      error instanceof GeminiWebsiteAnalysisError &&
      error.code === "GEMINI_TRANSPORT_UNAVAILABLE"
    ) {
      const failureTime = now();
      deferredItems.push({ index, facts: websiteFacts, retryAt: failureTime + 90_000 });
      continue;
    }
    if (isKnownAnalyzerError(error)) {
      results[index] = Object.freeze({
        status: "failed",
        facts: websiteFacts,
        error,
        retried: false,
      });
      continue;
    }
    throw error;
  }
}

for (const deferred of deferredItems) {
  const remaining = deferred.retryAt - now();
  if (remaining > 0) await sleep(remaining);
  try {
    const result = await analyze(deferred.facts, config);
    results[deferred.index] = Object.freeze({
      status: "succeeded",
      facts: deferred.facts,
      result,
      retried: true,
    });
  } catch (error) {
    if (isKnownAnalyzerError(error)) {
      results[deferred.index] = Object.freeze({
        status: "failed",
        facts: deferred.facts,
        error,
        retried: true,
      });
      continue;
    }
    throw error;
  }
}

return Object.freeze(results.map((item) => {
  if (item === undefined) {
    throw new Error("Website analysis run left an input without a terminal result.");
  }
  return item;
}));
```

`delay` is a private function in `run.ts`, not an export:

```ts
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
```

The final `undefined` check is a programming-bug escape hatch so the return type does not need a cast. It is not a second `WebsiteAnalysisRunError` code. Tests do not aim at it.

Task 1 implements validation, the empty return, and the success assignment only. It does not catch analyzer errors. Task 2 adds the known-error terminal branch and still lets transport-unavailable fall into that terminal branch. Task 3 adds the transport `if` and the deferred loop. The second-pass catch has no transport special case.

### Test commands

Targeted command, from the repository root. This repo's shell is zsh, where `status` is read-only, so the command uses `exit_code`. `.test-build/` is gitignored. `npm test` is `node scripts/run-tests.cjs`. `npm run typecheck` is `tsc --noEmit`.

```bash
npx tsc --noEmit false --outDir .test-build
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
  node --test .test-build/tests/unit/website-analysis-run.test.js
  exit_code=$?
fi
rm -rf .test-build
exit "$exit_code"
```

### Shared test helpers

Task 1 creates these helpers in `tests/unit/website-analysis-run.test.ts`. Later tasks add tests to that same file and call these helpers. Imports are `node:assert/strict`, `node:test`, `GeminiWebsiteAnalysisConfig` from `../../src/config/env`, and the run symbols plus `GeminiWebsiteAnalysisError` and `WebsiteAnalysisError` from `../../src/website-analysis`.

```ts
const API_KEY = "synthetic-gemini-key";

function factsAt(evidenceId: number, visibleText = "Visible page text"): WebsiteFacts {
  return {
    evidenceId,
    leadId: `lead-${evidenceId}`,
    leadVersion: 1,
    requestedUrl: "https://example.test/start",
    finalUrl: "https://example.test/final",
    title: "Example",
    metaDescription: null,
    documentLanguage: null,
    hasViewport: false,
    h1Count: 0,
    headingCount: 0,
    imageCount: 0,
    imagesWithoutAlt: 0,
    formCount: 0,
    internalLinkCount: 0,
    externalLinkCount: 0,
    visibleText,
  };
}

function geminiConfig(): GeminiWebsiteAnalysisConfig {
  return { provider: "gemini", apiKey: API_KEY };
}

function succeededResult(facts: WebsiteFacts): GeminiWebsiteAnalysisResult {
  return Object.freeze({
    analysis: Object.freeze({
      evidenceId: facts.evidenceId,
      leadId: facts.leadId,
      leadVersion: facts.leadVersion,
      summary: "Observed.",
      findings: Object.freeze([]),
    }),
    provider: "gemini",
    model: "gemini-3.8-flash",
    attemptedModels: Object.freeze(["gemini-3.8-flash"]),
  });
}

function assertInvalidRequest(error: unknown, leaked: string): void {
  assert.ok(error instanceof WebsiteAnalysisRunError);
  assert.equal(error.name, "WebsiteAnalysisRunError");
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.message, "Website analysis run request is invalid.");
  assert.equal("cause" in error, false);
  assert.equal(error.message.includes(leaked), false);
  assert.equal(error.message.includes(API_KEY), false);
  assert.equal(error.message.includes("51"), false);
}
```

Event strings are `analyze:${evidenceId}:first`, `analyze:${evidenceId}:retry`, and `sleep:${milliseconds}`. A test-local `analyze` appends `:first` the first time it sees that `evidenceId` and `:retry` after that. It records the event before returning or throwing.

## Task 1: Run contract and input validation

**Files:**
- Create: `src/website-analysis/run.ts`
- Create: `tests/unit/website-analysis-run.test.ts`
- Modify: `src/website-analysis/index.ts`

**Interfaces:**
- Consumes: `WebsiteFacts` from `src/website-analysis/facts.ts`; `GeminiWebsiteAnalysisConfig` from `src/config/env.ts`; `analyzeWebsiteWithGemini` and `GeminiWebsiteAnalysisResult` from `src/website-analysis/providers/gemini/gemini-provider.ts`.
- Produces: `runWebsiteAnalysis`, `WebsiteAnalysisRunError`, `WEBSITE_ANALYSIS_RUN_ERROR_CODES`, `WebsiteAnalysisRunErrorCode`, `WebsiteAnalysisRunItem`, and `WebsiteAnalysisRunOptions`, re-exported from `src/website-analysis/index.ts`.

- [ ] **Step 1: Write the failing tests**

Add the shared helpers and these tests in one file. The 50-item test supplies one config object plus `analyze`, `now`, and `sleep`. `now` and `sleep` push `"now"` and `"sleep"` so a pure success can prove it does not touch the clock.

```ts
test("publishes the fixed run error code and message", () => {
  assert.equal(Object.isFrozen(WEBSITE_ANALYSIS_RUN_ERROR_CODES), true);
  assert.deepEqual([...WEBSITE_ANALYSIS_RUN_ERROR_CODES], ["INVALID_REQUEST"]);
  const error = new WebsiteAnalysisRunError("INVALID_REQUEST");
  assert.equal(error.name, "WebsiteAnalysisRunError");
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.message, "Website analysis run request is invalid.");
  assert.equal("cause" in error, false);
});

test("returns a frozen empty array without calling analyze", async () => {
  const input: WebsiteFacts[] = [];
  let calls = 0;
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async () => {
      calls += 1;
      throw new Error("analyze was called");
    },
  });
  assert.equal(calls, 0);
  assert.notEqual(result, input);
  assert.equal(result.length, 0);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(input), false);
});

test("accepts two facts that share a leadId when evidenceIds differ", async () => {
  const input = [factsAt(1), { ...factsAt(2), leadId: "lead-1" }];
  const seen: number[] = [];
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async (websiteFacts) => {
      seen.push(websiteFacts.evidenceId);
      return succeededResult(websiteFacts);
    },
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(result.length, 2);
});

test("accepts 50 unique evidence ids in order", async () => {
  const input = Array.from({ length: 50 }, (_, index) => factsAt(index + 1));
  const config = geminiConfig();
  const seen: number[] = [];
  const clock: string[] = [];
  const result = await runWebsiteAnalysis(input, config, {
    analyze: async (websiteFacts, received, geminiOptions) => {
      assert.equal(received, config);
      assert.equal(geminiOptions, undefined);
      seen.push(websiteFacts.evidenceId);
      return succeededResult(websiteFacts);
    },
    now: () => {
      clock.push("now");
      return 0;
    },
    sleep: async () => {
      clock.push("sleep");
    },
  });
  assert.deepEqual(seen, input.map((item) => item.evidenceId));
  assert.deepEqual(clock, []);
  assert.equal(result.length, 50);
  assert.equal(Object.isFrozen(result), true);
  result.forEach((item, index) => {
    assert.equal(item.status, "succeeded");
    if (item.status !== "succeeded") return;
    assert.equal(item.retried, false);
    assert.equal(item.facts, input[index]);
    assert.deepEqual(Object.keys(item).sort(), ["facts", "result", "retried", "status"]);
    assert.equal(Object.isFrozen(item), true);
    assert.equal(Object.isFrozen(input[index] as WebsiteFacts), false);
  });
  assert.equal(Object.isFrozen(input), false);
});

test("rejects 51 inputs before analysis", async () => {
  const input = Array.from({ length: 51 }, (_, index) => factsAt(index + 1, "do-not-leak-visible-text"));
  let calls = 0;
  await assert.rejects(
    () => runWebsiteAnalysis(input, geminiConfig(), {
      analyze: async () => {
        calls += 1;
        return succeededResult(factsAt(1));
      },
    }),
    (error: unknown) => {
      assertInvalidRequest(error, "do-not-leak-visible-text");
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(input.length, 51);
});

test("rejects a duplicate evidenceId before analysis", async () => {
  const input = [factsAt(4, "do-not-leak-visible-text"), factsAt(5), factsAt(4)];
  let calls = 0;
  await assert.rejects(
    () => runWebsiteAnalysis(input, geminiConfig(), {
      analyze: async () => {
        calls += 1;
        return succeededResult(factsAt(4));
      },
    }),
    (error: unknown) => {
      assertInvalidRequest(error, "do-not-leak-visible-text");
      assert.equal(error instanceof WebsiteAnalysisRunError && error.message.includes("4"), false);
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(input.length, 3);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run the targeted command.

Expected: FAIL with exit code 2. TypeScript reports `TS2305` because `../../src/website-analysis` has no exported member `runWebsiteAnalysis`, `WebsiteAnalysisRunError`, or `WEBSITE_ANALYSIS_RUN_ERROR_CODES`. `node --test` does not run.

- [ ] **Step 3: Implement the minimum contract**

Add `WebsiteAnalysisRunError` in `src/website-analysis/run.ts` with the frozen one-code array, the fixed message, `readonly name = "WebsiteAnalysisRunError"`, `constructor(readonly code: WebsiteAnalysisRunErrorCode)`, and no `cause`.

Implement `assertValidRun` and `runWebsiteAnalysis`. After validation, an empty array returns `Object.freeze([])`. Otherwise assign each successful DQ-032 result at its input index with `retried: false`, then return the frozen array. Do not add `catch`. Do not defer. Do not call `now` or `sleep` on this path. Re-export the public names from `src/website-analysis/index.ts`.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run the same targeted command.

Expected: PASS. Exit code 0. Do not commit. Continue to Task 2.

## Task 2: Sequential first pass and known-error isolation

**Files:**
- Modify: `src/website-analysis/run.ts`
- Modify: `tests/unit/website-analysis-run.test.ts`

**Interfaces:**
- Consumes: Task 1 `runWebsiteAnalysis` and `WebsiteAnalysisRunItem`. `GeminiWebsiteAnalysisError` from `src/website-analysis/providers/gemini/errors.ts`. `WebsiteAnalysisError` from `src/website-analysis/analysis-errors.ts`.
- Produces: the same `runWebsiteAnalysis` signature. Known analyzer failures become frozen `status: "failed"` items with `retried: false` and the original error object. Unexpected throws still reject the promise.

- [ ] **Step 1: Write the failing tests**

Append these tests. They must fail on the Task 1 implementation because a known analyzer error rejects the run instead of producing a failed item, and because the unexpected-error tests are not the behavior being added: the plain-object and generic-error tests already reject if there is no `catch`, so write them together with the isolation tests and confirm the isolation tests are the ones that fail.

```ts
test("analyzes websites strictly in input order", async () => {
  const input = [factsAt(1), factsAt(2), factsAt(3)];
  const events: string[] = [];
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async (websiteFacts) => {
      events.push(`analyze:${websiteFacts.evidenceId}:first`);
      return succeededResult(websiteFacts);
    },
    now: () => {
      throw new Error("now was called");
    },
    sleep: async () => {
      throw new Error("sleep was called");
    },
  });
  assert.deepEqual(events, ["analyze:1:first", "analyze:2:first", "analyze:3:first"]);
  assert.deepEqual(result.map((item) => item.status === "succeeded" && item.facts.evidenceId), [1, 2, 3]);
  assert.deepEqual(result.map((item) => item.retried), [false, false, false]);
});

test("a known HTTP failure does not stop the next website", async () => {
  const input = [factsAt(1), factsAt(2), factsAt(3)];
  const httpError = new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR");
  const events: string[] = [];
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async (websiteFacts) => {
      events.push(`analyze:${websiteFacts.evidenceId}:first`);
      if (websiteFacts.evidenceId === 2) throw httpError;
      return succeededResult(websiteFacts);
    },
  });
  assert.deepEqual(events, ["analyze:1:first", "analyze:2:first", "analyze:3:first"]);
  assert.equal(result[1]?.status, "failed");
  if (result[1]?.status !== "failed") return;
  assert.equal(result[1].error, httpError);
  assert.equal(result[1].retried, false);
  assert.equal(result[1].error instanceof GeminiWebsiteAnalysisError && result[1].error.code, "GEMINI_HTTP_ERROR");
  assert.deepEqual(Object.keys(result[1]).sort(), ["error", "facts", "retried", "status"]);
  assert.equal(result[0]?.status, "succeeded");
  assert.equal(result[2]?.status, "succeeded");
  assert.equal(result[0]?.retried, false);
  assert.equal(result[2]?.retried, false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[1]), true);
});

test("an invalid Gemini response is terminal", async () => {
  const invalid = new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE");
  const events: string[] = [];
  const result = await runWebsiteAnalysis([factsAt(8), factsAt(9)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      events.push(`analyze:${websiteFacts.evidenceId}:first`);
      if (websiteFacts.evidenceId === 8) throw invalid;
      return succeededResult(websiteFacts);
    },
  });
  assert.deepEqual(events, ["analyze:8:first", "analyze:9:first"]);
  assert.equal(result[0]?.status, "failed");
  if (result[0]?.status !== "failed") return;
  assert.equal(result[0].error, invalid);
  assert.equal(result[0].retried, false);
  assert.equal(result[1]?.status, "succeeded");
});

test("a WebsiteAnalysisError is terminal", async () => {
  for (const code of ["INVALID_ANALYSIS", "ANALYSIS_IDENTITY_MISMATCH"] as const) {
    const validationError = new WebsiteAnalysisError(code);
    const events: string[] = [];
    const result = await runWebsiteAnalysis([factsAt(1), factsAt(2)], geminiConfig(), {
      analyze: async (websiteFacts) => {
        events.push(`analyze:${websiteFacts.evidenceId}:first`);
        if (websiteFacts.evidenceId === 1) throw validationError;
        return succeededResult(websiteFacts);
      },
    });
    assert.deepEqual(events, ["analyze:1:first", "analyze:2:first"]);
    assert.equal(result[0]?.status, "failed");
    if (result[0]?.status !== "failed") continue;
    assert.equal(result[0].error, validationError);
    assert.equal(result[0].retried, false);
    assert.equal(result[1]?.status, "succeeded");
    assert.equal(result[1]?.retried, false);
  }
});

test("a non-transport GeminiWebsiteAnalysisError is terminal", async () => {
  const future = new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR");
  (future as { code: string }).code = "GEMINI_FUTURE_CODE";
  const events: string[] = [];
  const result = await runWebsiteAnalysis([factsAt(1), factsAt(2)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      events.push(`analyze:${websiteFacts.evidenceId}:first`);
      if (websiteFacts.evidenceId === 1) throw future;
      return succeededResult(websiteFacts);
    },
  });
  assert.deepEqual(events, ["analyze:1:first", "analyze:2:first"]);
  assert.equal(result[0]?.status, "failed");
  if (result[0]?.status !== "failed") return;
  assert.equal(result[0].error, future);
  assert.equal(result[0].retried, false);
});

test("an unexpected first-pass error escapes", async () => {
  const bug = new Error("programmer bug");
  const events: string[] = [];
  await assert.rejects(
    () => runWebsiteAnalysis([factsAt(1), factsAt(2), factsAt(3)], geminiConfig(), {
      analyze: async (websiteFacts) => {
        events.push(`analyze:${websiteFacts.evidenceId}:first`);
        if (websiteFacts.evidenceId === 2) throw bug;
        return succeededResult(websiteFacts);
      },
      now: () => {
        throw new Error("now was called");
      },
    }),
    (error: unknown) => error === bug,
  );
  assert.deepEqual(events, ["analyze:1:first", "analyze:2:first"]);
});

test("a plain transport-shaped object escapes", async () => {
  const bug: unknown = { code: "GEMINI_TRANSPORT_UNAVAILABLE", name: "GeminiWebsiteAnalysisError" };
  const events: string[] = [];
  await assert.rejects(
    () => runWebsiteAnalysis([factsAt(1), factsAt(2)], geminiConfig(), {
      analyze: async (websiteFacts) => {
        events.push(`analyze:${websiteFacts.evidenceId}:first`);
        if (websiteFacts.evidenceId === 1) throw bug;
        return succeededResult(websiteFacts);
      },
    }),
    (error: unknown) => error === bug,
  );
  assert.deepEqual(events, ["analyze:1:first"]);
});
```

- [ ] **Step 2: Run the targeted test to verify the new isolation tests fail**

Run the targeted command.

Expected: FAIL with exit code 1. `a known HTTP failure does not stop the next website` rejects with `GeminiWebsiteAnalysisError` instead of returning a three-item array. The invalid-response, `WebsiteAnalysisError`, and future-code tests reject the same way. Task 1 tests still pass. The unexpected-error tests may already reject; do not delete them and do not weaken the isolation assertions to match the throw.

- [ ] **Step 3: Isolate known analyzer errors**

Add `isKnownAnalyzerError`. In the first-pass loop, catch a known analyzer error, store a frozen failed item with `retried: false` and that same error object, and continue. Rethrow anything else. Do not call `now` or `sleep`. Do not special-case `GEMINI_TRANSPORT_UNAVAILABLE` yet. A transport failure in this task is still a terminal known failure; Task 3 changes that, and Task 2 has no test that throws it.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run the same targeted command.

Expected: PASS. Exit code 0. Task 1 and Task 2 tests pass. Do not commit. Continue to Task 3.

## Task 3: Deferred transport retry and verification

**Files:**
- Modify: `src/website-analysis/run.ts`
- Modify: `tests/unit/website-analysis-run.test.ts`

**Interfaces:**
- Consumes: Task 2 `runWebsiteAnalysis` and `isKnownAnalyzerError`.
- Produces: the same public signature. First-pass `GEMINI_TRANSPORT_UNAVAILABLE` becomes one deferred retry. The second call's known outcome is frozen with `retried: true`. A second transport failure is terminal.

- [ ] **Step 1: Write the failing tests**

Append the tests below. Use a test-local clock. `now` returns that clock. `sleep` appends `sleep:${milliseconds}` and adds the milliseconds to the clock. `analyze` appends `analyze:${evidenceId}:first` or `:retry` as specified above.

```ts
test("retry waits until that item's transport failure is 90 seconds old", async () => {
  let clock = 1_000;
  const events: string[] = [];
  const transport = new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
  const result = await runWebsiteAnalysis([factsAt(4)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      const pass = events.some((event) => event.startsWith("analyze:4:")) ? "retry" : "first";
      events.push(`analyze:4:${pass}`);
      if (pass === "first") {
        clock = 5_000;
        throw transport;
      }
      return succeededResult(websiteFacts);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });
  assert.deepEqual(events, ["analyze:4:first", "sleep:90000", "analyze:4:retry"]);
  assert.equal(result[0]?.status, "succeeded");
  assert.equal(result[0]?.retried, true);
});

test("a deferred retry does not run before the rest of the first pass", async () => {
  let clock = 0;
  const events: string[] = [];
  const result = await runWebsiteAnalysis([factsAt(1), factsAt(2)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      const pass = events.some((event) => event.startsWith(`analyze:${websiteFacts.evidenceId}:`)) ? "retry" : "first";
      events.push(`analyze:${websiteFacts.evidenceId}:${pass}`);
      if (websiteFacts.evidenceId === 1 && pass === "first") {
        throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      }
      return succeededResult(websiteFacts);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });
  assert.deepEqual(events, [
    "analyze:1:first",
    "analyze:2:first",
    "sleep:90000",
    "analyze:1:retry",
  ]);
  assert.deepEqual(result.map((item) => item.retried), [true, false]);
  assert.deepEqual(result.map((item) => item.status), ["succeeded", "succeeded"]);
});

test("a second transport-unavailable result is terminal", async () => {
  let clock = 0;
  const events: string[] = [];
  const first = new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
  const second = new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
  const result = await runWebsiteAnalysis([factsAt(6)], geminiConfig(), {
    analyze: async () => {
      const pass = events.some((event) => event.startsWith("analyze:6:")) ? "retry" : "first";
      events.push(`analyze:6:${pass}`);
      if (events.filter((event) => event.startsWith("analyze:6:")).length > 2) {
        throw new Error("third analysis");
      }
      throw pass === "first" ? first : second;
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });
  assert.deepEqual(events, ["analyze:6:first", "sleep:90000", "analyze:6:retry"]);
  assert.equal(result[0]?.status, "failed");
  if (result[0]?.status !== "failed") return;
  assert.equal(result[0].error, second);
  assert.notEqual(result[0].error, first);
  assert.equal(result[0].retried, true);
  assert.equal(result[0].error instanceof GeminiWebsiteAnalysisError && result[0].error.code, "GEMINI_TRANSPORT_UNAVAILABLE");
});

test("an unexpected retry error escapes", async () => {
  let clock = 0;
  const events: string[] = [];
  const bug = new TypeError("broken clock");
  await assert.rejects(
    () => runWebsiteAnalysis([factsAt(1)], geminiConfig(), {
      analyze: async () => {
        const pass = events.some((event) => event.startsWith("analyze:1:")) ? "retry" : "first";
        events.push(`analyze:1:${pass}`);
        if (pass === "first") throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
        throw bug;
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
        clock += milliseconds;
      },
    }),
    (error: unknown) => error === bug,
  );
  assert.deepEqual(events, ["analyze:1:first", "sleep:90000", "analyze:1:retry"]);
});

test("an already-due retry does not sleep", async () => {
  const stamps = [10_000, 100_000];
  let used = 0;
  const events: string[] = [];
  await runWebsiteAnalysis([factsAt(1)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      const pass = events.some((event) => event.startsWith("analyze:1:")) ? "retry" : "first";
      events.push(`analyze:1:${pass}`);
      if (pass === "first") throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      return succeededResult(websiteFacts);
    },
    now: () => stamps[used++] ?? 100_000,
    sleep: async () => {
      events.push("sleep");
    },
  });
  assert.deepEqual(events, ["analyze:1:first", "analyze:1:retry"]);
  assert.equal(used, 2);
});

test("a past-due retry does not sleep", async () => {
  const stamps = [10_000, 150_000];
  let used = 0;
  const events: string[] = [];
  await runWebsiteAnalysis([factsAt(1)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      const pass = events.some((event) => event.startsWith("analyze:1:")) ? "retry" : "first";
      events.push(`analyze:1:${pass}`);
      if (pass === "first") throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      return succeededResult(websiteFacts);
    },
    now: () => stamps[used++] ?? 150_000,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
    },
  });
  assert.deepEqual(events, ["analyze:1:first", "analyze:1:retry"]);
});

test("multiple deferred items retry in original input order", async () => {
  let clock = 0;
  const events: string[] = [];
  const result = await runWebsiteAnalysis([factsAt(1), factsAt(2), factsAt(3)], geminiConfig(), {
    analyze: async (websiteFacts) => {
      const pass = events.some((event) => event.startsWith(`analyze:${websiteFacts.evidenceId}:`)) ? "retry" : "first";
      events.push(`analyze:${websiteFacts.evidenceId}:${pass}`);
      if (pass === "retry") return succeededResult(websiteFacts);
      if (websiteFacts.evidenceId === 1) {
        throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      }
      if (websiteFacts.evidenceId === 3) {
        clock = 1_000;
        throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      }
      return succeededResult(websiteFacts);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });
  assert.deepEqual(events, [
    "analyze:1:first",
    "analyze:2:first",
    "analyze:3:first",
    "sleep:89000",
    "analyze:1:retry",
    "sleep:1000",
    "analyze:3:retry",
  ]);
  assert.deepEqual(result.map((item) => item.retried), [true, false, true]);
});

test("a retry HTTP failure stores that error with retried true", async () => {
  await assertRetryFailure(new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR"));
});

test("a retry invalid response stores that error with retried true", async () => {
  await assertRetryFailure(new GeminiWebsiteAnalysisError("GEMINI_INVALID_RESPONSE"));
});

test("a retry WebsiteAnalysisError stores that error with retried true", async () => {
  await assertRetryFailure(new WebsiteAnalysisError("INVALID_ANALYSIS"));
});

test("ordering example keeps input positions", async () => {
  let clock = 0;
  const events: string[] = [];
  const httpError = new GeminiWebsiteAnalysisError("GEMINI_HTTP_ERROR");
  const input = [factsAt(1), factsAt(2), factsAt(3), factsAt(4)];
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async (websiteFacts) => {
      const pass = events.some((event) => event.startsWith(`analyze:${websiteFacts.evidenceId}:`)) ? "retry" : "first";
      events.push(`analyze:${websiteFacts.evidenceId}:${pass}`);
      if (websiteFacts.evidenceId === 2 && pass === "first") {
        throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      }
      if (websiteFacts.evidenceId === 3) throw httpError;
      return succeededResult(websiteFacts);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });
  assert.deepEqual(events, [
    "analyze:1:first",
    "analyze:2:first",
    "analyze:3:first",
    "analyze:4:first",
    "sleep:90000",
    "analyze:2:retry",
  ]);
  assert.deepEqual(result.map((item) => item.status), ["succeeded", "succeeded", "failed", "succeeded"]);
  assert.deepEqual(result.map((item) => item.retried), [false, true, false, false]);
  assert.equal(result[2]?.status === "failed" && result[2].error, httpError);
  assert.deepEqual(result.map((item) => item.facts.evidenceId), [1, 2, 3, 4]);
});

test("retried items and the result array are frozen", async () => {
  let clock = 0;
  const input = [factsAt(1)];
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async (websiteFacts) => {
      if (clock === 0) throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      return succeededResult(websiteFacts);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input[0]), false);
  assert.equal(result[0]?.facts, input[0]);
});

test("a retry does not count as another input", async () => {
  let clock = 0;
  const input = Array.from({ length: 50 }, (_, index) => factsAt(index + 1));
  let calls = 0;
  const result = await runWebsiteAnalysis(input, geminiConfig(), {
    analyze: async (websiteFacts) => {
      calls += 1;
      if (websiteFacts.evidenceId === 50 && calls === 50) {
        throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      }
      return succeededResult(websiteFacts);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  });
  assert.equal(calls, 51);
  assert.equal(result.length, 50);
  assert.equal(result[49]?.retried, true);
  assert.equal(result[49]?.status, "succeeded");
  assert.equal(result[0]?.retried, false);
});
```

Add this helper next to the Task 1 helpers. It is local to the test file.

```ts
async function assertRetryFailure(secondError: Error): Promise<void> {
  let clock = 0;
  const events: string[] = [];
  const result = await runWebsiteAnalysis([factsAt(7)], geminiConfig(), {
    analyze: async () => {
      const pass = events.some((event) => event.startsWith("analyze:7:")) ? "retry" : "first";
      events.push(`analyze:7:${pass}`);
      if (pass === "first") throw new GeminiWebsiteAnalysisError("GEMINI_TRANSPORT_UNAVAILABLE");
      throw secondError;
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
      clock += milliseconds;
    },
  });
  assert.deepEqual(events, ["analyze:7:first", "sleep:90000", "analyze:7:retry"]);
  assert.equal(result[0]?.status, "failed");
  if (result[0]?.status !== "failed") return;
  assert.equal(result[0].error, secondError);
  assert.equal(result[0].retried, true);
}
```

The stamp tests call `now` exactly twice: once for `failureTime` and once for `remaining`. Do not call `now` anywhere else, or those two tests observe the wrong stamp.

The multiple-deferred numbers are fixed by the algorithm. Item 1 fails at clock `0`, so its `retryAt` is `90_000`. Item 3 moves the clock to `1_000` before throwing, so its `failureTime` is `1_000` and its `retryAt` is `91_000`. The first retry computes `90_000 - 1_000` and sleeps `89_000`. The second retry then computes `91_000 - 90_000` and sleeps `1_000`. Two precomputed `90_000` sleeps, or one global `90_000` sleep, fail this assertion.

- [ ] **Step 2: Run the targeted test to verify the retry tests fail**

Run the targeted command.

Expected: FAIL with exit code 1. On the Task 2 implementation, `retry waits until that item's transport failure is 90 seconds old` returns `retried: false` and does not emit `sleep:90000`, because transport-unavailable is still terminal. Task 1 and Task 2 tests still pass.

- [ ] **Step 3: Implement the deferred retry**

Add the first-pass transport branch and the deferred loop from the locked two-pass algorithm. Keep validation and known terminal failures. The second pass stores `retried: true` for both success and known failure, including a second `GEMINI_TRANSPORT_UNAVAILABLE`. It does not push that item back onto `deferredItems`. Unexpected second-pass throws propagate. Add the private `delay` default. Do not add a retry option, backoff, or a third call.

- [ ] **Step 4: Run the targeted test to verify it passes**

Run the same targeted command.

Expected: PASS. Exit code 0. No test waits 90 seconds. The sleep assertions observe the seam.

- [ ] **Step 5: Leave the living docs unchanged**

Do not edit `docs/PLAN.md` or `docs/BACKLOG.md`. Green tests do not make DQ-033 an integrated completed slice. The current docs already describe DQ-033 as the planned, unintegrated next slice. Do not mark DQ-033 Completed. Do not make DQ-034 the official next step.

- [ ] **Step 6: Run final verification and stop uncommitted**

```bash
npm test
npm run typecheck
git diff --check
git status --short
```

Expected: `npm test` passes with 0 failures and 0 skips. `npm run typecheck` passes. `git diff --check` prints nothing. `git status --short` shows only `src/website-analysis/run.ts`, `src/website-analysis/index.ts`, and `tests/unit/website-analysis-run.test.ts`. `docs/PLAN.md`, `docs/BACKLOG.md`, `package.json`, and `package-lock.json` are absent. No source file outside `run.ts` and `index.ts` is modified. Leave that diff unstaged and uncommitted. Do not `git add`. Do not commit. Do not push. Do not open a pull request. Do not merge.

## Later integration after Analyst approval and human approval

The Builder does not perform this section. It is not a task step. After the Analyst approves the uncommitted local diff and a human approves integration, that later step may update the living docs and then commit, push, open the pull request, wait for CI, and merge with a normal merge commit. Do not squash or rebase. Do not do any of that before both approvals.

That later documentation update may set DQ-033 to Completed, DQ-034–039 to Planned, and the next step to DQ-034. It must preserve: 50/run is not 50/day, DQ-033 does not select evidence from D1, and DQ-033 does not persist analysis. Keep Phase 3 **Status: Current**. Do not mark Phase 3 complete. Leave the DQ-030, DQ-031, and DQ-032 sections unchanged. Do not design stored-evidence wiring, `extractWebsiteFacts` orchestration, or DQ-034 persistence.

In `docs/PLAN.md`, replace the Phase 3 intro paragraph with:

```text
Phase 3 is current and is not complete. DQ-030, DQ-031, DQ-032, and DQ-033 are completed. DQ-034–039 remain planned. Analysis remains separate from contact and outreach. Single-website Gemini analysis exists, and a bounded sequential run of already-created WebsiteFacts exists. One run accepts at most 50 unique evidenceIds. 50/run is not a persisted 50/day budget. The run calls analyzeWebsiteWithGemini one website at a time. Known failures stay on that website. Only GEMINI_TRANSPORT_UNAVAILABLE is deferred, and that website is retried once 90 seconds after its own first transport failure. Results keep original input order. DQ-033 does not select evidence from D1 and does not persist analysis. Persistence, cross-provider fallback, qualification, contacts, and outreach do not exist yet. A validator is not AI analysis.
```

After the DQ-032 section and before Phase 4, add:

```text
### DQ-033 — Bounded Website Analysis Run

**Status: Completed**

`DQ-033 — Bounded Website Analysis Run` runs an explicit `WebsiteFacts` array through `analyzeWebsiteWithGemini`. It accepts 0–50 items with unique evidenceIds per run. More than 50 items, or a duplicate evidenceId, rejects the whole run. Execution is sequential. Known Gemini failures and `WebsiteAnalysisError` stay on that website. `GEMINI_TRANSPORT_UNAVAILABLE` is deferred until the first pass finishes, then retried once at that item's failure time plus 90 seconds. Results keep original input order. 50/run is not a persisted 50/day budget. The run does not load evidence from D1 or SQLite and does not persist analysis.
```

Replace the Current Position inventory sentence with `Phase 3 — Website Analysis: Current. DQ-030, DQ-031, DQ-032, and DQ-033 are completed. DQ-034–039 remain planned.` Add `DQ-033 — Bounded Website Analysis Run: Completed.` after the DQ-032 current-position line.

Replace the Next Planned Step paragraph with:

```text
Phase 3 — Website Analysis is current and is not complete. DQ-030, DQ-031, DQ-032, and DQ-033 are completed. DQ-034–039 remain planned. Bounded sequential website analysis now exists for an explicit WebsiteFacts array of at most 50 unique evidenceIds per run, with one deferred transport-only retry 90 seconds after that item's first transport failure. 50/run is not a persisted 50/day budget. DQ-033 does not select from D1 and does not persist analysis. The next planned step is DQ-034, persistence and provenance for analysis results. DQ-034 is not implemented. Cross-provider fallback, qualification, contacts, and outreach do not exist yet. Groq, Cloudflare Workers AI, and OpenRouter remain unimplemented. DQ-020 through DQ-025 are completed. Discovery still uses local SQLite and does not feed production D1 automatically. Scheduled crawling of an eligible production D1 lead does not require the Mac.
```

In `docs/BACKLOG.md` Current Status, replace:

```text
DQ-033–039 remain planned. Single-website Gemini analysis now exists. The next planned step is DQ-033, the bounded multi-website analysis run plus the deferred 90-second retry. That run is not implemented. Multi-website analysis, the 90-second retry, persistence, cross-provider fallback, qualification, contacts, and outreach do not exist yet.
```

with:

```text
DQ-033 — Bounded Website Analysis Run is completed. DQ-034–039 remain planned. Single-website Gemini analysis exists, and the bounded sequential run exists. One run accepts at most 50 unique evidenceIds. 50/run is not a persisted 50/day budget. DQ-033 does not select evidence from D1 and does not persist analysis. The next planned step is DQ-034, persistence and provenance. DQ-034 is not implemented. Persistence, cross-provider fallback, qualification, contacts, and outreach do not exist yet.
```

Replace `### DQ-033–039 — Website Analysis` and its status paragraph with a completed DQ-033 section that copies the PLAN DQ-033 paragraph, then:

```text
### DQ-034–039 — Website Analysis

**Status: Planned**

Phase 3 — Website Analysis remains current and is not complete. DQ-034–039 remain planned. The next planned step is DQ-034, persistence and provenance for website analysis. DQ-034 is not implemented. Persistence, cross-provider fallback, qualification, contacts, and outreach do not exist yet. Groq, Cloudflare Workers AI, and OpenRouter remain unimplemented. Later analysis may inspect stored crawl evidence for outdated design, poor usability, missing functionality, or other potential improvement opportunities, and produce structured observations linked to supporting evidence. The expected output is website audit information for qualification, not contact or outreach activity.
```

Do not design stored-evidence wiring, `extractWebsiteFacts` orchestration, or DQ-034 persistence in that later edit. Do not mark DQ-034 completed.
