import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { Miniflare } from "miniflare";
import { D1WebsiteAnalysisPipelineError } from "../../src/website-analysis/pipeline-errors";
import type { D1WebsiteAnalysisPipelineDatabase } from "../../src/website-analysis/d1-analysis-pipeline";
import * as dailyUsage from "../../src/website-analysis/daily-usage";
import {
  readWebsiteAnalysisDailyUsage,
  reserveGeminiRequest,
  reserveWebsiteAnalysisBatch,
} from "../../src/website-analysis/daily-usage";

const UTC_DATE = "2026-10-24";

async function withDatabase(
  use: (database: D1WebsiteAnalysisPipelineDatabase) => Promise<void>,
): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    script: `
      export default {
        async fetch() {
          return new Response("ok");
        }
      };
    `,
    d1Databases: {
      DB: "delta-qoralis-test",
    },
    d1Persist: false,
  });
  try {
    const database = await mf.getD1Database("DB");
    for (const fileName of [
      "0001_delta_qoralis_crawl.sql",
      "0002_website_analysis.sql",
      "0003_website_analysis_selection.sql",
      "0004_website_analysis_daily_usage.sql",
    ]) {
      await database.exec(readFileSync(join(process.cwd(), "migrations", fileName), "utf8"));
    }
    await use(database);
  } finally {
    await mf.dispose();
  }
}

async function usageRow(
  database: D1WebsiteAnalysisPipelineDatabase,
): Promise<{ websitesAdmitted: number; geminiRequestsUsed: number } | null> {
  const row = await database
    .prepare(
      `SELECT websites_admitted, gemini_requests_used
       FROM website_analysis_daily_usage
       WHERE utc_date = ?`,
    )
    .bind(UTC_DATE)
    .first();
  if (row === null) return null;
  return {
    websitesAdmitted: row.websites_admitted as number,
    geminiRequestsUsed: row.gemini_requests_used as number,
  };
}

async function admissionCount(
  database: D1WebsiteAnalysisPipelineDatabase,
  evidenceId?: number,
): Promise<number> {
  const row = evidenceId === undefined
    ? await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM website_analysis_daily_admissions
         WHERE utc_date = ?`,
      )
      .bind(UTC_DATE)
      .first()
    : await database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM website_analysis_daily_admissions
         WHERE utc_date = ? AND evidence_id = ?`,
      )
      .bind(UTC_DATE, evidenceId)
      .first();
  return Number(row?.count ?? 0);
}

test("the first usage read is zero without a row", async () => {
  await withDatabase(async (database) => {
    const usage = await readWebsiteAnalysisDailyUsage(database, UTC_DATE);
    assert.deepEqual(usage, { websitesAdmitted: 0, geminiRequestsUsed: 0 });
    const row = await database
      .prepare("SELECT COUNT(*) AS count FROM website_analysis_daily_usage")
      .bind()
      .first();
    assert.equal(Number(row?.count ?? 0), 0);
  });
});

test("the first reservation creates the usage row and one admission", async () => {
  await withDatabase(async (database) => {
    const reserved = await reserveWebsiteAnalysisBatch(database, UTC_DATE, [101], 10);
    assert.equal(reserved, true);
    assert.deepEqual(await usageRow(database), { websitesAdmitted: 1, geminiRequestsUsed: 1 });
    assert.equal(await admissionCount(database, 101), 1);
  });
});

test("a same-day duplicate evidence id is rejected and rolled back", async () => {
  await withDatabase(async (database) => {
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [101], 10), true);
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [101], 10), false);
    assert.deepEqual(await usageRow(database), { websitesAdmitted: 1, geminiRequestsUsed: 1 });
    assert.equal(await admissionCount(database), 1);
  });
});

test("the 50th admission commits and the 51st does not", async () => {
  await withDatabase(async (database) => {
    const ids = Array.from({ length: 49 }, (_, index) => index + 1);
    for (let offset = 0; offset < 45; offset += 5) {
      assert.equal(
        await reserveWebsiteAnalysisBatch(database, UTC_DATE, ids.slice(offset, offset + 5), 100),
        true,
      );
    }
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, ids.slice(45), 100), true);
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [50], 100), true);
    assert.equal((await usageRow(database))?.websitesAdmitted, 50);
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [51], 100), false);
    assert.equal(await admissionCount(database), 50);
    assert.equal((await usageRow(database))?.websitesAdmitted, 50);
  });
});

