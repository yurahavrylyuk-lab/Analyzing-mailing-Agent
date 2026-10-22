export type CrawlCloudConfig = Readonly<{
  gatewayUrl: string;
  token: string;
  maxAttempts: number;
}>;

export class CrawlCloudConfigurationError extends Error {
  readonly name = "CrawlCloudConfigurationError";

  constructor() {
    super("Crawl gateway configuration is invalid.");
  }
}

const tokenPattern = /[\s\u0000-\u001f\u007f-\u009f]/u;
const attemptPattern = /^(?:[1-9]|[1-5][0-9]|60)$/;

function invalidConfiguration(): never {
  throw new CrawlCloudConfigurationError();
}

function parseGatewayUrl(value: string | undefined): string {
  if (typeof value !== "string") {
    invalidConfiguration();
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalidConfiguration();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    invalidConfiguration();
  }

  return value;
}

function parseToken(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0 || tokenPattern.test(value)) {
    invalidConfiguration();
  }

  return value;
}

function parseMaxAttempts(value: string | undefined): number {
  if (value === undefined) {
    return 10;
  }

  if (!attemptPattern.test(value)) {
    invalidConfiguration();
  }

  return Number(value);
}

export function loadCrawlCloudConfig(
  environment: Readonly<Record<string, string | undefined>>,
): CrawlCloudConfig {
  return Object.freeze({
    gatewayUrl: parseGatewayUrl(environment.CRAWL_GATEWAY_URL),
    token: parseToken(environment.CRAWL_GATEWAY_TOKEN),
    maxAttempts: parseMaxAttempts(environment.CRAWL_MAX_ATTEMPTS),
  });
}
