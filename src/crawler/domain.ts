export const MAX_CRAWL_REDIRECTS = 5;
export const CRAWL_PAGE_TIMEOUT_MILLISECONDS = 15_000;
export const MAX_CRAWL_BODY_BYTES = 1_048_576;

export type CrawlPageContentType = "text/html" | "application/xhtml+xml";

export type CrawlPageResult = Readonly<{
  requestedUrl: string;
  finalUrl: string;
  statusCode: 200;
  contentType: CrawlPageContentType;
  bodyText: string;
  byteLength: number;
  redirectCount: number;
}>;
