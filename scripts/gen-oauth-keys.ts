#!/usr/bin/env -S node --no-warnings
// Generate the hosted-flavor OAuth signing material as export-ready env lines:
//   - OAUTH_SIGNING_PRIVATE_JWK  — an EC P-256 private key (signs access tokens)
//   - OAUTH_CONSENT_SIGNING_SECRET — 32-byte secret (signs consent cookies)
//   - OAUTH_SIGNING_KEY_ID        — short id for the JWKS / key rotation
//
// Run once per deploy; persist the output as secrets. Re-running regenerates all
// three (rotate by re-running and re-issuing tokens).
//
//   node --no-warnings scripts/gen-oauth-keys.ts
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
const consentSecret = randomBytes(32).toString("base64url");

process.stdout.write(
  [
    "# captatum hosted OAuth signing material — store these as secrets.",
    "# Copy into .env (or your secret store). Never commit.",
    `OAUTH_SIGNING_KEY_ID='${randomBytes(4).toString("hex")}'`,
    `OAUTH_SIGNING_PRIVATE_JWK='${JSON.stringify(jwk)}'`,
    `OAUTH_CONSENT_SIGNING_SECRET='${consentSecret}'`,
    "",
  ].join("\n"),
);
