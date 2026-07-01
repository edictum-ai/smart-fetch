/**
 * Client-aware output shaping (#45). Different MCP connectors render the tool
 * result differently — e.g. Claude Code surfaces the `content` text but not the
 * full `structuredContent`, so diagnostics placed only in structuredContent
 * (the `debug` fields) are invisible there. A client "profile" tunes the output
 * shape per OAuth `client_id`; the clientId→profile mapping is env-configured
 * (`CAPTATUM_CLIENT_PROFILES`) because the registered connector client_ids are
 * deployment-specific. Unknown / local clients get the DEFAULT profile (= today's
 * behavior), so this is purely additive + backward-compatible.
 *
 * The registered connector client_ids can be discovered from the audit log
 * (`audit.tool` events carry `clientId` per call) and mapped here, e.g.
 *   CAPTATUM_CLIENT_PROFILES="claude-code-client-id=text-forward"
 */

export type ClientProfileName = "default" | "text-forward";

export interface ClientProfile {
  /** Surface a compact diagnostics block in `content[0].text` when `debug` is on,
   *  for clients that render the text channel but not `structuredContent`. */
  textDebug: boolean;
}

const PROFILES: Record<ClientProfileName, ClientProfile> = {
  default: { textDebug: false },
  "text-forward": { textDebug: true },
};

export const DEFAULT_CLIENT_PROFILE: ClientProfile = PROFILES.default;

/** clientId → profile-name map, parsed from `CAPTATUM_CLIENT_PROFILES`. Unknown
 *  profile names are ignored (fall back to default) so a typo can't enable a
 *  nonexistent shape. */
export type ClientProfileMap = Map<string, ClientProfileName>;

export function parseClientProfileMap(value: string | undefined): ClientProfileMap {
  const map: ClientProfileMap = new Map();
  if (!value) return map;
  for (const pair of value.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const clientId = pair.slice(0, eq).trim();
    const name = pair.slice(eq + 1).trim();
    if (clientId && name in PROFILES) map.set(clientId, name as ClientProfileName);
  }
  return map;
}

/** Resolve the profile for a client_id (default for unknown/local/absent). */
export function resolveClientProfile(clientId: string | undefined, map: ClientProfileMap): ClientProfile {
  if (!clientId) return DEFAULT_CLIENT_PROFILE;
  const name = map.get(clientId);
  return name ? PROFILES[name] : DEFAULT_CLIENT_PROFILE;
}
