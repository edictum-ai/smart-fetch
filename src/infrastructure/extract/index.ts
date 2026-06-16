import type { StructuredData } from "../../domain/platform.ts";
import type { ProvenanceError } from "../../domain/result.ts";
import type { ShellGateEvidence } from "../../domain/shell-gate.ts";
import { extractVisibleText } from "./html.ts";
import { extractPageMetadata } from "./metadata.ts";
import { evaluateShellGate } from "./shell-gate.ts";

export interface HtmlExtractionInput {
  html: string;
  url: string;
  contentType?: string;
}

export interface HtmlExtraction {
  title?: string;
  text: string;
  structured: StructuredData;
  shellGate: ShellGateEvidence;
  errors: ProvenanceError[];
}

export function extractHtml(input: HtmlExtractionInput): HtmlExtraction {
  const errors = [] as ProvenanceError[];
  const metadata = extractPageMetadata(input.html, input.url, errors);
  const text = extractVisibleText(input.html);
  const shellGate = evaluateShellGate({
    html: input.html,
    text,
    structured: metadata.structured,
  });

  return {
    title: metadata.title,
    text,
    structured: metadata.structured,
    shellGate,
    errors,
  };
}

export function hasStructuredFields(structured: StructuredData): boolean {
  return Object.keys(structured).length > 0;
}

export { evaluateShellGate, hasUsableStructuredData } from "./shell-gate.ts";
