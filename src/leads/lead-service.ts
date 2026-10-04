import { randomUUID } from "node:crypto";

import { normalizeAuditActor, type AuditActor } from "../audit";
import type { Database } from "../db";
import {
  createBusinessLead,
  normalizeWebsiteObservation,
  toUtcIso,
  validateExpectedVersion,
  validateLifecycleTransition,
  websiteObservationsEqual,
  type BusinessLead,
  type CreateLeadInput,
  type LeadStatus,
  type WebsiteObservation,
} from "./domain";
import {
  ArchivedLeadWebsiteMutationError,
  LeadNotFoundError,
  StaleLeadVersionError,
} from "./errors";
import type { LeadRepository } from "./repository";
import { DatabaseAuditedLeadUnitOfWork } from "./unit-of-work";

export interface LeadServiceOptions {
  readonly idGenerator?: () => string;
  readonly clock?: () => Date;
}

function nextMutationTimestamp(clock: () => Date, currentTimestamp: string): string {
  const clockTime = new Date(toUtcIso(clock())).getTime();
  const currentTime = Date.parse(currentTimestamp);
  return new Date(Math.max(clockTime, currentTime + 1)).toISOString();
}

export class LeadService {
  private readonly idGenerator: () => string;
  private readonly clock: () => Date;
  private readonly unitOfWork: DatabaseAuditedLeadUnitOfWork;

  constructor(
    database: Database,
    options: LeadServiceOptions = {},
  ) {
    this.unitOfWork = new DatabaseAuditedLeadUnitOfWork(database);
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  createLead(input: CreateLeadInput, actor: AuditActor): BusinessLead {
    const lead = createBusinessLead(input, this.idGenerator(), this.clock());
    const normalizedActor = normalizeAuditActor(actor);
    this.unitOfWork.transaction(({ leads, audits }) => {
      leads.insert(lead);
      audits.append({
        occurredAt: lead.createdAt,
        eventType: "lead.created",
        entityType: "business_lead",
        entityId: lead.id,
        actor: normalizedActor,
        details: {
          initialStatus: lead.status,
          initialWebsitePresence: lead.websiteObservation.presence,
          version: lead.version,
        },
      });
    });
    return lead;
  }

  getLead(id: string): BusinessLead {
    return this.requireLead(this.unitOfWork.leads, id);
  }

  transitionLead(
    id: string,
    targetStatus: LeadStatus,
    expectedVersion: number,
    actor: AuditActor,
  ): BusinessLead {
    validateExpectedVersion(expectedVersion);
    const normalizedActor = normalizeAuditActor(actor);

    return this.unitOfWork.transaction(({ leads, audits }) => {
      const current = this.requireLead(leads, id);
      this.assertCurrentVersion(current, expectedVersion);

      if (!validateLifecycleTransition(current.status, targetStatus)) {
        return current;
      }

      const updatedAt = nextMutationTimestamp(this.clock, current.updatedAt);
      const changes = leads.updateStatus(
        id,
        expectedVersion,
        current.status,
        targetStatus,
        updatedAt,
      );
      if (changes === 0) {
        throw new StaleLeadVersionError();
      }

      const updated = Object.freeze({
        ...current,
        status: targetStatus,
        updatedAt,
        version: current.version + 1,
      });
      audits.append({
        occurredAt: updated.updatedAt,
        eventType: "lead.status_changed",
        entityType: "business_lead",
        entityId: updated.id,
        actor: normalizedActor,
        details: {
          previousStatus: current.status,
          newStatus: updated.status,
          version: updated.version,
        },
      });
      return updated;
    });
  }

  setWebsiteObservation(
    id: string,
    observation: WebsiteObservation,
    expectedVersion: number,
    actor: AuditActor,
  ): BusinessLead {
    validateExpectedVersion(expectedVersion);
    const normalizedActor = normalizeAuditActor(actor);

    return this.unitOfWork.transaction(({ leads, audits }) => {
      const current = this.requireLead(leads, id);
      this.assertCurrentVersion(current, expectedVersion);

      if (current.status === "archived") {
        throw new ArchivedLeadWebsiteMutationError();
      }

      const normalizedObservation = normalizeWebsiteObservation(observation);
      if (websiteObservationsEqual(current.websiteObservation, normalizedObservation)) {
        return current;
      }

      const updatedAt = nextMutationTimestamp(this.clock, current.updatedAt);
      const changes = leads.updateWebsiteObservation(
        id,
        expectedVersion,
        current.status,
        normalizedObservation,
        updatedAt,
      );
      if (changes === 0) {
        throw new StaleLeadVersionError();
      }

      const updated = Object.freeze({
        ...current,
        websiteObservation: normalizedObservation,
        updatedAt,
        version: current.version + 1,
      });
      const previousUrl =
        current.websiteObservation.presence === "present"
          ? current.websiteObservation.url
          : null;
      const newUrl =
        updated.websiteObservation.presence === "present"
          ? updated.websiteObservation.url
          : null;
      audits.append({
        occurredAt: updated.updatedAt,
        eventType: "lead.website_observation_changed",
        entityType: "business_lead",
        entityId: updated.id,
        actor: normalizedActor,
        details: {
          previousPresence: current.websiteObservation.presence,
          newPresence: updated.websiteObservation.presence,
          urlChanged: previousUrl !== newUrl,
          version: updated.version,
        },
      });
      return updated;
    });
  }

  private requireLead(repository: LeadRepository, id: string): BusinessLead {
    const lead = repository.findById(id);
    if (lead === undefined) {
      throw new LeadNotFoundError();
    }

    return lead;
  }

  private assertCurrentVersion(lead: BusinessLead, expectedVersion: number): void {
    if (lead.version !== expectedVersion) {
      throw new StaleLeadVersionError();
    }
  }
}
