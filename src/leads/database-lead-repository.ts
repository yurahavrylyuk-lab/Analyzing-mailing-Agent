import type { Database } from "../db";
import {
  LEAD_STATUSES,
  isBusinessLeadId,
  normalizeWebsiteUrl,
  type BusinessLead,
  type DiscoveredBusinessLead,
  type LeadStatus,
  type WebsiteObservation,
} from "./domain";
import { LeadPersistenceError } from "./errors";
import type { LeadRepository } from "./repository";

interface BusinessLeadRow {
  readonly id: unknown;
  readonly business_name: unknown;
  readonly source_kind: unknown;
  readonly source_provider: unknown;
  readonly source_reference: unknown;
  readonly status: unknown;
  readonly website_presence: unknown;
  readonly website_url: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly version: unknown;
}

const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;
const providerPattern = /^[a-z][a-z0-9_]*$/u;

function unicodeLength(value: string): number {
  return [...value].length;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function observationFromRow(row: BusinessLeadRow): WebsiteObservation {
  if (row.website_presence === "present" && typeof row.website_url === "string") {
    let normalized: string;
    try {
      normalized = normalizeWebsiteUrl(row.website_url);
    } catch {
      throw new LeadPersistenceError();
    }
    if (normalized !== row.website_url) {
      throw new LeadPersistenceError();
    }
    return Object.freeze({ presence: "present", url: row.website_url });
  }

  if (
    (row.website_presence === "unknown" || row.website_presence === "missing") &&
    row.website_url === null
  ) {
    return Object.freeze({ presence: row.website_presence });
  }

  throw new LeadPersistenceError();
}

function leadFromRow(row: BusinessLeadRow): BusinessLead {
  if (
    !isBusinessLeadId(row.id) ||
    typeof row.business_name !== "string" ||
    row.business_name.length === 0 ||
    row.business_name !== row.business_name.trim() ||
    typeof row.source_reference !== "string" ||
    row.source_reference.length === 0 ||
    row.source_reference !== row.source_reference.trim() ||
    typeof row.status !== "string" ||
    !LEAD_STATUSES.includes(row.status as LeadStatus) ||
    !isCanonicalTimestamp(row.created_at) ||
    !isCanonicalTimestamp(row.updated_at) ||
    typeof row.version !== "number" ||
    !Number.isInteger(row.version) ||
    row.version < 1
  ) {
    throw new LeadPersistenceError();
  }

  const common = {
    id: row.id,
    businessName: row.business_name,
    sourceReference: row.source_reference,
    status: row.status as LeadStatus,
    websiteObservation: observationFromRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };

  if (row.source_kind === "manual" && row.source_provider === null) {
    return Object.freeze({ ...common, sourceKind: "manual" });
  }

  if (
    row.source_kind === "discovery" &&
    typeof row.source_provider === "string" &&
    unicodeLength(row.source_provider) >= 1 &&
    unicodeLength(row.source_provider) <= 64 &&
    providerPattern.test(row.source_provider) &&
    unicodeLength(row.source_reference) <= 512 &&
    !controlCharacterPattern.test(row.source_reference) &&
    unicodeLength(row.business_name) <= 300 &&
    !controlCharacterPattern.test(row.business_name)
  ) {
    return Object.freeze({
      ...common,
      sourceKind: "discovery",
      sourceProvider: row.source_provider,
    });
  }

  throw new LeadPersistenceError();
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
        source_provider,
        source_reference,
        status,
        website_presence,
        website_url,
        created_at,
        updated_at,
        version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lead.id,
        lead.businessName,
        lead.sourceKind,
        lead.sourceKind === "discovery" ? lead.sourceProvider : null,
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

  insertDiscoveredIfAbsent(lead: DiscoveredBusinessLead): boolean {
    const [websitePresence, websiteUrl] = observationValues(lead.websiteObservation);
    return this.database.run(
      `INSERT INTO business_leads (
        id,
        business_name,
        source_kind,
        source_provider,
        source_reference,
        status,
        website_presence,
        website_url,
        created_at,
        updated_at,
        version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_provider, source_reference)
      WHERE source_kind = 'discovery'
      DO NOTHING`,
      [
        lead.id,
        lead.businessName,
        lead.sourceKind,
        lead.sourceProvider,
        lead.sourceReference,
        lead.status,
        websitePresence,
        websiteUrl,
        lead.createdAt,
        lead.updatedAt,
        lead.version,
      ],
    ).changes === 1;
  }

  findById(id: string): BusinessLead | undefined {
    const row = this.database.get<BusinessLeadRow>(
      `SELECT
        id,
        business_name,
        source_kind,
        source_provider,
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

  findByDiscoveryIdentity(
    provider: string,
    reference: string,
  ): DiscoveredBusinessLead | undefined {
    const row = this.database.get<BusinessLeadRow>(
      `SELECT
        id,
        business_name,
        source_kind,
        source_provider,
        source_reference,
        status,
        website_presence,
        website_url,
        created_at,
        updated_at,
        version
      FROM business_leads
      WHERE source_kind = 'discovery'
        AND source_provider = ?
        AND source_reference = ?`,
      [provider, reference],
    );

    if (row === undefined) {
      return undefined;
    }
    const lead = leadFromRow(row);
    if (lead.sourceKind !== "discovery") {
      throw new LeadPersistenceError();
    }
    return lead;
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
