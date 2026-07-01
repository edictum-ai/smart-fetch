import { STATUS_CODES } from "node:http";
import { computeProvenanceHash, type Result } from "../../domain/result.ts";
import type { RejectResult } from "../ports/fetcher.ts";
import { errorMessage } from "./result-excerpt.ts";

/**
 * Small pure helpers shared by the Captatum use case + its output-mode step.
 * Extracted so captatum.ts stays within the file-size limit when new orchestration
 * (e.g. Tier-2 short-circuit) is added; these have no deps on the use case itself.
 */

/** Stamp total/fetch timings, derived HTTP code text, and the provenance hash. */
export function stampTotals(result: Result, totalMs: number, fetchMs: number): void {
  result.durationMs = totalMs;
  result.timings.totalMs = totalMs;
  result.timings.fetchMs = fetchMs;
  result.codeText = result.code === 0 ? result.codeText : STATUS_CODES[result.code] ?? "";
  result.provenanceHash = computeProvenanceHash(result);
}

/** Map a thrown fetch error to a safe RejectResult (the fetch never produced a guarded response). */
export function unexpectedReject(error: unknown): RejectResult {
  return {
    rejected: true,
    code: "network_error",
    message: errorMessage(error, "Fetch failed before a safe response was available"),
  };
}

/** Non-negative rounded elapsed milliseconds between two clock readings. */
export function elapsed(startMs: number, endMs: number): number {
  return Math.max(0, Math.round(endMs - startMs));
}
