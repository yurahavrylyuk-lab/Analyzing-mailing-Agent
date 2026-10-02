# Planned Data Model

SQLite persistence now includes the first domain table, `business_leads`. Remaining domain tables are still planned:

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
- **AuditLog** records material, attributable actions across the lifecycle.

Typical lifecycle links are BusinessLead → WebsiteAudit / Contact → Outreach → Conversation → Client → ClientRequirements / Project → Deployment, with Payment and Subscription associated with the Client or delivered Project. AuditLog is cross-cutting.

Domain tables will be introduced incrementally through migrations owned by their relevant backlog items.

BusinessLead starts as `recorded`, may move through `reviewing` and `archived` according to the lifecycle rules, and uses optimistic versioning for every update. Website presence is `unknown`, `present`, or `missing`; only `present` stores a normalized HTTP(S) URL.
