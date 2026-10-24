import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { GeminiWebsiteAnalysisConfig } from "../../src/config/env";
import {
  GeminiWebsiteAnalysisError,
  WEBSITE_ANALYSIS_RUN_ERROR_CODES,
  WebsiteAnalysisError,
  WebsiteAnalysisRunError,
  runWebsiteAnalysis,
} from "../../src/website-analysis";
import type {
  GeminiWebsiteAnalysisResult,
  WebsiteFacts,
} from "../../src/website-analysis";

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
  return { provider: "gemini", apiKey: API_KEY, dailyRequestLimit: 10 };
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
    attemptedModels: Object.freeze(["gemini-3.8-flash"] as const),
  });
}

function assertInvalidRequest(error: unknown, leaked: string): void {
  assert.ok(error instanceof WebsiteAnalysisRunError);
  if (!(error instanceof WebsiteAnalysisRunError)) {
    return;
  }
  assert.equal(error.name, "WebsiteAnalysisRunError");
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(error.message, "Website analysis run request is invalid.");
  assert.equal("cause" in error, false);
  assert.equal(error.message.includes(leaked), false);
  assert.equal(error.message.includes(API_KEY), false);
  assert.equal(error.message.includes("51"), false);
}

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
