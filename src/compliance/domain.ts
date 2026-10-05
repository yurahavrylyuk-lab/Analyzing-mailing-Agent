import type { AuditActor } from "../audit";
import { isBusinessLeadId } from "../leads";
import { InvalidSuppressionInputError } from "./errors";

export const SUPPRESSION_REASON_CODES = ["manual", "requested"] as const;
export type SuppressionReasonCode = (typeof SUPPRESSION_REASON_CODES)[number];

export type LeadContactSuppression = Readonly<{
  leadId: string;
  reasonCode: SuppressionReasonCode;
  appliedAt: string;
  appliedBy: AuditActor;
}>;

export type ApplySuppressionResult = Readonly<{
  suppression: LeadContactSuppression;
  changed: boolean;
}>;

export type SuppressionState =
  | Readonly<{ state: "not_suppressed"; leadId: string }>
  | Readonly<{ state: "suppressed"; suppression: LeadContactSuppression }>;

export function normalizeSuppressionLeadId(value: unknown): string {
  if (!isBusinessLeadId(value)) {
    throw new InvalidSuppressionInputError();
  }
  return value;
}

export function normalizeSuppressionReason(
  value: unknown,
): SuppressionReasonCode {
  if (value !== "manual" && value !== "requested") {
    throw new InvalidSuppressionInputError();
  }
  return value;
}

export function normalizeSuppressionTimestamp(value: unknown): string {
  if (typeof value !== "string") {
    throw new InvalidSuppressionInputError();
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new InvalidSuppressionInputError();
  }
  return value;
}
