import type {
  DetectResult,
  ResolveInput,
  ResolveResult,
} from "../../domain/platform.ts";
import type { PlatformAdapter } from "../../application/ports/platform-adapter.ts";
import type { FetcherPort } from "../../application/ports/fetcher.ts";
import { fetchAtsBoard } from "../ats/fetch.ts";
import {
  boardEnvelope,
  capJobs,
  firstStr,
  sanitizeAtsToken,
  type NormalizedJob,
} from "../ats/types.ts";

/**
 * Greenhouse Tier-2 list adapter. Detects a Greenhouse board URL/host → lists
 * ALL jobs via the public board API (clean JSON, no HTML crawling). Verified:
 * GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs  (metadata only;
 * descriptions are omitted so a 168-job board is ~100KB, not 1.8MB). Unknown
 * token → 404 (handled as a graceful no-result). See docs/contracts.md "Tier-2".
 */

// Greenhouse serves hosted board roots on two domains; both have the /{token} board-root shape and
// route to the same boards-api.greenhouse.io/v1/boards/{token}/jobs API (verified: job-boards.greenhouse.io/reddit).
const BOARD_HOSTS = new Set(["boards.greenhouse.io", "job-boards.greenhouse.io"]);
const API_HOST = "boards-api.greenhouse.io";
const RESERVED = new Set(["embed", "embedding", "assets", "board"]);

function isBoardHost(host: string): boolean {
  return BOARD_HOSTS.has(host) || (host.startsWith("www.") && BOARD_HOSTS.has(host.slice(4)));
}

/** Extract + sanitize the board token from a Greenhouse URL. */
export function extractGreenhouseToken(url: string): { token: string; from: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);
  let raw: string | null = null;
  let from = "";
  if (isBoardHost(host)) {
    // Claim ONLY the board root (exactly 1 segment). A deeper path — /{token}/jobs/{id} — is a
    // single job detail; let it fall through to Tier-1 (JobPosting JSON-LD) instead of the roster.
    if (segments.length !== 1) return null;
    // `?gh_jid=<id>` is Greenhouse's single-job link shape (board root + job id query) → fall through
    // to Tier-1 so the requested posting is extracted, not the whole roster.
    if (parsed.searchParams.has("gh_jid")) return null;
    if (RESERVED.has(segments[0]!.toLowerCase())) return null;
    raw = segments[0]!;
    from = "url-host";
  } else if (host === API_HOST || host === `www.${API_HOST}`) {
    // Exact list endpoint only: /v1/boards/{token}/jobs — anchored to the canonical segment sequence
    // so a non-canonical path (/v2/boards/…, or a later "boards" segment) is NOT claimed + rewritten to v1.
    if (segments.length !== 4) return null;
    if (segments[0]!.toLowerCase() !== "v1" || segments[1]!.toLowerCase() !== "boards" || segments[3]!.toLowerCase() !== "jobs") return null;
    raw = segments[2]!;
    from = "api-host";
  }
  const token = sanitizeAtsToken(raw);
  return token ? { token, from } : null;
}

/** Discover the board token from an embedding page's HTML (Greenhouse embedding
 *  board script). Conservative + bounded; not wired into the orchestrator yet
 *  (URL-host detection is the deterministic path) but exercised by unit tests. */
export function detectGreenhouseEmbed(html: string): string | null {
  // Greenhouse embedding-board script carries the board token as `board=` or `for=`.
  const re = /boards\.greenhouse\.io\/embed\/job_board(?:\/js)?\?[^"'\s]{0,256}(?:board|for)=([A-Za-z0-9._-]{1,128})/;
  const m = re.exec(html);
  return m ? sanitizeAtsToken(m[1]) : null;
}

function normalizeGreenhouseJob(j: Record<string, unknown>): NormalizedJob | null {
  const id = j.id != null ? String(j.id) : null;
  const title = firstStr(j.title);
  const url = firstStr(j.absolute_url);
  if (!id && !title && !url) return null;
  const loc = j.location && typeof j.location === "object"
    ? firstStr((j.location as Record<string, unknown>).name)
    : null;
  return {
    id: id ?? url ?? title ?? "",
    title: title ?? id ?? "",
    url: url ?? "",
    location: loc,
    // Greenhouse's lightweight metadata-only /jobs response omits per-job departments (those need
    // ?content=true, deliberately not fetched — a 168-role board is ~100KB, not 1.8MB). So department
    // is honestly null here; deep-fetch a JD's url at Tier-1 for its department. Populated for Lever/Ashby.
    department: null,
    team: null,
    employmentType: null,
    workplaceType: null,
    remote: null,
    publishedAt: firstStr(j.first_published, j.updated_at),
    compensation: null,
  };
}

function greenhouseApiUrl(token: string): string {
  // `new URL` + encodeURIComponent pins the host; token is pre-sanitized.
  return new URL(`/v1/boards/${encodeURIComponent(token)}/jobs`, `https://${API_HOST}`).href;
}

export const greenhouseAdapter: PlatformAdapter = {
  id: "greenhouse",
  detect(ctx: { url: string; contentType?: string; html?: string }): DetectResult | null {
    const byUrl = extractGreenhouseToken(ctx.url);
    if (byUrl) {
      return { adapterId: "greenhouse", label: "Greenhouse", detectedFrom: byUrl.from, confidence: 1 };
    }
    if (ctx.html) {
      const token = detectGreenhouseEmbed(ctx.html);
      if (token) {
        return { adapterId: "greenhouse", label: "Greenhouse", detectedFrom: "embed-script", confidence: 0.8 };
      }
    }
    return null;
  },
  async resolve(input: ResolveInput, fetcher: FetcherPort): Promise<ResolveResult> {
    const byUrl = extractGreenhouseToken(input.url);
    const token = byUrl?.token ?? null;
    if (!token) throw new Error("greenhouse board token not found");
    const apiUrl = greenhouseApiUrl(token);
    const board = await fetchAtsBoard(fetcher, apiUrl, { maxBytes: input.maxBytes, timeoutMs: input.timeoutMs, maxHops: input.maxHops });
    if (!board) throw new Error("greenhouse board not reachable");
    const jobsNode = (board.data as Record<string, unknown> | null)?.jobs;
    if (!Array.isArray(jobsNode)) throw new Error("greenhouse board returned no jobs array");
    const rawCount = jobsNode.length;
    // Cap the INPUT before normalizing (cap-then-map): a large/malicious board must not pin the
    // event loop normalizing 100k+ jobs only to slice them away. rawCount reports the true board size.
    const { jobs: cappedInput, truncated } = capJobs(jobsNode);
    const normalized = cappedInput
      .map((j) => (j && typeof j === "object" ? normalizeGreenhouseJob(j as Record<string, unknown>) : null))
      .filter((j): j is NormalizedJob => j !== null);
    const envelope = boardEnvelope("greenhouse", token, rawCount, normalized, truncated);
    return {
      content: JSON.stringify(envelope),
      contentType: "application/json",
      finalUrl: board.finalUrl || apiUrl,
      redirects: board.redirects,
      bytes: board.bytes,
      contentSha256: board.fetchedSha256,
      title: `${envelope.jobCount} open role${envelope.jobCount === 1 ? "" : "s"} · Greenhouse · ${token}`,
    };
  },
};
