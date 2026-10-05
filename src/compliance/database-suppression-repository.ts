import { normalizeAuditActor } from "../audit";
import type { Database } from "../db";
import { LEAD_STATUSES, type LeadStatus } from "../leads";
import {
  normalizeSuppressionLeadId,
  normalizeSuppressionReason,
  normalizeSuppressionTimestamp,
  type LeadContactSuppression,
} from "./domain";
import { InvalidSuppressionInputError } from "./errors";
import type { ContactEligibility, SuppressionRepository } from "./repository";

interface SuppressionRow {
  readonly lead_id: string;
  readonly reason_code: string;
  readonly applied_at: string;
  readonly applied_by_type: string;
  readonly applied_by_id: string;
}

interface EligibilityRow {
  readonly status: string;
  readonly suppression_lead_id: string | null;
  readonly reason_code: string | null;
  readonly applied_at: string | null;
  readonly applied_by_type: string | null;
  readonly applied_by_id: string | null;
}

function suppressionFromRow(row: SuppressionRow): LeadContactSuppression {
  try {
    const leadId = normalizeSuppressionLeadId(row.lead_id);
    const reasonCode = normalizeSuppressionReason(row.reason_code);
    const appliedAt = normalizeSuppressionTimestamp(row.applied_at);
    const appliedBy = normalizeAuditActor({
      type: row.applied_by_type as "human" | "system",
      id: row.applied_by_id,
    });
    return Object.freeze({ leadId, reasonCode, appliedAt, appliedBy });
  } catch {
    throw new InvalidSuppressionInputError();
  }
}

export class DatabaseSuppressionRepository implements SuppressionRepository {
  constructor(private readonly database: Database) {}

  findByLeadId(leadId: string): LeadContactSuppression | undefined {
    const row = this.database.get<SuppressionRow>(
      `SELECT lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      FROM lead_contact_suppressions
      WHERE lead_id = ?`,
      [leadId],
    );
    return row === undefined ? undefined : suppressionFromRow(row);
  }

  insertIfAbsent(suppression: LeadContactSuppression): boolean {
    const result = this.database.run(
      `INSERT INTO lead_contact_suppressions (
        lead_id, reason_code, applied_at, applied_by_type, applied_by_id
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lead_id) DO NOTHING`,
      [
        suppression.leadId,
        suppression.reasonCode,
        suppression.appliedAt,
        suppression.appliedBy.type,
        suppression.appliedBy.id,
      ],
    );
    return result.changes === 1;
  }

  readContactEligibility(leadId: string): ContactEligibility | undefined {
    const row = this.database.get<EligibilityRow>(
      `SELECT
        leads.status,
        suppressions.lead_id AS suppression_lead_id,
        suppressions.reason_code,
        suppressions.applied_at,
        suppressions.applied_by_type,
        suppressions.applied_by_id
      FROM business_leads AS leads
      LEFT JOIN lead_contact_suppressions AS suppressions
        ON suppressions.lead_id = leads.id
      WHERE leads.id = ?`,
      [leadId],
    );
    if (row === undefined) {
      return undefined;
    }
    if (!LEAD_STATUSES.includes(row.status as LeadStatus)) {
      throw new InvalidSuppressionInputError();
    }

    if (row.suppression_lead_id === null) {
      if (
        row.reason_code !== null ||
        row.applied_at !== null ||
        row.applied_by_type !== null ||
        row.applied_by_id !== null
      ) {
        throw new InvalidSuppressionInputError();
      }
      return Object.freeze({ status: row.status as LeadStatus });
    }

    if (
      row.reason_code === null ||
      row.applied_at === null ||
      row.applied_by_type === null ||
      row.applied_by_id === null
    ) {
      throw new InvalidSuppressionInputError();
    }

    return Object.freeze({
      status: row.status as LeadStatus,
      suppression: suppressionFromRow({
        lead_id: row.suppression_lead_id,
        reason_code: row.reason_code,
        applied_at: row.applied_at,
        applied_by_type: row.applied_by_type,
        applied_by_id: row.applied_by_id,
      }),
    });
  }
}
