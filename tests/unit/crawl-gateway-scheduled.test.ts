import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import worker, {
  handleScheduledAnalysis,
  isWarsawDailyAnalysisTime,
  type CrawlGatewayEnv,
} from "../../src/crawl-gateway/worker";
import {
  runD1WebsiteAnalysisPipeline,
  type D1WebsiteAnalysisPipelineResult,
} from "../../src/website-analysis/d1-analysis-pipeline";

const FIXTURE_KEY = "scheduled-fixture-key";
const SUMMER_ACTIVE = "2026-07-15T13:00:00.000Z";
const WINTER_INACTIVE = "2026-01-15T13:00:00.000Z";

const SUCCESS_FIELDS = [
  "selected",
  "succeeded",
  "failed",
  "retried",
  "persisted",
  "utcDate",
  "websitesAdmitted",
  "websiteLimit",
  "geminiRequestsUsed",
  "geminiRequestLimit",
  "stoppedReason",
] as const;

function at(iso: string): number {
  return Date.parse(iso);
}

test("summer 2026-07-15 runs at 13:00Z and not at 14:00Z", () => {
  assert.equal(isWarsawDailyAnalysisTime(at("2026-07-15T13:00:00.000Z")), true);
  assert.equal(isWarsawDailyAnalysisTime(at("2026-07-15T14:00:00.000Z")), false);
});

test("winter 2026-01-15 runs at 14:00Z and not at 13:00Z", () => {
  assert.equal(isWarsawDailyAnalysisTime(at("2026-01-15T13:00:00.000Z")), false);
  assert.equal(isWarsawDailyAnalysisTime(at("2026-01-15T14:00:00.000Z")), true);
});

test("a DST boundary day activates exactly one of the two UTC hours", () => {
  const springThirteen = isWarsawDailyAnalysisTime(at("2026-03-29T13:00:00.000Z"));
  const springFourteen = isWarsawDailyAnalysisTime(at("2026-03-29T14:00:00.000Z"));
  assert.equal(Number(springThirteen) + Number(springFourteen), 1);
  assert.equal(springThirteen, true);
  assert.equal(springFourteen, false);

  const autumnThirteen = isWarsawDailyAnalysisTime(at("2026-10-25T13:00:00.000Z"));
  const autumnFourteen = isWarsawDailyAnalysisTime(at("2026-10-25T14:00:00.000Z"));
  assert.equal(Number(autumnThirteen) + Number(autumnFourteen), 1);
  assert.equal(autumnThirteen, false);
  assert.equal(autumnFourteen, true);
});

test("the day before each 2026 DST change follows that calendar day", () => {
  assert.equal(isWarsawDailyAnalysisTime(at("2026-03-28T13:00:00.000Z")), false);
  assert.equal(isWarsawDailyAnalysisTime(at("2026-03-28T14:00:00.000Z")), true);
  assert.equal(isWarsawDailyAnalysisTime(at("2026-10-24T13:00:00.000Z")), true);
  assert.equal(isWarsawDailyAnalysisTime(at("2026-10-24T14:00:00.000Z")), false);
});

test("a non-finite or invalid scheduled time is not the daily analysis time", () => {
  assert.equal(isWarsawDailyAnalysisTime(Number.NaN), false);
  assert.equal(isWarsawDailyAnalysisTime(Number.POSITIVE_INFINITY), false);
  assert.equal(isWarsawDailyAnalysisTime(Number.NEGATIVE_INFINITY), false);
  assert.equal(isWarsawDailyAnalysisTime(Number.MAX_VALUE), false);
});

test("the Warsaw guard source does not hardcode offsets or the sample dates", () => {
  const source = readFileSync(join(process.cwd(), "src/crawl-gateway/worker.ts"), "utf8");
  assert.equal(source.includes("Europe/Warsaw"), true);
  for (const absent of [
    "2026-07-15",
    "2026-01-15",
    "2026-03-28",
    "2026-03-29",
    "2026-10-24",
    "2026-10-25",
    "UTC+1",
    "UTC+2",
  ]) {
    assert.equal(source.includes(absent), false, absent);
  }
});

function throwingDatabase(): CrawlGatewayEnv["DB"] {
  const fail = (): never => {
    throw new Error("d1 touched");
  };
  return {
    prepare: fail,
    batch: fail,
  } as CrawlGatewayEnv["DB"];
}

