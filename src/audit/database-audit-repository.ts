import type { Database } from "../db";
import {
  normalizeAuditEventInput,
  type AuditActor,
  type AuditEvent,
  type AuditEventInput,
} from "./domain";
import { InvalidAuditEventError } from "./errors";
import type { AuditRepository } from "./repository";

interface AuditEventRow {
  readonly id: number;
  readonly occurred_at: string;
  readonly event_type: AuditEventInput["eventType"];
  readonly entity_type: "business_lead";
  readonly entity_id: string;
  readonly actor_type: AuditActor["type"];
  readonly actor_id: string;
  readonly details_json: string;
}

function eventFromRow(row: AuditEventRow): AuditEvent {
  let details: unknown;
  try {
    details = JSON.parse(row.details_json);
  } catch {
    throw new InvalidAuditEventError();
  }

  const normalized = normalizeAuditEventInput({
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actor: { type: row.actor_type, id: row.actor_id },
    details,
  } as AuditEventInput);

  return Object.freeze({ id: row.id, ...normalized } as AuditEvent);
}

export class DatabaseAuditRepository implements AuditRepository {
  constructor(private readonly database: Database) {}

  append(input: AuditEventInput): AuditEvent {
    const event = normalizeAuditEventInput(input);
    const result = this.database.run(
      `INSERT INTO audit_events (
        occurred_at,
        event_type,
        entity_type,
        entity_id,
        actor_type,
        actor_id,
        details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        event.occurredAt,
        event.eventType,
        event.entityType,
        event.entityId,
        event.actor.type,
        event.actor.id,
        JSON.stringify(event.details),
      ],
    );

    return Object.freeze({ id: Number(result.lastInsertRowid), ...event } as AuditEvent);
  }

  listForEntity(entityType: string, entityId: string): AuditEvent[] {
    if (
      typeof entityType !== "string" ||
      entityType.trim().length === 0 ||
      typeof entityId !== "string" ||
      entityId.trim().length === 0
    ) {
      throw new InvalidAuditEventError();
    }

    return this.database
      .all<AuditEventRow>(
        `SELECT
          id,
          occurred_at,
          event_type,
          entity_type,
          entity_id,
          actor_type,
          actor_id,
          details_json
        FROM audit_events
        WHERE entity_type = ? AND entity_id = ?
        ORDER BY id ASC`,
        [entityType.trim(), entityId.trim()],
      )
      .map(eventFromRow);
  }
}
