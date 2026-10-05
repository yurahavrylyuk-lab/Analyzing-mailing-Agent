import type { LeadStatus } from "../leads";
import type { LeadContactSuppression } from "./domain";

export type ContactEligibility = Readonly<{
  status: LeadStatus;
  suppression?: LeadContactSuppression;
}>;

export interface SuppressionRepository {
  findByLeadId(leadId: string): LeadContactSuppression | undefined;
  insertIfAbsent(suppression: LeadContactSuppression): boolean;
  readContactEligibility(leadId: string): ContactEligibility | undefined;
}
