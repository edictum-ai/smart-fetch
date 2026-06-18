import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from "jose";

/**
 * Verifies a Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) so the OAuth
 * subject is the real authenticated email, not a hardcoded placeholder. Ported
 * from personal-memory-gateway. RS256 against Cloudflare's public JWKS,
 * audience + issuer checked, email constrained to the allowed address.
 */
export interface CloudflareAccessJwtConfig {
  allowedEmail: string;
  audience: string;
  certsUrl: string;
  issuer: string;
}

export interface VerifiedCloudflareAccessJwt {
  audience: string;
  email: string;
  expiresAt: number;
  issuedAt?: number;
  subject: string;
}

type AccessJwtPayload = JWTPayload & { email?: string };

export type JwtVerifyResult =
  | { ok: true; claims: VerifiedCloudflareAccessJwt }
  | { ok: false; reason: string };

export function createCloudflareAccessJwtVerifier(config: CloudflareAccessJwtConfig) {
  const jwks = createRemoteJWKSet(new URL(config.certsUrl), { cacheMaxAge: 5 * 60 * 1000 });

  return async (token: string): Promise<JwtVerifyResult> => {
    try {
      const result = await jwtVerify<AccessJwtPayload>(token, jwks, {
        algorithms: ["RS256"],
        audience: config.audience,
        clockTolerance: 60,
        issuer: config.issuer,
      });
      return validateClaims(result.payload, config);
    } catch (error) {
      return { ok: false, reason: jwtErrorReason(error) };
    }
  };
}

function validateClaims(payload: AccessJwtPayload, config: CloudflareAccessJwtConfig): JwtVerifyResult {
  if (!payload.exp) return { ok: false, reason: "access_jwt_missing_expiry" };
  if (!payload.email || payload.email.toLowerCase() !== config.allowedEmail.toLowerCase()) {
    return { ok: false, reason: "access_jwt_email_not_allowed" };
  }
  return {
    ok: true,
    claims: {
      audience: config.audience,
      email: payload.email,
      expiresAt: payload.exp,
      issuedAt: payload.iat,
      subject: payload.sub ?? payload.email,
    },
  };
}

function jwtErrorReason(error: unknown): string {
  if (error instanceof errors.JWTExpired) return "access_jwt_expired";
  if (error instanceof errors.JWTClaimValidationFailed) return "access_jwt_bad_claim";
  if (error instanceof errors.JOSEAlgNotAllowed) return "access_jwt_unsupported_alg";
  if (error instanceof errors.JWKSNoMatchingKey) return "access_jwt_unknown_key";
  if (error instanceof errors.JOSEError) return "access_jwt_invalid";
  return "access_jwt_verify_failed";
}