function closedConfigEnv(): CrawlGatewayEnv {
  return Object.defineProperties(
    { DB: throwingDatabase() },
    {
      GEMINI_API_KEY: {
        enumerable: true,
        get(): string {
          throw new Error("config read");
        },
      },
      GEMINI_DAILY_REQUEST_LIMIT: {
        enumerable: true,
        get(): string {
          throw new Error("config read");
        },
      },
    },
  ) as CrawlGatewayEnv;
}

function activeEnv(): CrawlGatewayEnv {
  return {
    DB: throwingDatabase(),
    GEMINI_API_KEY: FIXTURE_KEY,
    GEMINI_DAILY_REQUEST_LIMIT: "10",
  };
}

function successResult(): D1WebsiteAnalysisPipelineResult {
  return Object.freeze({
    selected: 3,
    succeeded: 2,
    failed: 1,
    retried: 1,
    persisted: 2,
    budget: Object.freeze({
      utcDate: "2026-07-15",
      websitesAdmitted: 7,
      websiteLimit: 50 as const,
      geminiRequestsUsed: 4,
      geminiRequestLimit: 10,
      stoppedReason: "request_cap" as const,
    }),
  });
}

function pipelineSpy(result: D1WebsiteAnalysisPipelineResult = successResult()): {
  calls: Array<Parameters<typeof runD1WebsiteAnalysisPipeline>>;
  runPipeline: typeof runD1WebsiteAnalysisPipeline;
} {
  const calls: Array<Parameters<typeof runD1WebsiteAnalysisPipeline>> = [];
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = (...args) => {
    calls.push(args);
    return Promise.resolve(result);
  };
  return { calls, runPipeline };
}

async function captureLogs(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

async function withLaterExecutionClock<T>(run: () => Promise<T>): Promise<T> {
  const executionTime = Date.parse("2026-07-15T16:00:00.000Z");
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(executionTime);
        return;
      }
      super(...(args as ConstructorParameters<typeof RealDate>));
    }

    static override now(): number {
      return executionTime;
    }
  }
  globalThis.Date = ShiftedDate as unknown as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
  }
}

test("an inactive event with invalid Gemini config does not call the pipeline", async () => {
  const { calls, runPipeline } = pipelineSpy();
  const lines = await captureLogs(() =>
    handleScheduledAnalysis(
      { scheduledTime: at(WINTER_INACTIVE), cron: "0 13 * * *" },
      closedConfigEnv(),
      { runPipeline },
    ),
  );
  assert.equal(calls.length, 0);
  assert.equal(lines.length, 0);
});

test("the cron string does not decide the Warsaw guard", async () => {
  const { calls, runPipeline } = pipelineSpy();
  await handleScheduledAnalysis(
    { scheduledTime: at("2026-07-15T14:00:00.000Z"), cron: "0 14 * * *" },
    closedConfigEnv(),
    { runPipeline },
  );
  assert.equal(calls.length, 0);
});

test("a delayed execution still runs from scheduledTime", async () => {
  const env = activeEnv();
  const { calls, runPipeline } = pipelineSpy();
  await withLaterExecutionClock(() =>
    handleScheduledAnalysis(
      { scheduledTime: at(SUMMER_ACTIVE) },
      env,
      { runPipeline },
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 3);
});

test("an active event calls the pipeline once with the caller database and maxItems 50", async () => {
  const env = activeEnv();
  const { calls, runPipeline } = pipelineSpy();
  await handleScheduledAnalysis({ scheduledTime: at(SUMMER_ACTIVE) }, env, { runPipeline });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 3);
  assert.equal(calls[0][0], env.DB);
  assert.equal(Object.isFrozen(calls[0][1]), true);
  assert.deepEqual(calls[0][1], {
    provider: "gemini",
    apiKey: FIXTURE_KEY,
    dailyRequestLimit: 10,
  });
  assert.equal(calls[0][2], 50);
});

