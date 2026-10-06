import { normalizeWebsiteUrl, type WebsiteObservation } from "../leads";
import {
  InvalidDiscoveryCriteriaError,
  MalformedDiscoveryResponseError,
} from "./errors";

export const DEFAULT_DISCOVERY_MAX_RESULTS = 20;
export const MIN_DISCOVERY_MAX_RESULTS = 1;
export const MAX_DISCOVERY_MAX_RESULTS = 60;
export const MAX_DISCOVERY_TEXT_CHARACTERS = 200;
export const MAX_PROVIDER_ID_CHARACTERS = 64;
export const MAX_PROVIDER_REFERENCE_CHARACTERS = 512;
export const MAX_DISCOVERY_BUSINESS_NAME_CHARACTERS = 300;

export type DiscoveryCriteriaInput = Readonly<{
  location: string;
  query: string;
  maxResults?: number;
}>;

export type DiscoveryCriteria = Readonly<{
  location: string;
  query: string;
  /** Maximum provider result slots examined, not a promised lead count. */
  maxResults: number;
}>;

export type DiscoveryCandidateInput = Readonly<{
  provider: string;
  providerReference: string;
  businessName: string;
  websiteUrl?: string | null;
}>;

export type DiscoveryCandidate = Readonly<{
  provider: string;
  providerReference: string;
  businessName: string;
  websiteObservation: Extract<WebsiteObservation, { presence: "unknown" | "present" }>;
}>;

export const DISCOVERY_CANDIDATE_REJECTION_CODES = [
  "invalid_reference",
  "invalid_business_name",
] as const;
export type DiscoveryCandidateRejectionCode =
  (typeof DISCOVERY_CANDIDATE_REJECTION_CODES)[number];

export const DISCOVERY_CANDIDATE_WARNING_CODES = ["invalid_website"] as const;
export type DiscoveryCandidateWarningCode =
  (typeof DISCOVERY_CANDIDATE_WARNING_CODES)[number];

export type DiscoveryCandidateOutcome =
  | Readonly<{
      status: "accepted";
      candidate: DiscoveryCandidate;
      warnings: readonly DiscoveryCandidateWarningCode[];
    }>
  | Readonly<{
      status: "rejected";
      code: DiscoveryCandidateRejectionCode;
    }>;

type AcceptedDiscoveryCandidateOutcome = Extract<
  DiscoveryCandidateOutcome,
  { status: "accepted" }
>;

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const providerIdPattern = /^[a-z][a-z0-9_]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function characterLength(value: string): number {
  return [...value].length;
}

function normalizeCriteriaText(value: unknown): string {
  if (typeof value !== "string" || controlCharacterPattern.test(value)) {
    throw new InvalidDiscoveryCriteriaError();
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    characterLength(normalized) > MAX_DISCOVERY_TEXT_CHARACTERS
  ) {
    throw new InvalidDiscoveryCriteriaError();
  }
  return normalized;
}

export function normalizeDiscoveryCriteria(input: unknown): DiscoveryCriteria {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["location", "query", "maxResults"]) ||
    !("location" in input) ||
    !("query" in input)
  ) {
    throw new InvalidDiscoveryCriteriaError();
  }

  const maxResults =
    input.maxResults === undefined ? DEFAULT_DISCOVERY_MAX_RESULTS : input.maxResults;
  if (
    typeof maxResults !== "number" ||
    !Number.isInteger(maxResults) ||
    maxResults < MIN_DISCOVERY_MAX_RESULTS ||
    maxResults > MAX_DISCOVERY_MAX_RESULTS
  ) {
    throw new InvalidDiscoveryCriteriaError();
  }

  return Object.freeze({
    location: normalizeCriteriaText(input.location),
    query: normalizeCriteriaText(input.query),
    maxResults,
  });
}

export function normalizeDiscoveryProviderId(input: unknown): string {
  if (
    typeof input !== "string" ||
    characterLength(input) > MAX_PROVIDER_ID_CHARACTERS ||
    !providerIdPattern.test(input)
  ) {
    throw new MalformedDiscoveryResponseError();
  }
  return input;
}

function isValidProviderReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !controlCharacterPattern.test(value) &&
    characterLength(value) <= MAX_PROVIDER_REFERENCE_CHARACTERS
  );
}

