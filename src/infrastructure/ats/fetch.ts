import { createHash } from "node:crypto";
import type { FetcherPort } from "../../application/ports/fetcher.ts";
import { decodeBody } from "../http/body.ts";
import { parseSafeJson } from "../extract/safe-json.ts";
import { ATS_MAX_BYTES, ATS_MAX_HOPS, ATS_TIMEOUT_MS } from "./types.ts";

export interface AtsBoardFetch {
  /** Safe-parsed JSON value (prototype-pollution-safe reviver applied). */
  data: unknown;
  finalUrl: string;
  status: number;
  bytes: number;
  contentType: string;
  /** sha256 over the RAW decoded API text — content-addressable evidence of what was fetched
   *  (the normalized roster drops fields, so it cannot attest the fetched bytes). */
  fetchedSha256: string;
  /** Redirect chain the guarded fetch followed (provenance); empty when the API answered directly. */
  redirects: Array<{ url: string; status: number }>;
}

/**
 * Fetch an ATS list API (host already pinned by the caller) through the guarded
 * fetcher, decode, and safe-parse the body. Returns null on SSRF reject,
 * non-2xx status (unknown board → 404), or unparseable JSON — so the caller
 * signals "no Tier-2 result" and the orchestrator falls through to the generic
 * Tier-1 path. Every ATS egress goes through this so the FetcherPort (rebinding-
 * proof SSRF) + the byte cap + safe parse are enforced uniformly.
 *
 * `caller` carries the caller-inherited fetch caps (already clamped to the
 * server hard cap upstream); each is applied as min(caller, ATS platform limit)
 * so an ATS board cannot bypass a caller's maxBytes/timeoutMs nor the 5 MiB
 * server hard cap by using the larger ATS ceiling.
 */
export async function fetchAtsBoard(
  fetcher: FetcherPort,
  apiUrl: string,
  caller?: { maxBytes?: number; timeoutMs?: number; maxHops?: number },
): Promise<AtsBoardFetch | null> {
  const maxBytes = Math.min(ATS_MAX_BYTES, caller?.maxBytes ?? ATS_MAX_BYTES);
  const timeoutMs = Math.min(ATS_TIMEOUT_MS, caller?.timeoutMs ?? ATS_TIMEOUT_MS);
  const maxHops = Math.min(ATS_MAX_HOPS, caller?.maxHops ?? ATS_MAX_HOPS);
  const result = await fetcher.fetchGuarded(apiUrl, { maxBytes, timeoutMs, maxHops });
  if ("rejected" in result) return null;
  if (result.status < 200 || result.status >= 300) return null;
  // A byte-truncated body may parse as valid (but incomplete) JSON — e.g. a cut landing after
  // `}]}` would yield a syntactically-complete prefix of the first N jobs and be served as the
  // full roster with no provenance signal. Prefer a clean fall-through to the generic Tier-1 path.
  if (result.truncated) return null;
  let text: string;
  try {
    text = await decodeBody(result.bodyStream, result.contentType);
  } catch {
    return null;
  }
  const parsed = parseSafeJson(text);
  if (!parsed.ok) return null;
  return {
    data: parsed.value,
    finalUrl: result.finalUrl,
    status: result.status,
    bytes: result.bytes,
    contentType: result.contentType || "application/json",
    fetchedSha256: createHash("sha256").update(text).digest("hex"),
    redirects: result.redirects,
  };
}
