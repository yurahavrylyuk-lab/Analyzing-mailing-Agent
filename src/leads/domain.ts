import {
  InvalidDiscoveredLeadInputError,
  InvalidLeadInputError,
  InvalidLeadTransitionError,
} from "./errors";

export const LEAD_STATUSES = ["recorded", "reviewing", "archived"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type WebsiteObservation =
  | Readonly<{ presence: "unknown" }>
  | Readonly<{ presence: "missing" }>
  | Readonly<{ presence: "present"; url: string }>;

interface BusinessLeadCommon {
  readonly id: string;
  readonly businessName: string;
  readonly sourceReference: string;
  readonly status: LeadStatus;
  readonly websiteObservation: WebsiteObservation;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ManualBusinessLead extends BusinessLeadCommon {
  readonly sourceKind: "manual";
}

export interface DiscoveredBusinessLead extends BusinessLeadCommon {
  readonly sourceKind: "discovery";
  readonly sourceProvider: string;
}

export type BusinessLead = ManualBusinessLead | DiscoveredBusinessLead;

export interface CreateLeadInput {
  readonly businessName: string;
  readonly sourceKind: "manual";
  readonly sourceReference: string;
  readonly websiteObservation: WebsiteObservation;
}

export interface RecordDiscoveredLeadInput {
  readonly provider: string;
  readonly providerReference: string;
  readonly businessName: string;
  readonly websiteObservation:
    | Readonly<{ presence: "unknown" }>
    | Readonly<{ presence: "present"; url: string }>;
}

export interface RecordDiscoveredLeadResult {
  readonly lead: DiscoveredBusinessLead;
  readonly created: boolean;
}

const allowedTransitions: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  recorded: ["reviewing", "archived"],
  reviewing: ["archived"],
  archived: ["reviewing"],
};

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const discoveryProviderPattern = /^[a-z][a-z0-9_]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function unicodeLength(value: string): number {
  return [...value].length;
}

export function isBusinessLeadId(value: unknown): value is string {
  return typeof value === "string" && uuidV4Pattern.test(value);
}

function normalizeRequiredText(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidLeadInputError(`${fieldName} must be nonempty text.`);
  }

  return value.trim();
}

export function normalizeWebsiteUrl(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidLeadInputError("Website URL must be a nonempty absolute URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new InvalidLeadInputError("Website URL must be a valid absolute URL.");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new InvalidLeadInputError(
      "Website URL must use HTTP or HTTPS, include a hostname, and contain no credentials.",
    );
  }

  return parsed.toString();
}

export function normalizeWebsiteObservation(
  observation: WebsiteObservation,
): WebsiteObservation {
  if (typeof observation !== "object" || observation === null) {
    throw new InvalidLeadInputError("Website observation is required.");
  }

  if (observation.presence === "present") {
    return Object.freeze({
      presence: "present",
      url: normalizeWebsiteUrl(observation.url),
    });
  }

  if (observation.presence === "unknown" || observation.presence === "missing") {
    const unexpectedUrl = (observation as { readonly url?: unknown }).url;
    if (unexpectedUrl !== undefined && unexpectedUrl !== null) {
      throw new InvalidLeadInputError(
        "Website URL must be absent when website presence is unknown or missing.",
      );
    }

    return Object.freeze({ presence: observation.presence });
  }

  throw new InvalidLeadInputError("Website presence is invalid.");
}

export function createBusinessLead(
  input: CreateLeadInput,
  id: string,
  now: Date,
): BusinessLead {
  if (!isBusinessLeadId(id)) {
    throw new InvalidLeadInputError("Generated business lead ID must be a UUID v4.");
  }

  if (input.sourceKind !== "manual") {
    throw new InvalidLeadInputError("Source kind must be manual.");
  }

  if ("sourceProvider" in (input as unknown as Record<string, unknown>)) {
    throw new InvalidLeadInputError("Manual lead input must not include a source provider.");
  }

  const timestamp = toUtcIso(now);
  const lead: BusinessLead = {
    id,
    businessName: normalizeRequiredText(input.businessName, "Business name"),
    sourceKind: "manual",
    sourceReference: normalizeRequiredText(input.sourceReference, "Source reference"),
    status: "recorded",
    websiteObservation: normalizeWebsiteObservation(input.websiteObservation),
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  };

  return Object.freeze(lead);
}