function normalizeBusinessName(value: unknown): string | undefined {
  if (typeof value !== "string" || controlCharacterPattern.test(value)) {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    characterLength(normalized) > MAX_DISCOVERY_BUSINESS_NAME_CHARACTERS
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeCandidateWebsite(value: unknown): Readonly<{
  observation: DiscoveryCandidate["websiteObservation"];
  warnings: readonly DiscoveryCandidateWarningCode[];
}> {
  if (value === undefined || value === null) {
    return Object.freeze({
      observation: Object.freeze({ presence: "unknown" }),
      warnings: Object.freeze([] as DiscoveryCandidateWarningCode[]),
    });
  }

  try {
    const url = normalizeWebsiteUrl(value as string);
    return Object.freeze({
      observation: Object.freeze({ presence: "present", url }),
      warnings: Object.freeze([] as DiscoveryCandidateWarningCode[]),
    });
  } catch {
    return Object.freeze({
      observation: Object.freeze({ presence: "unknown" }),
      warnings: Object.freeze(["invalid_website"] as DiscoveryCandidateWarningCode[]),
    });
  }
}

export function normalizeDiscoveryCandidate(
  input: unknown,
): DiscoveryCandidateOutcome {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["provider", "providerReference", "businessName", "websiteUrl"]) ||
    !("provider" in input) ||
    !("providerReference" in input) ||
    !("businessName" in input)
  ) {
    throw new MalformedDiscoveryResponseError();
  }

  const provider = normalizeDiscoveryProviderId(input.provider);
  if (!isValidProviderReference(input.providerReference)) {
    return Object.freeze({ status: "rejected", code: "invalid_reference" });
  }

  const businessName = normalizeBusinessName(input.businessName);
  if (businessName === undefined) {
    return Object.freeze({ status: "rejected", code: "invalid_business_name" });
  }

  const website = normalizeCandidateWebsite(input.websiteUrl);
  return Object.freeze({
    status: "accepted",
    candidate: Object.freeze({
      provider,
      providerReference: input.providerReference,
      businessName,
      websiteObservation: website.observation,
    }),
    warnings: website.warnings,
  });
}

function normalizeAcceptedCandidate(
  value: unknown,
  expectedProvider: string,
): AcceptedDiscoveryCandidateOutcome {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["provider", "providerReference", "businessName", "websiteObservation"]) ||
    !("websiteObservation" in value) ||
    !isRecord(value.websiteObservation)
  ) {
    throw new MalformedDiscoveryResponseError();
  }

  const observation = value.websiteObservation;
  if (!hasOnlyKeys(observation, ["presence", "url"])) {
    throw new MalformedDiscoveryResponseError();
  }
  let websiteUrl: string | undefined;
  if (observation.presence === "present" && typeof observation.url === "string") {
    websiteUrl = observation.url;
  } else if (observation.presence !== "unknown" || "url" in observation) {
    throw new MalformedDiscoveryResponseError();
  }

  const normalized = normalizeDiscoveryCandidate({
    provider: value.provider,
    providerReference: value.providerReference,
    businessName: value.businessName,
    websiteUrl,
  });
  if (
    normalized.status !== "accepted" ||
    normalized.candidate.provider !== expectedProvider ||
    normalized.warnings.length > 0
  ) {
    throw new MalformedDiscoveryResponseError();
  }
  return normalized;
}

export function normalizeDiscoveryOutcome(
  input: unknown,
  expectedProvider: string,
): DiscoveryCandidateOutcome {
  if (!isRecord(input) || typeof input.status !== "string") {
    throw new MalformedDiscoveryResponseError();
  }

  if (input.status === "rejected") {
    if (
      !hasOnlyKeys(input, ["status", "code"]) ||
      !DISCOVERY_CANDIDATE_REJECTION_CODES.includes(
        input.code as DiscoveryCandidateRejectionCode,
      )
    ) {
      throw new MalformedDiscoveryResponseError();
    }
    return Object.freeze({
      status: "rejected",
      code: input.code as DiscoveryCandidateRejectionCode,
    });
  }

  if (
    input.status !== "accepted" ||
    !hasOnlyKeys(input, ["status", "candidate", "warnings"]) ||
    !Array.isArray(input.warnings) ||
    input.warnings.some(
      (warning) =>
        !DISCOVERY_CANDIDATE_WARNING_CODES.includes(
          warning as DiscoveryCandidateWarningCode,
        ),
    ) ||
    new Set(input.warnings).size !== input.warnings.length
  ) {
    throw new MalformedDiscoveryResponseError();
  }

  const normalized = normalizeAcceptedCandidate(input.candidate, expectedProvider);
  return Object.freeze({
    status: "accepted",
    candidate: normalized.candidate,
    warnings: Object.freeze([...input.warnings] as DiscoveryCandidateWarningCode[]),
  });
}
