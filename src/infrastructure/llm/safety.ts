/**
 * Detect ACTUAL leaked credential VALUES in fetched content — not topic words.
 *
 * The earlier version matched the words "secret"/"password"/"cookie"/"api_key",
 * which false-positived on any page that merely DISCUSSES security (e.g. a
 * security product's marketing page, or any page with a cookie notice). That
 * silently degraded the default summary to raw for ordinary public pages.
 *
 * Value-based detection is strictly better: it catches real leaked secrets
 * (token prefixes, PEM headers, signed URLs) without flagging discussion text.
 * Security-relevant change — reflect in docs/threat-model.md.
 */
const SENSITIVE_CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/i,
  /\bgh[opsu]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[bp]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const SENSITIVE_HEADER_PATTERNS = [
  /[Aa]uthorization:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/,
  /[Ss]et-[Cc]ookie:\s*[^=\s;]{1,64}=[^;\s<]{16,}/,
];

const SIGNED_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "auth",
  "expires",
  "key",
  "signature",
  "sig",
  "token",
  "x-amz-credential",
  "x-amz-signature",
  "x-goog-signature",
]);

export interface SensitivitySignal {
  sensitive: boolean;
  reason?: string;
}

export function detectSensitiveTransformInput(input: {
  content: string;
  sourceUrl?: string;
}): SensitivitySignal {
  const urlReason = input.sourceUrl ? signedUrlReason(input.sourceUrl) : undefined;
  if (urlReason) return { sensitive: true, reason: urlReason };

  const content = input.content ?? "";
  for (const pattern of SENSITIVE_CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) return { sensitive: true, reason: "content_credential_signal" };
  }
  for (const pattern of SENSITIVE_HEADER_PATTERNS) {
    if (pattern.test(content)) return { sensitive: true, reason: "content_header_dump" };
  }
  return { sensitive: false };
}

function signedUrlReason(sourceUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return undefined;
  }

  for (const key of parsed.searchParams.keys()) {
    if (SIGNED_QUERY_KEYS.has(key.toLowerCase())) return "signed_or_tokenized_url";
  }
  return undefined;
}
