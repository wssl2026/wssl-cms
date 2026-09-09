/**
 * Verification of the Cloudflare Access JWT that fronts /admin and /api/cms.
 *
 * Access mints an RS256 token per signed-in editor and injects it as the
 * `Cf-Access-Jwt-Assertion` header on every request it proxies. The token is only
 * meaningful if it was signed by *our* team's keys (issuer) and minted for *our*
 * Access application (aud) — a token for any other application on the same team, or
 * for another team entirely, must not open the editor.
 */
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';

export type FetchImpl = typeof fetch;

export interface VerifyAccessJwtOptions {
  /** e.g. `wssl.cloudflareaccess.com`; a full `https://…` URL is accepted too. */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string;
  /** Injected in tests; defaults to the platform fetch. */
  fetchImpl?: FetchImpl;
  /** Injected in tests; defaults to now. */
  now?: Date;
}

export interface AccessIdentity {
  email: string;
}

export class AccessJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessJwtError';
  }
}

type JwksResolver = ReturnType<typeof createRemoteJWKSet>;

// jose caches keys inside the resolver, so one resolver per (fetch, team domain) keeps
// a warm isolate from re-fetching the JWKS on every edit. Keying on the fetch as well
// means an injected fetch never inherits another one's cached keys.
const resolvers = new WeakMap<FetchImpl, Map<string, JwksResolver>>();

function jwksResolver(certsUrl: string, fetchImpl: FetchImpl): JwksResolver {
  let byUrl = resolvers.get(fetchImpl);
  if (!byUrl) {
    byUrl = new Map();
    resolvers.set(fetchImpl, byUrl);
  }
  let resolver = byUrl.get(certsUrl);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(certsUrl), {
      [customFetch]: fetchImpl as never,
    });
    byUrl.set(certsUrl, resolver);
  }
  return resolver;
}

/** `wssl.cloudflareaccess.com`, `https://wssl.cloudflareaccess.com/` → `wssl.cloudflareaccess.com`. */
export function normalizeTeamDomain(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('/')) throw new AccessJwtError('CF_ACCESS_TEAM_DOMAIN is not a bare team domain');
  return trimmed;
}

/**
 * Resolves to the signed-in editor's email, or throws. Every failure — a malformed
 * token, the wrong signer, the wrong application, an expired session, a token with no
 * email — is a rejection; callers turn that into a 401.
 */
export async function verifyAccessJwt(token: string, options: VerifyAccessJwtOptions): Promise<AccessIdentity> {
  const { aud, fetchImpl = fetch, now } = options;
  if (!token) throw new AccessJwtError('missing Access token');
  if (!aud) throw new AccessJwtError('missing Access application audience');

  const domain = normalizeTeamDomain(options.teamDomain);
  const issuer = `https://${domain}`;
  const jwks = jwksResolver(`${issuer}/cdn-cgi/access/certs`, fetchImpl);

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: aud,
      algorithms: ['RS256'],
      ...(now ? { currentDate: now } : {}),
    }));
  } catch (e) {
    throw new AccessJwtError(`Access token rejected: ${e instanceof Error ? e.message : 'unknown error'}`);
  }

  const email = payload.email;
  if (typeof email !== 'string' || !email) {
    throw new AccessJwtError('Access token carries no email claim');
  }
  return { email };
}
