# Planned Data Model

SQLite persistence now includes `business_leads`, `audit_events`, and `lead_contact_suppressions`. Remaining domain tables are still planned:

- **BusinessLead** *(implemented)* represents a manually recorded business, lifecycle status, version, and current website-presence observation.
- **WebsiteAudit** records analysis results for a BusinessLead website.
- **Contact** represents an eligible or blocked contact associated with a BusinessLead.
- **Outreach** is an approval-gated draft or delivery record addressed to a Contact.
- **Conversation** groups replies and follow-up state for Outreach.
- **Client** represents a converted BusinessLead and owns ClientRequirements and Projects.
- **ClientRequirements** records scoped needs for a Client.
- **Project** represents website or service delivery work for a Client.
- **Deployment** records a deployment associated with a Project.
- **Payment** records a financial transaction for a Client or Project.
- **Subscription** represents ongoing support for a Client.
- **AuditLog** *(implemented for lead and suppression mutations)* records material, attributable actions across the lifecycle.
- **LeadContactSuppression** *(implemented)* records the one-way do-not-contact reason, timestamp, and applying actor for one BusinessLead.

Typical lifecycle links are BusinessLead → WebsiteAudit / Contact → Outreach → Conversation → Client → ClientRequirements / Project → Deployment, with Payment and Subscription associated with the Client or delivered Project. AuditLog is cross-cutting.

Domain tables will be introduced incrementally through migrations owned by their relevant backlog items.

BusinessLead starts as `recorded`, may move through `reviewing` and `archived` according to the lifecycle rules, and uses optimistic versioning for every update. Website presence is `unknown`, `present`, or `missing`; only `present` stores a normalized HTTP(S) URL.

AuditLog is stored as `audit_events` with an integer sequence ID, event and entity identity, a claimed human or system actor, the mutation timestamp, and a small JSON object whose fields depend on the event type. Its current event types are `lead.created`, `lead.status_changed`, `lead.website_observation_changed`, and `lead.do_not_contact_applied`. Events have no foreign key to leads, are read in ascending ID order, and cannot be updated or deleted. Details record allowlisted state changes but not business names, source references, contact data, or raw website URLs.

LeadContactSuppression is stored as one row per lead in `lead_contact_suppressions`. Row existence means suppression is active. The row contains only `lead_id`, reason code (`manual` or `requested`), canonical UTC application time, and the normalized applying actor. It cannot be updated or deleted through the application schema, does not change BusinessLead lifecycle fields or version, and has no clearing state in DQ-007.