export function normalizeRecordDiscoveredLeadInput(
  input: unknown,
): RecordDiscoveredLeadInput {
  if (
    !isRecord(input) ||
    !hasExactlyKeys(input, [
      "provider",
      "providerReference",
      "businessName",
      "websiteObservation",
    ]) ||
    typeof input.provider !== "string" ||
    unicodeLength(input.provider) < 1 ||
    unicodeLength(input.provider) > 64 ||
    !discoveryProviderPattern.test(input.provider) ||
    typeof input.providerReference !== "string" ||
    unicodeLength(input.providerReference) < 1 ||
    unicodeLength(input.providerReference) > 512 ||
    input.providerReference !== input.providerReference.trim() ||
    controlCharacterPattern.test(input.providerReference) ||
    typeof input.businessName !== "string" ||
    controlCharacterPattern.test(input.businessName)
  ) {
    throw new InvalidDiscoveredLeadInputError();
  }

  const businessName = input.businessName.trim();
  if (unicodeLength(businessName) < 1 || unicodeLength(businessName) > 300) {
    throw new InvalidDiscoveredLeadInputError();
  }

  if (!isRecord(input.websiteObservation)) {
    throw new InvalidDiscoveredLeadInputError();
  }
  const observation = input.websiteObservation;
  let websiteObservation: RecordDiscoveredLeadInput["websiteObservation"];
  if (
    observation.presence === "unknown" &&
    hasExactlyKeys(observation, ["presence"])
  ) {
    websiteObservation = Object.freeze({ presence: "unknown" });
  } else if (
    observation.presence === "present" &&
    hasExactlyKeys(observation, ["presence", "url"]) &&
    typeof observation.url === "string"
  ) {
    try {
      websiteObservation = Object.freeze({
        presence: "present",
        url: normalizeWebsiteUrl(observation.url),
      });
    } catch {
      throw new InvalidDiscoveredLeadInputError();
    }
  } else {
    throw new InvalidDiscoveredLeadInputError();
  }

  return Object.freeze({
    provider: input.provider,
    providerReference: input.providerReference,
    businessName,
    websiteObservation,
  });
}

export function createDiscoveredBusinessLead(
  input: RecordDiscoveredLeadInput,
  id: string,
  now: Date,
): DiscoveredBusinessLead {
  const normalized = normalizeRecordDiscoveredLeadInput(input);
  if (!isBusinessLeadId(id)) {
    throw new InvalidDiscoveredLeadInputError();
  }
  let timestamp: string;
  try {
    timestamp = toUtcIso(now);
  } catch {
    throw new InvalidDiscoveredLeadInputError();
  }

  return Object.freeze({
    id,
    businessName: normalized.businessName,
    sourceKind: "discovery",
    sourceProvider: normalized.provider,
    sourceReference: normalized.providerReference,
    status: "recorded",
    websiteObservation: normalized.websiteObservation,
    createdAt: timestamp,
    updatedAt: timestamp,
    version: 1,
  });
}

export function toUtcIso(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InvalidLeadInputError("Clock must return a valid date.");
  }

  return value.toISOString();
}

export function validateExpectedVersion(expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new InvalidLeadInputError("Expected version must be a positive integer.");
  }
}

export function validateLifecycleTransition(
  currentStatus: LeadStatus,
  targetStatus: LeadStatus,
): boolean {
  if (!LEAD_STATUSES.includes(targetStatus)) {
    throw new InvalidLeadInputError("Target lifecycle status is invalid.");
  }

  if (currentStatus === targetStatus) {
    return false;
  }

  if (!allowedTransitions[currentStatus].includes(targetStatus)) {
    throw new InvalidLeadTransitionError(currentStatus, targetStatus);
  }

  return true;
}

export function websiteObservationsEqual(
  first: WebsiteObservation,
  second: WebsiteObservation,
): boolean {
  return (
    first.presence === second.presence &&
    (first.presence !== "present" ||
      (second.presence === "present" && first.url === second.url))
  );
}
