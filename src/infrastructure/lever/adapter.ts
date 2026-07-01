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
  epochMsToIso,
  firstStr,
  sanitizeAtsToken,
  type NormalizedJob,
} from "../ats/types.ts";

/**
 * Lever Tier-2 list adapter. Detects a Lever board URL/host → lists ALL
 * postings via the public postings API. Verified: GET
 * https://api.lever.co/v0/postings/{site}?mode=json  → bare JSON array (`mode=
 * markdown` is 406 Not Acceptable; the brief was wrong). Lever payloads embed
 * full descriptions, so a 388-posting demo board is ~2.4MB raw — normalization
 * drops them and the cap bounds the roster. Unknown site → 404 (graceful).
 */

const BOARD_HOST = "jobs.lever.co";
const BOARD_HOST_EU = "jobs.eu.lever.co";
const API_HOST = "api.lever.co";
const API_HOST_EU = "api.eu.lever.co"; // verified: same /v0/postings/{site}?mode=json shape for EU-resident boards

function isLeverBoardHost(host: string): boolean {
  return host === BOARD_HOST || host === BOARD_HOST_EU || host === `www.${BOARD_HOST}` || host === `www.${BOARD_HOST_EU}`;
}
function isLeverApiHost(host: string): boolean {
  return host === API_HOST || host === API_HOST_EU || host === `www.${API_HOST}` || host === `www.${API_HOST_EU}`;
}
function isLeverEuHost(host: string): boolean {
  return host === BOARD_HOST_EU || host === `www.${BOARD_HOST_EU}` || host === API_HOST_EU || host === `www.${API_HOST_EU}`;
}

/** Extract + sanitize the Lever site, flagging the EU instance (routed to api.eu.lever.co). */
export function extractLeverToken(url: string): { token: string; from: string; eu: boolean } | null {
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
  if (isLeverBoardHost(host)) {
    // Claim ONLY the board root (exactly 1 segment). /{site}/{postingId} is a single posting;
    // let it fall through to Tier-1 instead of returning the roster.
    if (segments.length !== 1) return null;
    raw = segments[0]!;
    from = "url-host";
  } else if (isLeverApiHost(host)) {
    // Exact list endpoint only: /v0/postings/{site} — anchored to the canonical segment sequence.
    if (segments.length !== 3) return null;
    if (segments[0]!.toLowerCase() !== "v0" || segments[1]!.toLowerCase() !== "postings") return null;
    raw = segments[2]!;
    from = "api-host";
  }
  const token = sanitizeAtsToken(raw);
  return token ? { token, from, eu: isLeverEuHost(host) } : null;
}

/** Discover the site from an embedding page's HTML. The postings-API URL is the
 *  cleanest embed signal; falls back to a board-root reference. Conservative +
 *  bounded. Not wired into the orchestrator yet (URL-host detection is the
 *  deterministic path); exercised by unit tests. */
