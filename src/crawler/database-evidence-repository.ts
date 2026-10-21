import type { Database } from "../db";
import {
  CrawlEvidencePersistenceError,
  normalizeSinglePageCrawlEvidence,
  type StoredSinglePageCrawlEvidence,
} from "./evidence-domain";
import type { CrawlEvidenceRepository } from "./evidence-repository";
import type { SinglePageCrawlEvidence } from "./single-page-evidence";

interface EvidenceRow {
  readonly id: unknown;
  readonly lead_id: unknown;
  readonly lead_version: unknown;
  readonly outcome: unknown;
  readonly requested_url: unknown;
  readonly attempted_at: unknown;
  readonly final_url: unknown;
  readonly status_code: unknown;
  readonly content_type: unknown;
  readonly body_text: unknown;
  readonly byte_length: unknown;
  readonly redirect_count: unknown;
  readonly failure_code: unknown;
}

const selectSql = `
  SELECT id, lead_id, lead_version, outcome, requested_url, attempted_at,
         final_url, status_code, content_type, body_text, byte_length,
         redirect_count, failure_code
  FROM single_page_crawl_evidence
  WHERE id = ?
`;

function isSqliteError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "SqliteError";
}

function persistenceFailed(): never {
  throw new CrawlEvidencePersistenceError("PERSISTENCE_FAILED");
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof CrawlEvidencePersistenceError) {
    throw error;
  }
  if (isSqliteError(error)) {
    persistenceFailed();
  }
  throw error;
}

function requireStoredId(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      persistenceFailed();
    }
    return Number(value);
  }

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }

  persistenceFailed();
}

function evidenceFromRow(row: EvidenceRow): StoredSinglePageCrawlEvidence {
  const id = requireStoredId(row.id);

  if (row.outcome === "fetched") {
    if (
      row.final_url === null ||
      row.status_code === null ||
      row.content_type === null ||
      row.body_text === null ||
      row.byte_length === null ||
      row.redirect_count === null ||
      row.failure_code !== null
    ) {
      persistenceFailed();
    }

    const evidence = normalizeSinglePageCrawlEvidence({
      outcome: "fetched",
      leadId: row.lead_id,
      leadVersion: row.lead_version,
      requestedUrl: row.requested_url,
      finalUrl: row.final_url,
      statusCode: row.status_code,
      contentType: row.content_type,
      bodyText: row.body_text,
      byteLength: row.byte_length,
      redirectCount: row.redirect_count,
      attemptedAt: row.attempted_at,
    });
    return Object.freeze({ ...evidence, id });
  }

  if (row.outcome === "failed") {
    if (
      row.final_url !== null ||
      row.status_code !== null ||
      row.content_type !== null ||
      row.body_text !== null ||
      row.byte_length !== null ||
      row.redirect_count !== null ||
      row.failure_code === null
    ) {
      persistenceFailed();
    }

    const evidence = normalizeSinglePageCrawlEvidence({
      outcome: "failed",
      leadId: row.lead_id,
      leadVersion: row.lead_version,
      requestedUrl: row.requested_url,
      failure: row.failure_code,
      attemptedAt: row.attempted_at,
    });
    return Object.freeze({ ...evidence, id });
  }

  persistenceFailed();
}

function insertParameters(evidence: SinglePageCrawlEvidence): readonly [
  string,
  number,
  string,
  string,
  string,
  string | null,
  number | null,
  string | null,
  string | null,
  number | null,
  number | null,
  string | null,
] {
  if (evidence.outcome === "fetched") {
    return [
      evidence.leadId,
      evidence.leadVersion,
      evidence.outcome,
      evidence.requestedUrl,
      evidence.attemptedAt,
      evidence.finalUrl,
      evidence.statusCode,
      evidence.contentType,
      evidence.bodyText,
      evidence.byteLength,
      evidence.redirectCount,
      null,
    ];
  }

  return [
    evidence.leadId,
    evidence.leadVersion,
    evidence.outcome,
    evidence.requestedUrl,
    evidence.attemptedAt,
    null,
    null,
    null,
    null,
    null,
    null,
    evidence.failure,
  ];
}

export class DatabaseCrawlEvidenceRepository implements CrawlEvidenceRepository {
  constructor(private readonly database: Database) {}

  leadExists(leadId: string): boolean {
    return (
      this.database.get("SELECT 1 AS present FROM business_leads WHERE id = ?", [leadId]) !==
      undefined
    );
  }

  insert(input: unknown): StoredSinglePageCrawlEvidence {
    const evidence = normalizeSinglePageCrawlEvidence(input);

    try {
      const result = this.database.run(
        `INSERT INTO single_page_crawl_evidence (
          lead_id,
          lead_version,
          outcome,
          requested_url,
          attempted_at,
          final_url,
          status_code,
          content_type,
          body_text,
          byte_length,
          redirect_count,
          failure_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        insertParameters(evidence),
      );
      if (result.changes !== 1) {
        persistenceFailed();
      }

      const id = requireStoredId(result.lastInsertRowid);
      const stored = this.findById(id);
      if (stored === undefined || stored.id !== id) {
        persistenceFailed();
      }
      return stored;
    } catch (error) {
      mapDatabaseError(error);
    }
  }

  findById(id: number): StoredSinglePageCrawlEvidence | undefined {
    let row: EvidenceRow | undefined;
    try {
      row = this.database.get<EvidenceRow>(selectSql, [id]);
    } catch (error) {
      mapDatabaseError(error);
    }

    if (row === undefined) {
      return undefined;
    }

    try {
      return evidenceFromRow(row);
    } catch (error) {
      if (error instanceof CrawlEvidencePersistenceError) {
        persistenceFailed();
      }
      throw error;
    }
  }
}
