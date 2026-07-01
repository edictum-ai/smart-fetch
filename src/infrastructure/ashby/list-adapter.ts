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
 * Ashby Tier-2 LIST adapter. Distinct from embed-resolver.ts (which resolves a
 * SINGLE job via a `?ashby_jid=` on a custom-domain embed). This detects an
 * Ashby board host → lists ALL jobs via the public posting API. Verified: GET
 * https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 * → {jobs:[…]} with title/department/team/employmentType/location/isRemote/
 * workplaceType/publishedAt/jobUrl/compensation. Unknown slug → 404 (graceful).
 * The two Ashby paths never collide: embed-resolver fires on `ashby_jid` query
 * (custom domains); this fires on the `jobs.ashbyhq.com` / `api.ashbyhq.com` host.
 */

const BOARD_HOST = "jobs.ashbyhq.com";
const API_HOST = "api.ashbyhq.com";

export function extractAshbyToken(url: string): { token: string; from: string } | null {
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
  if (host === BOARD_HOST || host === `www.${BOARD_HOST}`) {
    // Claim ONLY the board root (exactly 1 segment). /{org}/{jobId} is a single job; let it fall
    // through to Tier-1 (the SSR page serves a clean JobPosting JSON-LD) instead of the roster.
    if (segments.length !== 1) return null;
    if (segments[0] === "embed" || segments[0] === "api") return null;
    raw = segments[0]!;
    from = "url-host";
  } else if (host === API_HOST || host === `www.${API_HOST}`) {
    // Exact list endpoint only: /posting-api/job-board/{slug} — anchored to the canonical segment sequence.
    if (segments.length !== 3) return null;
    if (segments[0]!.toLowerCase() !== "posting-api" || segments[1]!.toLowerCase() !== "job-board") return null;
    raw = segments[2]!;
    from = "api-host";
  }
  const token = sanitizeAtsToken(raw);
  return token ? { token, from } : null;
}

/** Discover the org alias from an embedding page's Ashby embed script (proven
 *  on e2b.dev/careers → jobs.ashbyhq.com/e2b/embed). Conservative + bounded. */
export function detectAshbyEmbed(html: string): string | null {
  const re = /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]{1,128})\/embed/;
  const m = re.exec(html);
  return m ? sanitizeAtsToken(m[1]) : null;
}

function normalizeAshbyJob(j: Record<string, unknown>): NormalizedJob | null {
  const id = firstStr(j.id);
  const title = firstStr(j.title);
  const url = firstStr(j.jobUrl, j.applyUrl);
  if (!id && !title && !url) return null;
  const comp = j.shouldDisplayCompensationOnJobPostings === true &&
    j.compensation && typeof j.compensation === "object"
    ? firstStr(
        (j.compensation as Record<string, unknown>).scrapeableCompensationSalarySummary,
        (j.compensation as Record<string, unknown>).compensationTierSummary,
      )
    : null;
  const remote = typeof j.isRemote === "boolean" ? j.isRemote : null;
  return {
    id: id ?? url ?? title ?? "",
    title: title ?? id ?? "",
    url: url ?? "",
    location: firstStr(j.location),
    department: firstStr(j.department),
    team: firstStr(j.team),
    employmentType: firstStr(j.employmentType),
    workplaceType: firstStr(j.workplaceType),
    remote,
    publishedAt: firstStr(j.publishedAt),
    compensation: comp,
  };
}

function ashbyApiUrl(token: string): string {
  const u = new URL(`/posting-api/job-board/${encodeURIComponent(token)}`, `https://${API_HOST}`);
  u.searchParams.set("includeCompensation", "true");
  return u.href;
}

export const ashbyListAdapter: PlatformAdapter = {
  id: "ashby",
  detect(ctx: { url: string; contentType?: string; html?: string }): DetectResult | null {
    const byUrl = extractAshbyToken(ctx.url);
    if (byUrl) {
      return { adapterId: "ashby", label: "Ashby", detectedFrom: byUrl.from, confidence: 1 };
    }
    if (ctx.html) {
      const token = detectAshbyEmbed(ctx.html);
      if (token) {
        return { adapterId: "ashby", label: "Ashby", detectedFrom: "embed-script", confidence: 0.8 };
      }
    }
    return null;
  },
  async resolve(input: ResolveInput, fetcher: FetcherPort): Promise<ResolveResult> {
    const byUrl = extractAshbyToken(input.url);
    const token = byUrl?.token ?? null;
    if (!token) throw new Error("ashby board slug not found");
    const apiUrl = ashbyApiUrl(token);
    const board = await fetchAtsBoard(fetcher, apiUrl, { maxBytes: input.maxBytes, timeoutMs: input.timeoutMs, maxHops: input.maxHops });
    if (!board) throw new Error("ashby board not reachable");
    const jobsNode = (board.data as Record<string, unknown> | null)?.jobs;
    if (!Array.isArray(jobsNode)) throw new Error("ashby board returned no jobs array");
    // Ashby marks direct-link-only postings `isListed:false` — they are intentionally hidden from the
    // public board, so exclude them from the roster AND the count before capping/normalizing.
    const listed = jobsNode.filter((j) => j && typeof j === "object" && (j as Record<string, unknown>).isListed !== false);
    const rawCount = listed.length;
    // Cap the INPUT before normalizing (cap-then-map): a large/malicious board must not pin the
    // event loop normalizing 100k+ jobs only to slice them away. rawCount reports the public board size.
    const { jobs: cappedInput, truncated } = capJobs(listed);
    const normalized = cappedInput
      .map((j) => (j && typeof j === "object" ? normalizeAshbyJob(j as Record<string, unknown>) : null))
      .filter((j): j is NormalizedJob => j !== null);
    const envelope = boardEnvelope("ashby", token, rawCount, normalized, truncated);
    return {
      content: JSON.stringify(envelope),
      contentType: "application/json",
      finalUrl: board.finalUrl || apiUrl,
      redirects: board.redirects,
      bytes: board.bytes,
      contentSha256: board.fetchedSha256,
      title: `${envelope.jobCount} open role${envelope.jobCount === 1 ? "" : "s"} · Ashby · ${token}`,
    };
  },
};
