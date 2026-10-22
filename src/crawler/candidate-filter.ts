export const CRAWL_CANDIDATE_WHERE_SQL = `status IN ('recorded', 'reviewing')
  AND website_presence = 'present'
  AND website_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM single_page_crawl_evidence AS evidence
    WHERE evidence.lead_id = business_leads.id
      AND evidence.requested_url = business_leads.website_url
      AND (
        evidence.outcome = 'fetched'
        OR evidence.failure_code <> 'CANCELLED'
      )
  )`;
