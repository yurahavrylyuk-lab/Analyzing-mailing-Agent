# Planned Data Model

SQLite persistence now includes `business_leads`, `audit_events`, `lead_contact_suppressions`, and `single_page_crawl_evidence`. Remaining domain tables are still planned:

- **BusinessLead** *(implemented)* represents a manually recorded or discovered business, explicit source provenance, lifecycle status, version, and current website-presence observation.
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

BusinessLead starts as `recorded`, may move through `reviewing` and `archived` according to the lifecycle rules, and uses optimistic versioning for every update. Manual provenance stores `source_kind = manual`, no provider field, and a source reference. Discovery provenance stores `source_kind = discovery`, a stable lowercase `source_provider`, and an opaque case-sensitive source reference. The partial unique index on `(source_provider, source_reference)` applies only to discovery rows, so manual records retain their existing duplicate semantics and provider identities remain independent from generated lead UUIDs.

Rediscovery by the same provider/reference returns the authoritative stored lead without refreshing its name, website observation, lifecycle, timestamps, version, suppression, or audit history. Website presence is `unknown`, `present`, or `missing`; discovery creation accepts only unknown or present, while later lifecycle operations may record missing. Only `present` stores a normalized HTTP(S) URL.

AuditLog is stored as `audit_events` with an integer sequence ID, event and entity identity, a claimed human or system actor, the mutation timestamp, and a small JSON object whose fields depend on the event type. Its current event types are `lead.created`, `lead.status_changed`, `lead.website_observation_changed`, and `lead.do_not_contact_applied`. Discovery creation reuses `lead.created`; provenance remains on BusinessLead and is not copied into audit details. Events have no foreign key to leads, are read in ascending ID order, and cannot be updated or deleted. Details record allowlisted state changes but not business names, provider identities, source references, contact data, or raw website URLs.

LeadContactSuppression is stored as one row per lead in `lead_contact_suppressions`. Row existence means suppression is active. The row contains only `lead_id`, reason code (`manual` or `requested`), canonical UTC application time, and the normalized applying actor. It cannot be updated or deleted through the application schema, does not change BusinessLead lifecycle fields or version, and has no clearing state in DQ-007.

Single-page crawl evidence is stored as append-only `single_page_crawl_evidence`. Each row is one finished attempt, not a cache of the lead's current website. `id` is an integer primary key and is not the lead version or the attempt time. `lead_id` references `business_leads(id)` with `ON DELETE RESTRICT` and `ON UPDATE RESTRICT`. Only lead existence is required: archived and suppressed leads can keep and receive evidence. `lead_version`, `requested_url`, and a fetched `final_url` are the attempt snapshot. A later lead version or website URL does not rewrite or delete the row. `attempted_at` is the canonical UTC timestamp from the evidence. Fetched rows store `status_code` 200, `text/html` or `application/xhtml+xml`, untrusted `body_text`, its UTF-8 `byte_length` from 0 through 1,048,576, and `redirect_count` from 0 through 5. Failed rows store an allowlisted failure code and leave the fetched columns null. Failures do not store raw error messages. There is no list index. Triggers reject update and delete. There is no retention or pruning path; a future retention rule needs an explicit schema-policy change. `WebsiteAudit` remains planned. This table is not a crawl command, a lead selector, or a spider.
