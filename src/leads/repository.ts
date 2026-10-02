import type { BusinessLead, LeadStatus, WebsiteObservation } from "./domain";

export interface LeadRepository {
  transaction<T>(operation: () => T): T;
  insert(lead: BusinessLead): void;
  findById(id: string): BusinessLead | undefined;
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
