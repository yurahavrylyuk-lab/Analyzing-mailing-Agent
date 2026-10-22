import {
  runCrawlCloudCommand,
  type CrawlCloudCommandDependencies,
} from "../crawl-cloud/command";

export type CrawlCloudProcessIO = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  registerSigint: (handler: () => void) => () => void;
  fetchImpl?: typeof fetch;
  collect?: CrawlCloudCommandDependencies["collect"];
}>;

export async function main(io?: CrawlCloudProcessIO): Promise<number> {
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
    const result = await runCrawlCloudCommand(
      {
        env,
        signal: controller.signal,
      },
      {
        fetchImpl: io?.fetchImpl,
        collect: io?.collect,
      },
    );
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
