# DQ-033 Bounded Website Analysis Run Design

## Status

```text
design, human-approved, not implemented
```

## Intent

DQ-033 orchestrates multiple already-created WebsiteFacts values through the existing DQ-032 Gemini adapter.

DQ-033 owns bounded input, sequential execution, per-website failure isolation, one deferred retry after full Gemini transport failure, and ordered terminal run results.

DQ-033 does NOT own storage selection or persistence.

Flow:

```text
WebsiteFacts[]
→ validate batch
→ sequential first pass
→ DQ-032 per item
→ defer only GEMINI_TRANSPORT_UNAVAILABLE
→ continue remaining items
→ retry deferred items once when due
→ ordered terminal results
```

## Approved approach

Approach 1 — simple two-pass sequential runner. Chosen because it is the smallest design, preserves free-tier friendliness, reuses DQ-032 exactly, is easy to test, avoids concurrency and race complexity, and keeps the system simple.

Rejected: a concurrent worker pool, because it adds concurrency and rate-limit complexity without current need. A persistent queue or scheduler, because it would pull persistence and background-job infrastructure into the wrong slice.

## Public operation

One operation equivalent to:

```ts
runWebsiteAnalysis(
  facts: readonly WebsiteFacts[],
  config: GeminiWebsiteAnalysisConfig,
  options?: WebsiteAnalysisRunOptions,
): Promise<readonly WebsiteAnalysisRunItem[]>
```

Equivalent naming consistent with repository conventions is acceptable. Do NOT introduce a generic provider-neutral orchestration framework. DQ-033 calls analyzeWebsiteWithGemini from DQ-032.

## Input rules

0 items returns a frozen empty array. 1–50 items are accepted if evidenceId values are unique. More than 50 items, or a duplicate evidenceId, rejects the entire run. Do NOT silently truncate.

The 50 limit is 50 unique WebsiteFacts per run. 50/run is NOT 50/day. DQ-033 has no persisted daily accounting and must not claim to guarantee 50/day. Retries of the same WebsiteFacts do not count as new unique input items.

## Run-level error

Keep it minimal. The run error is `WebsiteAnalysisRunError` with code `INVALID_REQUEST`, used for more than 50 inputs and duplicate evidenceId. Do not create a large run-error taxonomy. Do not deeply revalidate WebsiteFacts; DQ-030 owns construction of that type.

Follow the website-analysis error style: one frozen code array containing only `INVALID_REQUEST`, one fixed message, `readonly name = "WebsiteAnalysisRunError"`, `constructor(readonly code)`, and no `cause`. The message is `Website analysis run request is invalid.` It does not include the input length, any evidenceId, or the supplied facts. Both rejection cases use this same error.

## First pass

Processing is strictly sequential. Concurrency is 1. No Promise.all, worker pool, semaphore, configurable concurrency, or queue.

For each input in original order, call analyzeWebsiteWithGemini.

Success: record a terminal success with `retried: false`.

Known non-transport failure, including GEMINI_HTTP_ERROR, GEMINI_INVALID_RESPONSE, and WebsiteAnalysisError: record a terminal failure for that item with `retried: false` and continue the batch. Do not retry.

Full Gemini transport failure, exactly GeminiWebsiteAnalysisError with code GEMINI_TRANSPORT_UNAVAILABLE: record it as deferred with retryAt = failureTime + 90_000, then immediately continue with the remaining first-pass websites. `failureTime` is the `now()` value observed when that first-pass call fails.

## Unexpected errors

Do NOT convert every arbitrary thrown error into a failed website result. If the analyzer throws an unexpected error outside the known DQ-032 and DQ-031 error domains, propagate it and fail the run. Programming and system bugs must not be silently hidden as normal website failures. Keep the known-error check explicit and small.

## Deferred retry

Only items whose first DQ-032 call ended in GEMINI_TRANSPORT_UNAVAILABLE are retried. After the first pass completes, process deferred items in original input order.

For each deferred item, compute remaining when that item is reached, after any earlier deferred item has finished its retry. `remaining = retryAt - now()`. If remaining > 0, sleep(remaining), then call analyzeWebsiteWithGemini once more. If the first pass took longer than the item's 90 seconds, remaining <= 0, retry immediately, and do not sleep. Do not precompute every sleep at the end of the first pass.

The second call is a normal full DQ-032 operation and therefore may internally attempt all four Gemini models. No third analysis call.

