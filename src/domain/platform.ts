export interface Platform {
  adapterId: string;
  label: string;
  detectedFrom: string;
}

export interface DetectResult {
  adapterId: string;
  label: string;
  detectedFrom: string;
  confidence: number;
}

export interface ResolveInput {
  url: string;
  /** Caller-injected ISO timestamp; no Date.now() in core. */
  now: string;
  /** Caller-inherited fetch caps (already clamped to the server hard cap upstream). Adapters apply
   *  min(cap, platform limit) so a Tier-2 fetch cannot bypass the caller's budget. Optional. */
  maxBytes?: number;
  timeoutMs?: number;
  maxHops?: number;
}

export interface ResolveResult {
  /** Clean resolved content (JSON or markdown), platform-specific. */
  content: string;
  contentType: string;
  finalUrl: string;
  redirects: Array<{ url: string; status: number }>;
  structured?: StructuredData;
  title?: string;
  /** Bytes fetched from the platform API to produce this resolution — egress/audit
   *  provenance, mirroring FetcherResult.bytes (NOT the normalized output size). */
  bytes?: number;
  /** sha256 over the RAW fetched API payload — content-addressable evidence of what was
   *  retrieved (the normalized roster drops fields, so it cannot attest the fetched bytes). */
  contentSha256?: string;
}

export interface StructuredData {
  canonicalUrl?: string;
  jsonLd?: unknown;
  og?: Record<string, string>;
  meta?: Record<string, string>;
  appState?: unknown;
  /**
   * Absolute, deduped, bounded http(s) image URLs derived from og:image*,
   * JSON-LD image/thumbnailUrl/ImageObject, and `<img src>`/`<source srcset>`.
   * Surfaced to the agent for optional multimodal vision fetch; never fetched
   * by this service. Private-IP / localhost hosts are stripped (no DNS — string
   * check only) so internal targets are not advertised externally.
   */
  images?: string[];
}