export function detectLeverEmbed(html: string): string | null {
  const api = /api\.lever\.co\/v0\/postings\/([A-Za-z0-9._-]{1,128})/;
  const m1 = api.exec(html);
  if (m1) return sanitizeAtsToken(m1[1]);
  const board = /jobs\.lever\.co\/([A-Za-z0-9._-]{1,128})(?=["'/?#]|$)/;
  const m2 = board.exec(html);
  return m2 ? sanitizeAtsToken(m2[1]) : null;
}

/** Lever pay: prefer the pre-formatted description, else format salaryRange {min,max,currency,interval}. */
function leverCompensation(j: Record<string, unknown>): string | null {
  const desc = firstStr(j.salaryDescriptionPlain);
  if (desc) return desc;
  const sr = j.salaryRange;
  if (sr && typeof sr === "object") {
    const { min, max, currency, interval } = sr as Record<string, unknown>;
    if (typeof min === "number" || typeof max === "number") {
      const range = typeof min === "number" && typeof max === "number" ? `${min}-${max}` : String(min ?? max);
      return [firstStr(currency), range, firstStr(interval)].filter(Boolean).join(" ");
    }
  }
  return null;
}

function normalizeLeverJob(j: Record<string, unknown>): NormalizedJob | null {
  const id = firstStr(j.id);
  const title = firstStr(j.text); // Lever uses `text`, not `title`
  const url = firstStr(j.hostedUrl);
  if (!id && !title && !url) return null;
  const cats = j.categories && typeof j.categories === "object"
    ? (j.categories as Record<string, unknown>)
    : {};
  return {
    id: id ?? url ?? title ?? "",
    title: title ?? id ?? "",
    url: url ?? "",
    location: firstStr(cats.location),
    department: firstStr(cats.department),
    team: firstStr(cats.team),
    employmentType: firstStr(cats.commitment),
    workplaceType: firstStr(j.workplaceType),
    remote: null,
    publishedAt: epochMsToIso(j.createdAt),
    compensation: leverCompensation(j),
  };
}

function leverApiUrl(token: string, eu: boolean, originalUrl?: string): string {
  const u = new URL(`/v0/postings/${encodeURIComponent(token)}`, `https://${eu ? API_HOST_EU : API_HOST}`);
  u.searchParams.set("mode", "json");
  // Preserve the caller's list filters (department, team, skip, limit, …) from an API-host URL so a
  // request like ?department=Legal returns that filtered roster, not the default. `mode` stays forced.
  if (originalUrl) {
    try {
      for (const [k, v] of new URL(originalUrl).searchParams) {
        if (k.toLowerCase() !== "mode") u.searchParams.set(k, v);
      }
    } catch {
      // malformed original — fall back to the rebuilt URL with mode=json only.
    }
  }
  return u.href;
}

export const leverAdapter: PlatformAdapter = {
  id: "lever",
  detect(ctx: { url: string; contentType?: string; html?: string }): DetectResult | null {
    const byUrl = extractLeverToken(ctx.url);
    if (byUrl) {
      return { adapterId: "lever", label: "Lever", detectedFrom: byUrl.from, confidence: 1 };
    }
    if (ctx.html) {
      const token = detectLeverEmbed(ctx.html);
      if (token) {
        return { adapterId: "lever", label: "Lever", detectedFrom: "embed-script", confidence: 0.8 };
      }
    }
    return null;
  },
  async resolve(input: ResolveInput, fetcher: FetcherPort): Promise<ResolveResult> {
    const byUrl = extractLeverToken(input.url);
    const token = byUrl?.token ?? null;
    if (!token) throw new Error("lever site not found");
    const apiUrl = leverApiUrl(token, byUrl?.eu ?? false, input.url);
    const board = await fetchAtsBoard(fetcher, apiUrl, { maxBytes: input.maxBytes, timeoutMs: input.timeoutMs, maxHops: input.maxHops });
    if (!board) throw new Error("lever board not reachable");
    if (!Array.isArray(board.data)) throw new Error("lever board returned no postings array");
    const rawCount = board.data.length;
    // Cap the INPUT before normalizing (cap-then-map): a large/malicious board must not pin the
    // event loop normalizing 100k+ postings only to slice them away. rawCount reports the true size.
    const { jobs: cappedInput, truncated } = capJobs(board.data);
    const normalized = cappedInput
      .map((j) => (j && typeof j === "object" ? normalizeLeverJob(j as Record<string, unknown>) : null))
      .filter((j): j is NormalizedJob => j !== null);
    const envelope = boardEnvelope("lever", token, rawCount, normalized, truncated);
    return {
      content: JSON.stringify(envelope),
      contentType: "application/json",
      finalUrl: board.finalUrl || apiUrl,
      redirects: board.redirects,
      bytes: board.bytes,
      contentSha256: board.fetchedSha256,
      title: `${envelope.jobCount} open role${envelope.jobCount === 1 ? "" : "s"} · Lever · ${token}`,
    };
  },
};