Exact retry architecture: first complete DQ-032 chain; if transport unavailable, wait until failure + 90s; second complete DQ-032 chain; terminal.

Do NOT add exponential backoff, a retry-count config, infinite retries, same-model retry, or a persistent retry queue.

## Retry outcomes

Second attempt success: status succeeded, retried true.
Second attempt transport failure: status failed, retried true, error GEMINI_TRANSPORT_UNAVAILABLE.
Second attempt HTTP, malformed, or DQ-031 failure: status failed, retried true, error is the actual known terminal error.
No further retry. Unexpected arbitrary errors on retry still propagate and fail the run.

The failed item stores that thrown known error object. Do not wrap it.

## Result contract

One terminal item per original input:

```ts
type WebsiteAnalysisRunItem =
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
```

One result item per input. Original input order is preserved. Successful and failed retries return in their original position. Freeze each item and the returned array. Do not add a summary object. Counts can be derived by the caller. Do not add a run ID, timestamps, token usage, cost, latency, provider aggregation, database IDs, or a retry-count integer. retried: boolean is sufficient.

## Minimal options

```ts
type WebsiteAnalysisRunOptions = Readonly<{
  analyze?: typeof analyzeWebsiteWithGemini;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}>;
```

Defaults: analyze is analyzeWebsiteWithGemini, now is Date.now, sleep is a Promise based on setTimeout. These are only small execution and test seams. They are not a DI container, service abstraction, scheduler abstraction, clock framework, or queue framework. The retry delay is not configurable. The exact production delay is 90_000 ms.

## Ordering example

Input A, B, C, D. A succeeds. B transport-fails. C fails HTTP. D succeeds. B later succeeds on retry. The returned array is still A success, B success with retried true, C failure, D success. Do not return results in completion order.

## Known terminal errors

Recognize only GeminiWebsiteAnalysisError and WebsiteAnalysisError for failure isolation. GEMINI_TRANSPORT_UNAVAILABLE is retryable after the first pass only. A GeminiWebsiteAnalysisError whose code is not GEMINI_TRANSPORT_UNAVAILABLE is terminal for that attempt. GEMINI_HTTP_ERROR and GEMINI_INVALID_RESPONSE are terminal. Do not duplicate DQ-032 transport or model logic inside DQ-033. DQ-033 must never inspect individual Gemini model attempts to decide retry. It only consumes DQ-032's terminal result or error.

## Module boundary

Prefer src/website-analysis/run.ts plus the existing src/website-analysis/index.ts, and later tests/unit/website-analysis-run.test.ts. Do not create a folder hierarchy unless genuinely necessary. Do not force needless file splitting.

## Testing expectations

Future implementation tests should cover: empty input returns a frozen empty result; one success; multiple items analyzed sequentially; 50 unique inputs accepted; 51 rejected; duplicate evidenceId rejected; a known failure for one website does not stop later items; HTTP error is terminal; invalid Gemini response is terminal; WebsiteAnalysisError is terminal; GEMINI_TRANSPORT_UNAVAILABLE is deferred; remaining first-pass items run before the deferred retry; retry is not before failure time plus 90_000; an already-due retry does not sleep; multiple deferred items retry in original input order; retry success is succeeded with retried true; retry transport failure is failed with retried true; retry HTTP, invalid, or DQ-031 failure is failed with retried true; an unexpected arbitrary first-pass error propagates; an unexpected arbitrary retry error propagates; the result array preserves original input order; each item is frozen; the array is frozen. Tests must not actually wait 90 seconds. Use the approved now and sleep seams.

## Explicit exclusions

DQ-033 does NOT implement D1 evidence selection, SQLite evidence selection, crawl evidence loading, extractWebsiteFacts orchestration, analysis persistence, provider provenance persistence, D1 or SQLite schema changes, migrations, 50/day accounting, parallel execution, configurable concurrency, cross-provider fallback, Groq, Cloudflare Workers AI, OpenRouter, a scheduler, GitHub Actions, a queue service, a background worker, qualification, lead scoring, contact discovery, DNC execution, email drafting, email sending, token accounting, cost accounting, or latency metrics.

DQ-034 remains the next persistence and provenance slice. Future wiring may become stored crawl evidence, then extractWebsiteFacts, then the DQ-033 run, then DQ-034 persistence, but do NOT design or implement that wiring here.

## Simplicity

No concurrency. No persistent retry queue. No generic retry library. No scheduler. No storage access. No persistence. No summary object. No generic AI orchestration framework.
