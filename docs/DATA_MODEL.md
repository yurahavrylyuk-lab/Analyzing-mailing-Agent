# Planned Data Model

SQLite persistence now includes `business_leads` and `audit_events`. Remaining domain tables are still planned:

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
- **AuditLog** *(implemented for lead mutations)* records material, attributable actions across the lifecycle.

Typical lifecycle links are BusinessLead → WebsiteAudit / Contact → Outreach → Conversation → Client → ClientRequirements / Project → Deployment, with Payment and Subscription associated with the Client or delivered Project. AuditLog is cross-cutting.

Domain tables will be introduced incrementally through migrations owned by their relevant backlog items.

BusinessLead starts as `recorded`, may move through `reviewing` and `archived` according to the lifecycle rules, and uses optimistic versioning for every update. Website presence is `unknown`, `present`, or `missing`; only `present` stores a normalized HTTP(S) URL.

AuditLog is stored as `audit_events` with an integer sequence ID, event and entity identity, a claimed human or system actor, the lead mutation timestamp, and a small JSON object whose fields depend on the event type. Its current event types are `lead.created`, `lead.status_changed`, and `lead.website_observation_changed`. Events have no foreign key to leads, are read in ascending ID order, and cannot be updated or deleted. Details record state changes and versions but not business names, source references, or raw website URLs.
