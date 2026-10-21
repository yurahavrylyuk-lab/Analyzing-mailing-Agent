import type { Database } from "../db";
import { DatabaseCrawlEvidenceRepository } from "./database-evidence-repository";
import {
  CrawlEvidencePersistenceError,
  normalizeSinglePageCrawlEvidence,
  type StoredSinglePageCrawlEvidence,
} from "./evidence-domain";
import type { CrawlEvidenceRepository } from "./evidence-repository";

function isSqliteError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "SqliteError";
}

function isStoredEvidenceId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export class SinglePageCrawlEvidenceService {
  private readonly repository: CrawlEvidenceRepository;

  constructor(private readonly database: Database) {
    this.repository = new DatabaseCrawlEvidenceRepository(database);
  }

  persist(input: unknown): StoredSinglePageCrawlEvidence {
    const evidence = normalizeSinglePageCrawlEvidence(input);

    try {
      return this.database.transaction(() => {
        if (!this.repository.leadExists(evidence.leadId)) {
          throw new CrawlEvidencePersistenceError("LEAD_NOT_FOUND");
        }

        return this.repository.insert(evidence);
      });
    } catch (error) {
      if (error instanceof CrawlEvidencePersistenceError) {
        throw error;
      }
      if (isSqliteError(error)) {
        throw new CrawlEvidencePersistenceError("PERSISTENCE_FAILED");
      }
      throw error;
    }
  }

  findById(id: unknown): StoredSinglePageCrawlEvidence | undefined {
    if (!isStoredEvidenceId(id)) {
      throw new CrawlEvidencePersistenceError("INVALID_EVIDENCE");
    }

    try {
      return this.repository.findById(id);
    } catch (error) {
      if (error instanceof CrawlEvidencePersistenceError) {
        throw error;
      }
      if (isSqliteError(error)) {
        throw new CrawlEvidencePersistenceError("PERSISTENCE_FAILED");
      }
      throw error;
    }
  }
}
