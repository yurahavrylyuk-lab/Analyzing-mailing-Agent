const { rmSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = resolve(__dirname, "..");
const buildDirectory = resolve(projectRoot, ".test-build");
const testFile = resolve(buildDirectory, "tests/unit/config-env.test.js");

function runNode(arguments_) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

let exitCode = 0;

try {
  rmSync(buildDirectory, { force: true, recursive: true });
  exitCode = runNode([
    require.resolve("typescript/bin/tsc"),
    "--noEmit",
    "false",
    "--outDir",
    buildDirectory,
  ]);

  if (exitCode === 0) {
    exitCode = runNode(["--test", testFile]);
  }
} finally {
  rmSync(buildDirectory, { force: true, recursive: true });
}

process.exitCode = exitCode;
