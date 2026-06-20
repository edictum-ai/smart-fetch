import type { Result } from "../../domain/result.ts";

/**
 * Build the content sent to the transform model. Prepends the page's extracted
 * metadata (title + OG/meta description) so the model has it even when the body
 * is gated or thin (e.g. Pinterest OG-meta-only pages where the body is behind a
 * login wall). JSON-LD, when present, is appended as verified structured data.
 */
export function transformContent(base: Result): string {
  const og = base.structured?.og;
  const description = og?.["og:description"] ?? base.structured?.meta?.description;
  const meta = [
    base.title ? `Title: ${base.title}` : null,
    description ? `Description: ${description}` : null,
  ].filter((line): line is string => line !== null);
  const jsonLd = base.structured?.jsonLd
    ? `\n\n--- Verified structured data (JSON-LD) — prefer these fields ---\n${JSON.stringify(base.structured.jsonLd, null, 2)}`
    : "";
  const preamble = meta.length > 0 ? `${meta.join("\n")}\n\n` : "";
  return `${preamble}${base.result}${jsonLd}`;
}
