import {
  DatabaseAuditRepository,
  normalizeAuditActor,
  type AuditActor,
} from "../audit";
import type { Database } from "../db";
import { DatabaseLeadRepository, LeadNotFoundError } from "../leads";
import { DatabaseSuppressionRepository } from "./database-suppression-repository";
import {
  normalizeSuppressionLeadId,
  normalizeSuppressionReason,
  normalizeSuppressionTimestamp,
  type ApplySuppressionResult,
  type LeadContactSuppression,
  type SuppressionReasonCode,
  type SuppressionState,
} from "./domain";
import {
  ContactBlockedError,
  ContactProtectionUnavailableError,
  InvalidSuppressionInputError,
} from "./errors";

export interface DoNotContactServiceOptions {
  readonly clock?: () => Date;
}

export class DoNotContactService {
  private readonly suppressions: DatabaseSuppressionRepository;
  private readonly leads: DatabaseLeadRepository;
  private readonly audits: DatabaseAuditRepository;
  private readonly clock: () => Date;

  constructor(
    private readonly database: Database,
    options: DoNotContactServiceOptions = {},
  ) {
    this.suppressions = new DatabaseSuppressionRepository(database);
    this.leads = new DatabaseLeadRepository(database);
    this.audits = new DatabaseAuditRepository(database);
    this.clock = options.clock ?? (() => new Date());
  }

  applySuppression(
    leadIdInput: unknown,
    reasonCodeInput: unknown,
    actorInput: AuditActor,
  ): ApplySuppressionResult {
    const leadId = normalizeSuppressionLeadId(leadIdInput);
    const reasonCode = normalizeSuppressionReason(reasonCodeInput);
    const actor = normalizeAuditActor(actorInput);

    try {
      return this.database.transaction(() => {
        if (this.leads.findById(leadId) === undefined) {
          throw new LeadNotFoundError();
        }

        const existing = this.suppressions.findByLeadId(leadId);
        if (existing !== undefined) {
          return Object.freeze({ suppression: existing, changed: false });
        }

        const suppression: LeadContactSuppression = Object.freeze({
          leadId,
          reasonCode,
          appliedAt: this.currentTimestamp(),
          appliedBy: actor,
        });
        const inserted = this.suppressions.insertIfAbsent(suppression);
        if (!inserted) {
          const winner = this.suppressions.findByLeadId(leadId);
          if (winner === undefined) {
            throw new ContactProtectionUnavailableError();
          }
          return Object.freeze({ suppression: winner, changed: false });
        }

        this.audits.append({
          occurredAt: suppression.appliedAt,
          eventType: "lead.do_not_contact_applied",
          entityType: "business_lead",
          entityId: suppression.leadId,
          actor: suppression.appliedBy,
          details: { reasonCode: suppression.reasonCode },
        });
        return Object.freeze({ suppression, changed: true });
      });
    } catch (error) {
      if (error instanceof LeadNotFoundError) {
        throw error;
      }
      if (error instanceof ContactProtectionUnavailableError) {
        throw error;
      }
      throw new ContactProtectionUnavailableError();
    }
  }

  getSuppression(leadIdInput: unknown): SuppressionState {
    const leadId = normalizeSuppressionLeadId(leadIdInput);
    try {
      return this.database.transaction(() => {
        if (this.leads.findById(leadId) === undefined) {
          throw new LeadNotFoundError();
        }
        const suppression = this.suppressions.findByLeadId(leadId);
        return suppression === undefined
          ? Object.freeze({ state: "not_suppressed" as const, leadId })
          : Object.freeze({ state: "suppressed" as const, suppression });
      });
    } catch (error) {
      if (error instanceof LeadNotFoundError) {
        throw error;
      }
      throw new ContactProtectionUnavailableError();
    }
  }

  assertContactAllowed(leadIdInput: unknown): void {
    const leadId = normalizeSuppressionLeadId(leadIdInput);
    try {
      const eligibility = this.suppressions.readContactEligibility(leadId);
      if (eligibility === undefined) {
        throw new LeadNotFoundError();
      }
      if (eligibility.suppression !== undefined) {
        throw new ContactBlockedError("suppressed");
      }
      if (eligibility.status === "archived") {
        throw new ContactBlockedError("archived");
      }
    } catch (error) {
      if (error instanceof LeadNotFoundError || error instanceof ContactBlockedError) {
        throw error;
      }
      throw new ContactProtectionUnavailableError();
    }
  }

  private currentTimestamp(): string {
    let value: Date;
    try {
      value = this.clock();
    } catch {
      throw new InvalidSuppressionInputError();
    }
    if (!(value instanceof Date)) {
      throw new InvalidSuppressionInputError();
    }
    return normalizeSuppressionTimestamp(value.toISOString());
  }
}
