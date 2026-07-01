import { STATUS_CODES } from "node:http";
import type { PlatformAdapterRegistry } from "../ports/platform-adapter.ts";
import type { FetcherPort } from "../ports/fetcher.ts";
import type { ClockPort } from "../ports/clock.ts";
import { sha256Hex, type Result } from "../../domain/result.ts";
import type { DetectResult, ResolveResult } from "../../domain/platform.ts";

export interface Tier2ShortCircuitInput {
  adapters: PlatformAdapterRegistry;
  url: string;
  now: string;
  fetcher: FetcherPort;
  clock: ClockPort;
  /** Caller-injected fetch timestamp (hosted audit provenance); optional. */
  fetchedAt?: string;
  /** Caller-inherited fetch caps (clamped to the server hard cap); applied as min(cap, ATS limit). */
  maxBytes?: number;
  timeoutMs?: number;
  maxHops?: number;
}

/**
 * Pre-fetch Tier-2 short-circuit. If a registered adapter detects the URL (a
 * deterministic URL-host match), resolve via the platform's public list API and
 * build a complete tier-2 Result, bypassing the generic fetch/render. On no
 * detection, OR any resolve failure (404, parse, network, thrown), returns null
 * so the caller falls through to the normal Tier-1 path — Tier-2 is strictly
 * best-effort and never blocks the generic path.
 */
export async function tryTier2ShortCircuit(input: Tier2ShortCircuitInput): Promise<Result | null> {
  // The short-circuit rebuilds a fresh API URL from the detected hostname, which would otherwise
  // bypass fetchGuarded's explicit-port guard on the ORIGINAL url (e.g. boards.greenhouse.io:22).
  // If the original URL carries an explicit port, do not short-circuit — let the generic path run so
  // the port guard (blocked_port) is enforced on the URL the caller actually supplied.
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return null;
  }
  if (parsed.port) return null;
  const detected = input.adapters.detect({ url: input.url });
  if (!detected) return null;
  const adapter = input.adapters.get(detected.adapterId);
  if (!adapter) return null;
  const startMs = input.clock.nowMs();
  try {
    const resolved = await adapter.resolve({ url: input.url, now: input.now, maxBytes: input.maxBytes, timeoutMs: input.timeoutMs, maxHops: input.maxHops }, input.fetcher);
    const fetchMs = Math.max(0, input.clock.nowMs() - startMs);
    return tier2Result(detected, resolved, input.url, fetchMs, input.fetchedAt);
  } catch {
    return null;
  }
}

/** Build a full Result from a resolved Tier-2 payload (mirrors the shape
 *  extractTier1FromFetchResult produces, but tier 2 + the resolved JSON body). */
function tier2Result(
  detected: DetectResult,
  resolved: ResolveResult,
  requestedUrl: string,
  fetchMs: number,
  fetchedAt?: string,
): Result {
  // `bytes` reports the bytes FETCHED from the platform API (egress/audit), matching Tier-1
  // semantics — NOT the normalized roster size (which drops descriptions, so it would underreport
  // egress by megabytes on e.g. Lever). Falls back to the content size if an adapter omits it.
  const bytes = resolved.bytes ?? Buffer.byteLength(resolved.content, "utf8");
  const code = 200;
  return {
    url: requestedUrl,
    bytes,
    code,
    codeText: STATUS_CODES[code] ?? "OK",
    durationMs: fetchMs,
    result: resolved.content,
    schemaVersion: 1,
    finalUrl: resolved.finalUrl || requestedUrl,
    redirects: resolved.redirects ?? [],
    tier: 2,
    output: "raw",
    platform: {
      adapterId: detected.adapterId,
      label: detected.label,
      detectedFrom: detected.detectedFrom,
    },
    jsRequired: false,
    resolvedVia: `tier2-${detected.adapterId}`,
    attempts: [{ step: 2, tier: 2, outcome: "ok", status: code, durationMs: fetchMs, bytes }],
    contentType: resolved.contentType || "application/json",
    title: resolved.title,
    // Hash the FETCHED API payload (content-addressable evidence of what was retrieved), matching
    // Tier-1's sha256 over the fetched HTML — NOT the normalized roster, which drops fields (e.g.
    // Lever descriptions) so it would not change when the fetched evidence changes.
    contentSha256: resolved.contentSha256 ?? sha256Hex(resolved.content),
    timings: { totalMs: fetchMs, fetchMs },
    errors: [],
    ...(fetchedAt !== undefined ? { fetchedAt } : {}),
  };
}
