const { rmSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = resolve(__dirname, "..");
const buildDirectory = resolve(projectRoot, ".command-build");

function removeBuildDirectory() {
  rmSync(buildDirectory, { force: true, recursive: true });
}

function ignoreParentSigint() {}

let exitCode = 1;

try {
  removeBuildDirectory();

  const compiler = spawnSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "--noEmit",
      "false",
      "--outDir",
      buildDirectory,
    ],
    {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
      detached: false,
    },
  );

  if (compiler.error) {
    throw compiler.error;
  }

  if (compiler.status !== 0) {
    exitCode = typeof compiler.status === "number" ? compiler.status : 1;
  } else {
    const entrypoint = resolve(buildDirectory, "src/cli/discover.js");
    process.on("SIGINT", ignoreParentSigint);
    let child;
    try {
      child = spawnSync(
        process.execPath,
        [entrypoint, ...process.argv.slice(2)],
        {
          cwd: projectRoot,
          stdio: "inherit",
          shell: false,
          detached: false,
        },
      );
    } finally {
      process.off("SIGINT", ignoreParentSigint);
    }

    if (child.error) {
      throw child.error;
    }

    if (typeof child.status === "number") {
      exitCode = child.status;
    } else if (child.signal === "SIGINT") {
      exitCode = 130;
    } else {
      exitCode = 1;
    }
  }
} catch {
  exitCode = 1;
} finally {
  removeBuildDirectory();
}

process.exitCode = exitCode;
