# Planned Data Model

SQLite persistence infrastructure now exists, but no business or domain tables have been implemented. These are planned primary entities:

- **BusinessLead** represents a discovered business and its qualification state.
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
