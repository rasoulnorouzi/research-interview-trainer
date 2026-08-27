// Instructor identity for /api/admin/*, from Cloudflare Access.
// BACKEND-PLAN.md §7: Access is the instructor login, and there is deliberately
// no second authentication system in this app. The Worker only learns *which*
// instructor is acting, so every change is attributable in updated_by/saved_by.
//
// The header is verified as a real JWT, not trusted for being present. Anyone
// can set Cf-Access-Jwt-Assertion on a request to the Worker's origin; only
// Access can produce one that verifies against the team's JWKS.

import { b64urlDecode } from "./auth";
import type { Env } from "./db";

interface AccessJwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface AccessClaims {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  email?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;

// Module-scope cache, public keys only. Settings are never cached this way
// (see db.ts); a JWKS is not instructor-editable state and rotates on its own
// schedule, so an hour of staleness costs nothing and a refetch covers rotation.
let jwksCache: { domain: string; keys: AccessJwk[]; fetchedAt: number } | null = null;

export async function identifyInstructor(request: Request, env: Env): Promise<{ email: string } | null> {
  const domain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const audience = (env.ACCESS_AUD ?? "").trim();

  if (domain === "" || audience === "") {
    // Fail closed. An unconfigured Access setup must reject, not wave through:
    // the admin surface owns the roster, the personas and the OpenAI key.
    if (env.DEV_ALLOW_INSECURE_ADMIN === "1") return { email: "dev@localhost" };
    return null;
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(decodeUtf8(b64urlDecode(parts[0]))) as { alg?: string; kid?: string };
    // Pin the algorithm. Accepting whatever the header names is how "alg: none"
    // and RS256-to-HS256 confusion get in.
    if (header.alg !== "RS256" || !header.kid) return null;

    let jwk = await findKey(domain, header.kid, false);
    if (!jwk) jwk = await findKey(domain, header.kid, true); // key rotated since the cache filled
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), signed);
    if (!valid) return null;

    const claims = JSON.parse(decodeUtf8(b64urlDecode(parts[1]))) as AccessClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    // Without the issuer and audience checks a valid token from any other
    // Access application would authenticate here.
    if (claims.iss !== `https://${domain}`) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === "string" ? [claims.aud] : [];
    if (!audiences.includes(audience)) return null;
    if (typeof claims.email !== "string" || claims.email === "") return null;

    return { email: claims.email.trim().toLowerCase() };
  } catch {
    return null;
  }
}

async function findKey(domain: string, kid: string, refresh: boolean): Promise<AccessJwk | null> {
  const fresh = jwksCache !== null && jwksCache.domain === domain && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (refresh || !fresh) {
    const response = await fetch(`https://${domain}/cdn-cgi/access/certs`);
    if (!response.ok) return null;
    const body = (await response.json()) as { keys?: AccessJwk[] };
    jwksCache = { domain, keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: Date.now() };
  }
  return jwksCache?.keys.find((key) => key.kid === kid) ?? null;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

