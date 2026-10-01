const { readdirSync, rmSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = resolve(__dirname, "..");
const buildDirectory = resolve(projectRoot, ".test-build");

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

function findTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((first, second) => first.name.localeCompare(second.name))
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        return findTestFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".test.js") ? [entryPath] : [];
    });
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
    const testFiles = findTestFiles(resolve(buildDirectory, "tests"));

    if (testFiles.length === 0) {
      throw new Error("No compiled test files were found.");
    }

    exitCode = runNode(["--test", ...testFiles]);
  }
} finally {
  rmSync(buildDirectory, { force: true, recursive: true });
}

process.exitCode = exitCode;
