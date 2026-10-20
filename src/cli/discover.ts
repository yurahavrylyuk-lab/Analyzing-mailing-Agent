import type { EnvironmentVariables } from "../config/env";
import { runDiscoveryCommand } from "../discovery/command";

export type DiscoveryProcessIO = Readonly<{
  argv: readonly string[];
  env: EnvironmentVariables;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  registerSigint: (handler: () => void) => () => void;
}>;

export async function main(io?: DiscoveryProcessIO): Promise<number> {
  const argv = io?.argv ?? process.argv.slice(2);
  const env = io?.env ?? process.env;
  const stdout = io?.stdout ?? process.stdout;
  const stderr = io?.stderr ?? process.stderr;
  const registerSigint =
    io?.registerSigint ??
    ((handler: () => void) => {
      process.on("SIGINT", handler);
      return () => {
        process.off("SIGINT", handler);
      };
    });

  const controller = new AbortController();
  const unregister = registerSigint(() => {
    controller.abort();
  });
  try {
    const result = await runDiscoveryCommand({
      argv,
      env,
      signal: controller.signal,
    });
    stdout.write(result.stdout);
    stderr.write(result.stderr);
    return result.exitCode;
  } finally {
    unregister();
  }
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
