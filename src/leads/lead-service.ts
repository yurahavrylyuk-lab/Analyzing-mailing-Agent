import { randomUUID } from "node:crypto";

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

  constructor(
    private readonly repository: LeadRepository,
    options: LeadServiceOptions = {},
  ) {
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.clock = options.clock ?? (() => new Date());
  }

  createLead(input: CreateLeadInput): BusinessLead {
    const lead = createBusinessLead(input, this.idGenerator(), this.clock());
    this.repository.transaction(() => this.repository.insert(lead));
    return lead;
  }

  getLead(id: string): BusinessLead {
    return this.requireLead(id);
  }

  transitionLead(
    id: string,
    targetStatus: LeadStatus,
    expectedVersion: number,
  ): BusinessLead {
    validateExpectedVersion(expectedVersion);

    return this.repository.transaction(() => {
      const current = this.requireLead(id);
      this.assertCurrentVersion(current, expectedVersion);

      if (!validateLifecycleTransition(current.status, targetStatus)) {
        return current;
      }

      const updatedAt = nextMutationTimestamp(this.clock, current.updatedAt);
      const changes = this.repository.updateStatus(
        id,
        expectedVersion,
        current.status,
        targetStatus,
        updatedAt,
      );
      if (changes === 0) {
        throw new StaleLeadVersionError();
      }

      return Object.freeze({
        ...current,
        status: targetStatus,
        updatedAt,
        version: current.version + 1,
      });
    });
  }

  setWebsiteObservation(
    id: string,
    observation: WebsiteObservation,
    expectedVersion: number,
  ): BusinessLead {
    validateExpectedVersion(expectedVersion);

    return this.repository.transaction(() => {
      const current = this.requireLead(id);
      this.assertCurrentVersion(current, expectedVersion);

      if (current.status === "archived") {
        throw new ArchivedLeadWebsiteMutationError();
      }

      const normalizedObservation = normalizeWebsiteObservation(observation);
      if (websiteObservationsEqual(current.websiteObservation, normalizedObservation)) {
        return current;
      }

      const updatedAt = nextMutationTimestamp(this.clock, current.updatedAt);
      const changes = this.repository.updateWebsiteObservation(
        id,
        expectedVersion,
        current.status,
        normalizedObservation,
        updatedAt,
      );
      if (changes === 0) {
        throw new StaleLeadVersionError();
      }

      return Object.freeze({
        ...current,
        websiteObservation: normalizedObservation,
        updatedAt,
        version: current.version + 1,
      });
    });
  }

  private requireLead(id: string): BusinessLead {
    const lead = this.repository.findById(id);
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
