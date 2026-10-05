import { InvalidLeadInputError, InvalidLeadTransitionError } from "./errors";

export const LEAD_STATUSES = ["recorded", "reviewing", "archived"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type WebsiteObservation =
  | Readonly<{ presence: "unknown" }>
  | Readonly<{ presence: "missing" }>
  | Readonly<{ presence: "present"; url: string }>;

export interface BusinessLead {
  readonly id: string;
  readonly businessName: string;
  readonly sourceKind: "manual";
  readonly sourceReference: string;
  readonly status: LeadStatus;
  readonly websiteObservation: WebsiteObservation;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface CreateLeadInput {
  readonly businessName: string;
  readonly sourceKind: "manual";
  readonly sourceReference: string;
  readonly websiteObservation: WebsiteObservation;
}

const allowedTransitions: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  recorded: ["reviewing", "archived"],
  reviewing: ["archived"],
  archived: ["reviewing"],
};

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
