import type {
  AuthCodeRecord,
  RefreshTokenRecord,
  SaveAuthCodeInput,
  SaveRefreshTokenInput,
} from "../../application/ports/store.ts";
import {
  StoreInputError,
  assertSha256Hex,
  assertUtcIsoTimestamp,
} from "../../application/ports/store.ts";

export interface AuthCodeRow {
  code_hash: string;
  client_id: string;
  subject: string;
  redirect_uri: string;
  resource: string;
  scopes_json: string;
  code_challenge: string;
  code_challenge_method: "S256";
  expires_at: string;
}

export interface RefreshTokenRow {
  token_hash: string;
  family_id: string;
  previous_token_hash: string | null;
  client_id: string;
  subject: string;
  scopes_json: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export function validateAuthCode(input: SaveAuthCodeInput): void {
  assertSha256Hex(input.codeHash, "codeHash");
  assertUtcIsoTimestamp(input.expiresAt, "expiresAt");
  if (input.codeChallengeMethod !== "S256") {
    throw new StoreInputError("codeChallengeMethod must be S256");
  }
}

export function validateRefreshToken(input: SaveRefreshTokenInput): void {
  assertSha256Hex(input.tokenHash, "tokenHash");
  if (input.previousTokenHash !== null) {
    assertSha256Hex(input.previousTokenHash, "previousTokenHash");
  }
  assertUtcIsoTimestamp(input.expiresAt, "expiresAt");
}

export function validateRotation(
  tokenHash: string,
  next: SaveRefreshTokenInput,
  nowIso: string,
): void {
  assertSha256Hex(tokenHash, "tokenHash");
  validateRefreshToken(next);
  assertUtcIsoTimestamp(nowIso, "nowIso");
  if (next.previousTokenHash !== tokenHash) {
    throw new StoreInputError("next.previousTokenHash must match tokenHash");
  }
}

export function authCodeFromRow(row: AuthCodeRow): AuthCodeRecord {
  return {
    codeHash: row.code_hash,
    clientId: row.client_id,
    subject: row.subject,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scopes: parseScopes(row.scopes_json),
    codeChallenge: row.code_challenge,
    codeChallengeMethod: row.code_challenge_method,
    expiresAt: row.expires_at,
  };
}

export function refreshTokenFromRow(row: RefreshTokenRow): RefreshTokenRecord {
  return {
    tokenHash: row.token_hash,
    familyId: row.family_id,
    previousTokenHash: row.previous_token_hash,
    clientId: row.client_id,
    subject: row.subject,
    scopes: parseScopes(row.scopes_json),
    expiresAt: row.expires_at,
  };
}

function parseScopes(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
    throw new Error("Stored scopes are invalid");
  }
  return parsed;
}
