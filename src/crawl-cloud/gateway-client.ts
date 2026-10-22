import {
  LEAD_STATUSES,
  isBusinessLeadId,
  normalizeWebsiteUrl,
  type BusinessLead,
  type LeadStatus,
  type WebsiteObservation,
} from "../leads/domain";
import type { StoredSinglePageCrawlEvidence } from "../crawler/evidence-domain";
import type { SinglePageCrawlEvidence } from "../crawler/single-page-evidence";
import type { CrawlCloudConfig } from "./config";

export class CrawlGatewayError extends Error {
  readonly name = "CrawlGatewayError";

  constructor() {
    super("Crawl gateway request failed.");
  }
}

export type CrawlGatewayClient = Readonly<{
  select(maxAttempts: number, signal: AbortSignal): Promise<readonly BusinessLead[]>;
  persist(
    evidence: SinglePageCrawlEvidence,
    signal: AbortSignal,
  ): Promise<StoredSinglePageCrawlEvidence>;
}>;

const MANUAL_KEYS = Object.freeze([
  "id",
  "businessName",
  "sourceKind",
  "sourceReference",
  "status",
  "websiteObservation",
  "createdAt",
  "updatedAt",
  "version",
]);

const DISCOVERY_KEYS = Object.freeze([...MANUAL_KEYS, "sourceProvider"]);
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const discoveryProviderPattern = /^[a-z][a-z0-9_]*$/u;

function gatewayFailed(): never {
  throw new CrawlGatewayError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === allowed.length &&
    keys.every((key) => typeof key === "string" && allowed.includes(key))
  );
}

function isLeadStatus(value: unknown): value is LeadStatus {
  for (const status of LEAD_STATUSES) {
    if (value === status) {
      return true;
    }
  }
  return false;
}

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) {
    return false;
  }

  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isTrimmedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function isBoundedText(value: string, maximum: number): boolean {
  const length = unicodeLength(value);
  return length >= 1 && length <= maximum && !controlCharacterPattern.test(value);
}

function decodeWebsiteObservation(value: unknown): WebsiteObservation {
  if (!isRecord(value)) {
    gatewayFailed();
  }

  if (
    (value.presence === "unknown" || value.presence === "missing") &&
    hasExactlyKeys(value, ["presence"])
  ) {
    return Object.freeze({ presence: value.presence });
  }

  if (
    value.presence === "present" &&
    hasExactlyKeys(value, ["presence", "url"]) &&
    typeof value.url === "string"
  ) {
    let normalized: string;
    try {
      normalized = normalizeWebsiteUrl(value.url);
    } catch {
      gatewayFailed();
    }
    if (normalized !== value.url) {
      gatewayFailed();
    }
    return Object.freeze({ presence: "present", url: value.url });
  }

  gatewayFailed();
}

function decodeBusinessLead(value: unknown): BusinessLead {
  if (!isRecord(value)) {
    gatewayFailed();
  }

  const manual = hasExactlyKeys(value, MANUAL_KEYS);
  const discovered = hasExactlyKeys(value, DISCOVERY_KEYS);
  if (manual) {
    if (value.sourceKind !== "manual") {
      gatewayFailed();
    }
  } else if (discovered) {
    if (value.sourceKind !== "discovery") {
      gatewayFailed();
    }
  } else {
    gatewayFailed();
  }

  if (
    !isBusinessLeadId(value.id) ||
    !isTrimmedText(value.businessName) ||
    !isTrimmedText(value.sourceReference) ||
    !isLeadStatus(value.status) ||
    !isCanonicalTimestamp(value.createdAt) ||
    !isCanonicalTimestamp(value.updatedAt) ||
    !isVersion(value.version)
  ) {
    gatewayFailed();
  }

  const websiteObservation = decodeWebsiteObservation(value.websiteObservation);
  const common = {
    id: value.id,
    businessName: value.businessName,
    sourceReference: value.sourceReference,
    status: value.status,
    websiteObservation,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: value.version,
  };

  if (manual) {
    return Object.freeze({
      ...common,
      sourceKind: "manual",
    });
  }

  if (
    typeof value.sourceProvider !== "string" ||
    !discoveryProviderPattern.test(value.sourceProvider) ||
    !isBoundedText(value.sourceProvider, 64) ||
    !isBoundedText(value.businessName, 300) ||
    !isBoundedText(value.sourceReference, 512)
  ) {
    gatewayFailed();
  }

  return Object.freeze({
    ...common,
    sourceKind: "discovery",
    sourceProvider: value.sourceProvider,
  });
}

function decodeBusinessLeadSnapshots(input: unknown): readonly BusinessLead[] {
  if (!Array.isArray(input)) {
    gatewayFailed();
  }

  const leads: BusinessLead[] = [];
  for (const element of input) {
    leads.push(decodeBusinessLead(element));
  }
  return Object.freeze(leads);
}

async function postJson(
  config: CrawlCloudConfig,
  fetchImpl: typeof fetch,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(new URL(path, config.gatewayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new CrawlGatewayError();
  }

  if (!response.ok) {
    throw new CrawlGatewayError();
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new CrawlGatewayError();
  }
}

function persistedBody(value: unknown): boolean {
  return isRecord(value) && hasExactlyKeys(value, ["persisted"]) && value.persisted === true;
}

export function createCrawlGatewayClient(
  config: CrawlCloudConfig,
  fetchImpl: typeof fetch,
): CrawlGatewayClient {
  return Object.freeze({
    async select(maxAttempts: number, signal: AbortSignal): Promise<readonly BusinessLead[]> {
      const parsed = await postJson(
        config,
        fetchImpl,
        "/internal/crawl/select",
        { maxAttempts },
        signal,
      );
      if (!isRecord(parsed) || !hasExactlyKeys(parsed, ["candidates"])) {
        throw new CrawlGatewayError();
      }
      return decodeBusinessLeadSnapshots(parsed.candidates);
    },
    async persist(
      evidence: SinglePageCrawlEvidence,
      signal: AbortSignal,
    ): Promise<StoredSinglePageCrawlEvidence> {
      const parsed = await postJson(
        config,
        fetchImpl,
        "/internal/crawl/evidence",
        evidence,
        signal,
      );
      if (!persistedBody(parsed)) {
        throw new CrawlGatewayError();
      }
      return evidence as StoredSinglePageCrawlEvidence;
    },
  });
}
