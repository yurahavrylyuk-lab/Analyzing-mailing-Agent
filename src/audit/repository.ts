import type { AuditEvent, AuditEventInput } from "./domain";

export interface AuditRepository {
  append(event: AuditEventInput): AuditEvent;
  listForEntity(entityType: string, entityId: string): AuditEvent[];
}
