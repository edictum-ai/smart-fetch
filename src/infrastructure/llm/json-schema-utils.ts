export interface SchemaValidationResult {
  valid: boolean;
  message?: string;
  /**
   * Set when validation failed because the schema used a keyword this validator
   * does not support (and therefore cannot check). Callers distinguish this from
   * a supported-keyword value mismatch: an unsupported keyword cannot be
   * verified, so the safe behavior is to fail closed rather than accept
   * unvalidated structured data.
   */
  unsupported?: boolean;
}

export function schemaList(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: unknown[] } {
  if (value === undefined) return { valid: true, value: [] };
  return Array.isArray(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an array`, value: [] };
}

export function objectMap(
  value: unknown,
  key: string,
  path: string,
): SchemaValidationResult & { value: Record<string, unknown> } {
  if (value === undefined) return { valid: true, value: {} };
  return isRecord(value)
    ? { valid: true, value }
    : { valid: false, message: `${path} schema ${key} must be an object`, value: {} };
}

export function nonNegativeInteger(
  schema: Record<string, unknown>,
  key: string,
  path: string,
): SchemaValidationResult {
  if (!(key in schema)) return ok();
  return Number.isInteger(schema[key]) && Number(schema[key]) >= 0
    ? ok()
    : invalid(`${path} schema ${key} must be a non-negative integer`);
}

const MAX_PATTERN_LENGTH = 128;

export function toRegExp(pattern: string, path: string): SchemaValidationResult & { value: RegExp } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { valid: false, unsupported: true, message: `${path} schema pattern is too long (>${MAX_PATTERN_LENGTH} chars)`, value: /$./ };
  }
  if (isLikelyCatastrophicPattern(pattern)) {
    return { valid: false, unsupported: true, message: `${path} schema pattern may cause catastrophic backtracking`, value: /$./ };
  }
  try {
    return { valid: true, value: new RegExp(pattern) };
  } catch {
    return { valid: false, message: `${path} schema pattern is invalid`, value: /$./ };
  }
}

/**
 * Reject the classic ReDoS shape: a quantified group that itself contains a
 * quantifier — e.g. (a+)+, (a*)*, (a?)+ — which backtracks exponentially
 * (TRANSFORM-2/REDOS-5). This is a heuristic (overlapping alternations like
 * (a|a)+ can also be catastrophic); RE2 is the bulletproof follow-up. Returns
 * true (unsafe) on a nested-quantifier construct.
 */
function isLikelyCatastrophicPattern(pattern: string): boolean {
  const isQuantifier = (ch: string | undefined): boolean =>
    ch === "*" || ch === "+" || ch === "?" || ch === "{";
  const groupHadQuantifier: boolean[] = [];
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === "(") {
      groupHadQuantifier.push(false);
    } else if (ch === ")" && groupHadQuantifier.length > 0) {
      const had = groupHadQuantifier.pop() ?? false;
      if (had && isQuantifier(pattern[index + 1])) return true;
      // Propagate: a quantified inner group makes the enclosing group "quantified"
      // too, so wrapped patterns like ((a+))+ are caught.
      if (had && groupHadQuantifier.length > 0) {
        groupHadQuantifier[groupHadQuantifier.length - 1] = true;
      }
    } else if (isQuantifier(ch) && groupHadQuantifier.length > 0) {
      groupHadQuantifier[groupHadQuantifier.length - 1] = true;
    }
  }
  return false;
}

export function matchesType(value: unknown, type: string): boolean {
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return isRecord(value);
  if (type === "null") return value === null;
  return typeof value === type;
}

export function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? text;
}

export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function ok(): SchemaValidationResult {
  return { valid: true };
}

export function invalid(message: string): SchemaValidationResult {
  return { valid: false, message };
}

export function unsupported(message: string): SchemaValidationResult {
  return { valid: false, message, unsupported: true };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Deterministic JSON so two objects equal up to key order compare equal —
 * uniqueItems/enum/const must treat {a:1,b:2} and {b:2,a:1} as the same value,
 * and JSON.stringify preserves insertion order (so it would not). Recursively
 * sorts object keys; arrays preserve order.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hasDuplicate(values: unknown[]): boolean {
  return values.some((value, index) => values.findIndex((other) => deepEqual(value, other)) !== index);
}

export function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < Number.EPSILON * 100;
}
