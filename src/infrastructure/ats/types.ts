/**
 * Shared types + pure helpers for ATS (Applicant Tracking System) Tier-2 list
 * adapters. One folder per platform under src/infrastructure/<platform>/; this
 * module holds the cross-ATS normalized shape + the sanitize/cap/parse
 * primitives every adapter reuses, so SSRF + untrusted-response hygiene lives
 * in one place. Verified endpoints + field mappings live in each adapter.
 *
 * See docs/contracts.md "Tier-2".
 */

/** A single job normalized to a cross-ATS, token-efficient shape. Heavy vendor
 *  fields (full description HTML, multi-tier compensation breakdowns) are
 *  dropped — the agent can deep-fetch a single JD's `url` at Tier-1, which
 *  serves a clean JobPosting JSON-LD. */
export interface NormalizedJob {
  id: string;
  title: string;
  url: string;
  location: string | null;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  workplaceType: string | null;
  remote: boolean | null;
  publishedAt: string | null;
  compensation: string | null;
}

/** Board-level envelope an ATS list adapter stringifies into ResolveResult.content. */
export interface NormalizedBoard {
  platform: string;
  board: string;
  jobCount: number;
  truncated: boolean;
  jobs: NormalizedJob[];
}

/** ATS board tokens are URL slugs: alnum + dot/underscore/hyphen. Anything else
 *  — path traversal (`/`, `..`), query (`?`), fragment (`#`), percent (`%`),
 *  CRLF — is rejected FAIL-CLOSED so a crafted career URL cannot steer the
 *  adapter to an arbitrary host/path. Combined with `new URL` reconstruction in
 *  each adapter, the API host stays pinned however the token was obtained. */
const ATS_TOKEN_RE = /^[A-Za-z0-9._-]+$/;

export function sanitizeAtsToken(token: string | undefined | null): string | null {
  if (typeof token !== "string") return null;
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > 128 || !ATS_TOKEN_RE.test(trimmed)) return null;
  if (trimmed === "." || trimmed === "..") return null;
  return trimmed;
}

/** Bounded roster cap. The roster is the value; a pathological board is bounded
 *  and `truncated` is surfaced so the caller knows there may be more. */
export const ATS_JOB_CAP = 500;

/** ATS list APIs are the authoritative source and bounded by the board size, so
 *  allow a generous egress so a real board parses cleanly. Independent of the
 *  user's page-byte cap (which bounds rendered page content, not an API roster).
 *  If a board exceeds this, truncation breaks JSON.parse → the adapter returns
 *  null and the orchestrator falls through to the generic Tier-1 path. */
export const ATS_MAX_BYTES = 8 * 1024 * 1024;
export const ATS_TIMEOUT_MS = 20_000;
export const ATS_MAX_HOPS = 3;

/** First non-empty trimmed string among the args, else null. */
export function firstStr(...values: ReadonlyArray<unknown>): string | null {
  for (const v of values) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t) return t;
    }
  }
  return null;
}

/** Convert a Lever `createdAt` unix-ms epoch to ISO 8601, or null if not a
 *  positive finite number. (Pure conversion of a known value — no `Date.now()`.) */
export function epochMsToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Apply the roster cap. Returns the (possibly sliced) jobs + a truncated flag. */
export function capJobs<T>(jobs: readonly T[]): { jobs: T[]; truncated: boolean } {
  if (jobs.length <= ATS_JOB_CAP) return { jobs: [...jobs], truncated: false };
  return { jobs: jobs.slice(0, ATS_JOB_CAP), truncated: true };
}

/** Build the board envelope. `rawCount` is the untruncated total so `jobCount`
 *  reports the true roster even when `jobs` was capped. */
export function boardEnvelope(
  platform: string,
  board: string,
  rawCount: number,
  jobs: NormalizedJob[],
  truncated: boolean,
): NormalizedBoard {
  return { platform, board, jobCount: rawCount, truncated, jobs };
}
