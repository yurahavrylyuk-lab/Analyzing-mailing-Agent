import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const HELP_TEXT = `Usage:
  npm run discover -- --location <location> --query <query> --actor <id> [--max-results <count>]
  npm run discover -- --help
  npm run discover -- -h

Options:
  --location <location>     Required city text. Passed to discovery criteria.
  --query <query>           Required query text. Passed to discovery criteria.
  --actor <id>              Required claimed human actor id.
  --max-results <count>     Optional examined-slot budget. Integer 1-60. Default 20.
  --help, -h                Show this help and exit.

Discovery stays disabled unless DISCOVERY_PROVIDER=geoapify and GEOAPIFY_API_KEY are set in the environment. This command does not read a .env file.

© OpenStreetMap contributors
Powered by Geoapify
`;

test("npm run discover help and usage stay offline and remove the command build", () => {
  const root = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "dq-015-process-"));
  const databasePath = join(directory, "not-created.sqlite");
  const buildDirectory = join(root, ".command-build");
  const env = {
    PATH: process.env.PATH ?? "",
    NODE_ENV: "test",
    DATABASE_URL: `file:${databasePath}`,
    DISCOVERY_PROVIDER: "sentinel-provider",
    GEOAPIFY_API_KEY: "sentinel-geoapify-key",
  };
  assert.equal(databasePath.startsWith(join(root, "src")), false);
  assert.equal(existsSync(databasePath), false);

  try {
    const help = spawnSync("npm", ["run", "--silent", "discover", "--", "--help"], {
      cwd: root,
      env,
      shell: false,
    });
    assert.equal(help.status, 0);
    assert.equal(help.stdout.toString(), HELP_TEXT);
    assert.equal(help.stderr.toString(), "");
    assert.equal(help.stdout.toString().includes("sentinel-provider"), false);
    assert.equal(help.stdout.toString().includes("sentinel-geoapify-key"), false);
    assert.equal(help.stderr.toString().includes("sentinel-provider"), false);
    assert.equal(help.stderr.toString().includes("sentinel-geoapify-key"), false);
    assert.match(help.stdout.toString(), /© OpenStreetMap contributors\nPowered by Geoapify\n$/);
    assert.match(help.stdout.toString(), /does not read a \.env file/);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(buildDirectory), false);

    const usage = spawnSync("npm", ["run", "--silent", "discover", "--", "--location"], {
      cwd: root,
      env,
      shell: false,
    });
    const usageText = `${usage.stdout?.toString() ?? ""}\n${usage.stderr?.toString() ?? ""}`;
    assert.equal(usage.status, 2);
    assert.equal(usageText.includes("sentinel-provider"), false);
    assert.equal(usageText.includes("sentinel-geoapify-key"), false);
    assert.equal(existsSync(databasePath), false);
    assert.equal(existsSync(buildDirectory), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
