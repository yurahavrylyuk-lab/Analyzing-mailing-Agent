import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();

test("crawl workflow schedules 06:17 Europe/Warsaw and has no deploy credentials", () => {
  const workflow = readFileSync(join(root, ".github/workflows/crawl.yml"), "utf8");
  assert.equal(workflow.includes('cron: "17 6 * * *"'), true);
  assert.equal(workflow.includes('timezone: "Europe/Warsaw"'), true);
  for (const required of [
    "workflow_dispatch",
    "contents: read",
    "concurrency:",
    "cancel-in-progress: false",
    "npm ci",
    "npm run crawl:cloud",
    "CRAWL_GATEWAY_URL: ${{ secrets.CRAWL_GATEWAY_URL }}",
    "CRAWL_GATEWAY_TOKEN: ${{ secrets.CRAWL_GATEWAY_TOKEN }}",
    'CRAWL_MAX_ATTEMPTS: "10"',
  ]) {
    assert.equal(workflow.includes(required), true, required);
  }
  for (const absent of ["CLOUDFLARE_API_TOKEN", "docker", "container", "wrangler", "0 6 * * *"]) {
    assert.equal(workflow.includes(absent), false, absent);
  }
});

test("wrangler config binds DB and does not store the gateway token", () => {
  const config = readFileSync(join(root, "wrangler.toml"), "utf8");
  for (const required of [
    'name = "delta-qoralis-crawl-gateway"',
    'main = "src/crawl-gateway/worker.ts"',
    'compatibility_date = "2026-10-22"',
    "nodejs_compat",
    'binding = "DB"',
    'database_name = "delta-qoralis-crawl"',
    'database_id = "REPLACE_BEFORE_DEPLOY"',
  ]) {
    assert.equal(config.includes(required), true, required);
  }
  for (const absent of [
    "no_nodejs_compat",
    "[triggers]",
    "crons",
    "CRAWL_GATEWAY_TOKEN",
    "migrations apply",
  ]) {
    assert.equal(config.includes(absent), false, absent);
  }
});