test("an active event with invalid Gemini config fails before the pipeline", async () => {
  const environments: CrawlGatewayEnv[] = [
    { DB: throwingDatabase(), GEMINI_DAILY_REQUEST_LIMIT: "10" },
    { DB: throwingDatabase(), GEMINI_API_KEY: "bad key", GEMINI_DAILY_REQUEST_LIMIT: "10" },
    { DB: throwingDatabase(), GEMINI_API_KEY: FIXTURE_KEY },
    { DB: throwingDatabase(), GEMINI_API_KEY: FIXTURE_KEY, GEMINI_DAILY_REQUEST_LIMIT: "0" },
  ];
  for (const env of environments) {
    const { calls, runPipeline } = pipelineSpy();
    await assert.rejects(
      () => handleScheduledAnalysis({ scheduledTime: at(SUMMER_ACTIVE) }, env, { runPipeline }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Scheduled analysis configuration is invalid.");
        assert.equal(error.message.includes(FIXTURE_KEY), false);
        assert.equal(error.message.includes("bad key"), false);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }
});

test("a non-finite or invalid scheduled time fails closed", async () => {
  for (const scheduledTime of [Number.NaN, Number.MAX_VALUE]) {
    const { calls, runPipeline } = pipelineSpy();
    await assert.rejects(
      () => handleScheduledAnalysis({ scheduledTime }, closedConfigEnv(), { runPipeline }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Scheduled analysis failed.");
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }
});

test("a pipeline rejection fails the scheduled invocation", async () => {
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = () => {
    throw new Error(`provider body ${FIXTURE_KEY}`);
  };
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await assert.rejects(
      () => handleScheduledAnalysis({ scheduledTime: at(SUMMER_ACTIVE) }, activeEnv(), { runPipeline }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Scheduled analysis failed.");
        assert.equal(error.cause, undefined);
        assert.equal(String(error).includes("provider body"), false);
        assert.equal(String(error).includes(FIXTURE_KEY), false);
        return true;
      },
    );
  } finally {
    console.log = original;
  }
  assert.equal(lines.length, 0);
});

test("a successful active run logs one safe summary", async () => {
  const result = successResult();
  const { runPipeline } = pipelineSpy(result);
  const lines = await captureLogs(() =>
    handleScheduledAnalysis({ scheduledTime: at(SUMMER_ACTIVE) }, activeEnv(), { runPipeline }),
  );
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(summary), [...SUCCESS_FIELDS]);
  assert.deepEqual(summary, {
    selected: 3,
    succeeded: 2,
    failed: 1,
    retried: 1,
    persisted: 2,
    utcDate: "2026-07-15",
    websitesAdmitted: 7,
    websiteLimit: 50,
    geminiRequestsUsed: 4,
    geminiRequestLimit: 10,
    stoppedReason: "request_cap",
  });
  assert.equal(lines[0].includes(FIXTURE_KEY), false);
  assert.equal(lines[0].includes("summary"), false);
  assert.equal(lines[0].includes("findings"), false);
  assert.notEqual(lines[0], JSON.stringify(result));
});

test("the default scheduled export fulfills an off-time event without a pipeline override", async () => {
  await worker.scheduled(
    { scheduledTime: at(WINTER_INACTIVE), cron: "0 13 * * *" },
    closedConfigEnv(),
    {},
  );
  assert.equal(worker.fetch.length, 2);
  const source = readFileSync(join(process.cwd(), "src/crawl-gateway/worker.ts"), "utf8");
  assert.equal(source.includes("waitUntil"), false);
  assert.equal(source.includes("SCHEDULED_ANALYSIS_MAX_ITEMS"), false);
});

test("overlapping scheduled calls both reach the existing pipeline", async () => {
  const env = activeEnv();
  const result = successResult();
  const calls: Array<Parameters<typeof runD1WebsiteAnalysisPipeline>> = [];
  let release: (value: D1WebsiteAnalysisPipelineResult) => void = () => undefined;
  const gate = new Promise<D1WebsiteAnalysisPipelineResult>((resolve) => {
    release = resolve;
  });
  const runPipeline: typeof runD1WebsiteAnalysisPipeline = (...args) => {
    calls.push(args);
    return gate;
  };
  const controller = { scheduledTime: at(SUMMER_ACTIVE) };
  const first = handleScheduledAnalysis(controller, env, { runPipeline });
  const second = handleScheduledAnalysis(controller, env, { runPipeline });
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], env.DB);
  assert.equal(calls[1][0], env.DB);
  assert.equal(calls[0][2], 50);
  assert.equal(calls[1][2], 50);
  assert.equal(calls[0].length, 3);
  assert.equal(calls[1].length, 3);
  release(result);
  await Promise.all([first, second]);
});

test("wrangler.toml schedules both Warsaw UTC opportunities", () => {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");
  assert.equal(toml.includes("[triggers]"), true);
  assert.equal(toml.includes('"0 13 * * *"'), true);
  assert.equal(toml.includes('"0 14 * * *"'), true);
  for (const absent of [
    "GEMINI_DAILY_REQUEST_LIMIT",
    "ANALYSIS_GATEWAY_TOKEN",
    "GEMINI_API_KEY",
    "CRAWL_GATEWAY_TOKEN",
  ]) {
    assert.equal(toml.includes(absent), false, absent);
  }
});
