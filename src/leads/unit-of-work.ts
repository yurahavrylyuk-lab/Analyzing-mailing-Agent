import {
  DatabaseAuditRepository,
  type AuditRepository,
} from "../audit";
import type { Database } from "../db";
import { DatabaseLeadRepository } from "./database-lead-repository";
import type { LeadRepository } from "./repository";

interface AuditedLeadContext {
  readonly leads: LeadRepository;
  readonly audits: AuditRepository;
}

export class DatabaseAuditedLeadUnitOfWork implements AuditedLeadContext {
  readonly leads: LeadRepository;
  readonly audits: AuditRepository;

  constructor(private readonly database: Database) {
    this.leads = new DatabaseLeadRepository(database);
    this.audits = new DatabaseAuditRepository(database);
  }

  transaction<T>(operation: (context: AuditedLeadContext) => T): T {
    return this.database.transaction(() => operation(this));
  }
}