test("a proposal that crosses the 50 cap rolls back every insert in that batch", async () => {
  await withDatabase(async (database) => {
    const ids = Array.from({ length: 49 }, (_, index) => index + 1);
    for (let offset = 0; offset < 45; offset += 5) {
      assert.equal(
        await reserveWebsiteAnalysisBatch(database, UTC_DATE, ids.slice(offset, offset + 5), 100),
        true,
      );
    }
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, ids.slice(45), 100), true);
    const requestsBefore = (await usageRow(database))?.geminiRequestsUsed;
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [50, 51], 100), false);
    assert.equal(await admissionCount(database, 50), 0);
    assert.equal(await admissionCount(database, 51), 0);
    assert.equal((await usageRow(database))?.websitesAdmitted, 49);
    assert.equal((await usageRow(database))?.geminiRequestsUsed, requestsBefore);
  });
});

test("the request limit is enforced without a schema change", async () => {
  await withDatabase(async (database) => {
    assert.equal(await reserveGeminiRequest(database, UTC_DATE, 1), true);
    assert.equal(await reserveGeminiRequest(database, UTC_DATE, 1), false);
    assert.equal((await usageRow(database))?.geminiRequestsUsed, 1);
    assert.equal(await admissionCount(database), 0);
  });
});

test("a lowered limit blocks a new reservation when used units are already above it", async () => {
  await withDatabase(async (database) => {
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await reserveGeminiRequest(database, UTC_DATE, 5), true);
    }
    assert.equal(await reserveGeminiRequest(database, UTC_DATE, 3), false);
    assert.equal((await usageRow(database))?.geminiRequestsUsed, 5);
  });
});

test("websites admitted matches the admission count", async () => {
  await withDatabase(async (database) => {
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [1, 2, 3], 10), true);
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [1], 10), false);
    const usage = await usageRow(database);
    assert.equal(usage?.websitesAdmitted, await admissionCount(database));
  });
});

test("overlapping reservations of one evidence id admit it once", async () => {
  await withDatabase(async (database) => {
    const results = await Promise.all([
      reserveWebsiteAnalysisBatch(database, UTC_DATE, [200], 10),
      reserveWebsiteAnalysisBatch(database, UTC_DATE, [200], 10),
    ]);
    assert.deepEqual(results.slice().sort(), [false, true]);
    assert.equal(await admissionCount(database, 200), 1);
    assert.equal((await usageRow(database))?.websitesAdmitted, 1);
    assert.equal((await usageRow(database))?.geminiRequestsUsed, 1);
  });
});

test("a corrupt usage read fails closed", async () => {
  const database: D1WebsiteAnalysisPipelineDatabase = {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        all: () => Promise.resolve({ results: [] }),
        first: () => Promise.resolve({ websites_admitted: "1", gemini_requests_used: 0 }),
        run: () => Promise.resolve({ meta: { changes: 0, last_row_id: 0 } }),
      };
      return statement;
    },
    batch: () => Promise.reject(new Error("unused")),
  };
  await assert.rejects(
    () => readWebsiteAnalysisDailyUsage(database, UTC_DATE),
    (error: unknown) => {
      assert.ok(error instanceof D1WebsiteAnalysisPipelineError);
      assert.equal(error.code, "BUDGET_FAILED");
      return true;
    },
  );
});

test("there is no refund path", async () => {
  await withDatabase(async (database) => {
    assert.equal(await reserveWebsiteAnalysisBatch(database, UTC_DATE, [101], 10), true);
    const first = await readWebsiteAnalysisDailyUsage(database, UTC_DATE);
    const second = await readWebsiteAnalysisDailyUsage(database, UTC_DATE);
    assert.deepEqual(second, first);
  });
  const names = Object.keys(dailyUsage);
  assert.equal(names.some((name) => /refund|release/i.test(name)), false);
});
