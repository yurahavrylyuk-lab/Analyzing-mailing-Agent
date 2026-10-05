import type { LeadStatus, WebsiteObservation } from "../leads/domain";
import {
  InvalidAuditActorError,
  InvalidAuditEventError,
  OversizedAuditDetailsError,
} from "./errors";

export type AuditActor = Readonly<{
  type: "human" | "system";
  id: string;
}>;

export type LeadCreatedDetails = Readonly<{
  initialStatus: LeadStatus;
  initialWebsitePresence: WebsiteObservation["presence"];
  version: number;
}>;

export type LeadStatusChangedDetails = Readonly<{
  previousStatus: LeadStatus;
  newStatus: LeadStatus;
  version: number;
}>;

export type LeadWebsiteObservationChangedDetails = Readonly<{
  previousPresence: WebsiteObservation["presence"];
  newPresence: WebsiteObservation["presence"];
  urlChanged: boolean;
  version: number;
}>;

export type LeadDoNotContactAppliedDetails = Readonly<{
  reasonCode: "manual" | "requested";
}>;

type AuditEventBase = Readonly<{
  occurredAt: string;
  entityType: "business_lead";
  entityId: string;
  actor: AuditActor;
}>;

export type AuditEventInput = AuditEventBase &
  (
    | Readonly<{ eventType: "lead.created"; details: LeadCreatedDetails }>
    | Readonly<{
        eventType: "lead.status_changed";
        details: LeadStatusChangedDetails;
      }>
    | Readonly<{
        eventType: "lead.website_observation_changed";
        details: LeadWebsiteObservationChangedDetails;
      }>
    | Readonly<{
        eventType: "lead.do_not_contact_applied";
        details: LeadDoNotContactAppliedDetails;
      }>
  );

export type AuditEvent = AuditEventInput & Readonly<{ id: number }>;

export const MAX_AUDIT_DETAILS_BYTES = 2048;

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const leadStatuses: readonly LeadStatus[] = ["recorded", "reviewing", "archived"];
const websitePresences: readonly WebsiteObservation["presence"][] = [
  "unknown",
  "present",
  "missing",
];

function hasExactKeys(value: object, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    [...expectedKeys].sort().every((key, index) => actualKeys[index] === key)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function serializeDetails(details: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(details);
  } catch {
    throw new InvalidAuditEventError();
  }

  if (serialized === undefined) {
    throw new InvalidAuditEventError();
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_DETAILS_BYTES) {
    throw new OversizedAuditDetailsError();
  }

  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    throw new InvalidAuditEventError();
  }

  return serialized;
}

export function normalizeAuditActor(actor: AuditActor): AuditActor {
  if (
    typeof actor !== "object" ||
    actor === null ||
    (actor.type !== "human" && actor.type !== "system") ||
    typeof actor.id !== "string" ||
    controlCharacterPattern.test(actor.id)
  ) {
    throw new InvalidAuditActorError();
  }

  const id = actor.id.trim();
  if (id.length === 0 || [...id].length > 128) {
    throw new InvalidAuditActorError();
  }

  return Object.freeze({ type: actor.type, id });
}

function normalizeDetails(input: AuditEventInput): AuditEventInput["details"] {
  const serialized = serializeDetails(input.details);
  const details = JSON.parse(serialized) as Record<string, unknown>;

  if (input.eventType === "lead.created") {
    if (
      !hasExactKeys(details, ["initialStatus", "initialWebsitePresence", "version"]) ||
      !leadStatuses.includes(details.initialStatus as LeadStatus) ||
      !websitePresences.includes(
        details.initialWebsitePresence as WebsiteObservation["presence"],
      ) ||
      !isPositiveInteger(details.version)
    ) {
      throw new InvalidAuditEventError();
    }

    return Object.freeze({
      initialStatus: details.initialStatus as LeadStatus,
      initialWebsitePresence:
        details.initialWebsitePresence as WebsiteObservation["presence"],
      version: details.version,
    });
  }

  if (input.eventType === "lead.status_changed") {
    if (
      !hasExactKeys(details, ["previousStatus", "newStatus", "version"]) ||
      !leadStatuses.includes(details.previousStatus as LeadStatus) ||
      !leadStatuses.includes(details.newStatus as LeadStatus) ||
      !isPositiveInteger(details.version)
    ) {
      throw new InvalidAuditEventError();
    }

    return Object.freeze({
      previousStatus: details.previousStatus as LeadStatus,
      newStatus: details.newStatus as LeadStatus,
      version: details.version,
    });
  }

  if (input.eventType === "lead.website_observation_changed") {
    if (
      !hasExactKeys(details, ["previousPresence", "newPresence", "urlChanged", "version"]) ||
      !websitePresences.includes(
        details.previousPresence as WebsiteObservation["presence"],
      ) ||
      !websitePresences.includes(details.newPresence as WebsiteObservation["presence"]) ||
      typeof details.urlChanged !== "boolean" ||
      !isPositiveInteger(details.version)
    ) {
      throw new InvalidAuditEventError();
    }

    return Object.freeze({
      previousPresence: details.previousPresence as WebsiteObservation["presence"],
      newPresence: details.newPresence as WebsiteObservation["presence"],
      urlChanged: details.urlChanged,
      version: details.version,
    });
  }

  if (input.eventType === "lead.do_not_contact_applied") {
    if (
      !hasExactKeys(details, ["reasonCode"]) ||
      (details.reasonCode !== "manual" && details.reasonCode !== "requested")
    ) {
      throw new InvalidAuditEventError();
    }

    return Object.freeze({ reasonCode: details.reasonCode });
  }

  throw new InvalidAuditEventError();
}

export function normalizeAuditEventInput(input: AuditEventInput): AuditEventInput {
  if (
    typeof input !== "object" ||
    input === null ||
    input.entityType !== "business_lead" ||
    typeof input.entityId !== "string" ||
    input.entityId.trim().length === 0 ||
    typeof input.occurredAt !== "string"
  ) {
    throw new InvalidAuditEventError();
  }

  const occurredAt = new Date(input.occurredAt);
  if (
    Number.isNaN(occurredAt.getTime()) ||
    occurredAt.toISOString() !== input.occurredAt
  ) {
    throw new InvalidAuditEventError();
  }

  const actor = normalizeAuditActor(input.actor);
  const details = normalizeDetails(input);
  return Object.freeze({
    occurredAt: input.occurredAt,
    eventType: input.eventType,
    entityType: "business_lead",
    entityId: input.entityId.trim(),
    actor,
    details,
  } as AuditEventInput);
}
