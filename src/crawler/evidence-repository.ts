import type { StoredSinglePageCrawlEvidence } from "./evidence-domain";

export interface CrawlEvidenceRepository {
  leadExists(leadId: string): boolean;
  insert(input: unknown): StoredSinglePageCrawlEvidence;
  findById(id: number): StoredSinglePageCrawlEvidence | undefined;
}
