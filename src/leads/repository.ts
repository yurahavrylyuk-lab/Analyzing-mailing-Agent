import type {
  BusinessLead,
  DiscoveredBusinessLead,
  LeadStatus,
  WebsiteObservation,
} from "./domain";

export interface LeadRepository {
  transaction<T>(operation: () => T): T;
  insert(lead: BusinessLead): void;
  insertDiscoveredIfAbsent(lead: DiscoveredBusinessLead): boolean;
  findById(id: string): BusinessLead | undefined;
  findByDiscoveryIdentity(
    provider: string,
    reference: string,
  ): DiscoveredBusinessLead | undefined;
  updateStatus(
    id: string,
    expectedVersion: number,
    expectedStatus: LeadStatus,
    targetStatus: LeadStatus,
    updatedAt: string,
  ): number;
  updateWebsiteObservation(
    id: string,
    expectedVersion: number,
    expectedStatus: LeadStatus,
    observation: WebsiteObservation,
    updatedAt: string,
  ): number;
}
