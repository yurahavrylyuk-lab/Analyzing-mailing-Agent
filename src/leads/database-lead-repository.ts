import type { Database } from "../db";
import type { BusinessLead, LeadStatus, WebsiteObservation } from "./domain";
import type { LeadRepository } from "./repository";

interface BusinessLeadRow {
  readonly id: string;
  readonly business_name: string;
  readonly source_kind: "manual";
  readonly source_reference: string;
  readonly status: LeadStatus;
  readonly website_presence: WebsiteObservation["presence"];
  readonly website_url: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

function observationFromRow(row: BusinessLeadRow): WebsiteObservation {
  if (row.website_presence === "present") {
    return Object.freeze({ presence: "present", url: row.website_url as string });
  }

  return Object.freeze({ presence: row.website_presence });
}

function leadFromRow(row: BusinessLeadRow): BusinessLead {
  return Object.freeze({
    id: row.id,
    businessName: row.business_name,
    sourceKind: row.source_kind,
    sourceReference: row.source_reference,
    status: row.status,
    websiteObservation: observationFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function observationValues(observation: WebsiteObservation): readonly [string, string | null] {
  return [
    observation.presence,
    observation.presence === "present" ? observation.url : null,
  ];
}

export class DatabaseLeadRepository implements LeadRepository {
  constructor(private readonly database: Database) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  insert(lead: BusinessLead): void {
    const [websitePresence, websiteUrl] = observationValues(lead.websiteObservation);
    this.database.run(
      `INSERT INTO business_leads (
        id,
        business_name,
        source_kind,
        source_reference,
        status,
        website_presence,
        website_url,
        created_at,
        updated_at,
        version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lead.id,
        lead.businessName,
        lead.sourceKind,
        lead.sourceReference,
        lead.status,
        websitePresence,
        websiteUrl,
        lead.createdAt,
        lead.updatedAt,
        lead.version,
      ],
    );
  }

  findById(id: string): BusinessLead | undefined {
    const row = this.database.get<BusinessLeadRow>(
      `SELECT
        id,
        business_name,
        source_kind,
        source_reference,
        status,
        website_presence,
        website_url,
        created_at,
        updated_at,
        version
      FROM business_leads
      WHERE id = ?`,
      [id],
    );

    return row === undefined ? undefined : leadFromRow(row);
  }

  updateStatus(
    id: string,
    expectedVersion: number,
    expectedStatus: LeadStatus,
    targetStatus: LeadStatus,
    updatedAt: string,
  ): number {
    return this.database.run(
      `UPDATE business_leads
      SET status = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status = ?`,
      [targetStatus, updatedAt, id, expectedVersion, expectedStatus],
    ).changes;
  }

  updateWebsiteObservation(
    id: string,
    expectedVersion: number,
    expectedStatus: LeadStatus,
    observation: WebsiteObservation,
    updatedAt: string,
  ): number {
    const [websitePresence, websiteUrl] = observationValues(observation);
    return this.database.run(
      `UPDATE business_leads
      SET website_presence = ?, website_url = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status = ?`,
      [websitePresence, websiteUrl, updatedAt, id, expectedVersion, expectedStatus],
    ).changes;
  }
}
