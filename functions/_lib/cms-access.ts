/**
 * Deciding who is asking, shared by `/api/cms/auth` and `/api/cms/gh/*`.
 *
 * Cloudflare Access fronts both routes, so a request only reaches them with a
 * `Cf-Access-Jwt-Assertion` header minted for our Access application. That header is the
 * only identity either route trusts. Keeping the decision in one place means the two
 * routes cannot drift into disagreeing about who an editor is — which is exactly the
 * disagreement the session token is checked against.
 */
import { verifyAccessJwt } from './access-jwt';

export interface CmsEnv {
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  GITHUB_BOT_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  CMS_SESSION_SECRET?: string;
}

export type VerifyJwt = (
  token: string,
  options: { teamDomain: string; aud: string },
) => Promise<{ email: string }>;

export const defaultVerifyJwt: VerifyJwt = (token, options) => verifyAccessJwt(token, options);

/** Local development only: `wrangler pages dev` with no Access in front of it. */
export const LOCAL_EDITOR_EMAIL = 'local@wssl.org';
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

// Guards against the documented `wrangler.toml` placeholder (`<team>.cloudflareaccess.com`)
// being left in place, which would otherwise surface as a confusing "sign-in expired" 401
// on every request instead of a clear configuration error.
const TEAM_DOMAIN_RE = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export const jsonError = (error: string, status: number, extra: Record<string, unknown> = {}) =>
  jsonResponse({ error, ...extra }, status);

/** Error text for logs and responses. Never includes a credential. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}

/**
 * Resolves to the signed-in editor's email, or to the `Response` that refuses the request.
 * Callers check with `instanceof Response` rather than a discriminated union, so a new
 * caller cannot forget to handle the refusal and carry on with an undefined email.
 */
export async function resolveEditor(
  request: Request,
  env: CmsEnv,
  verifyJwt: VerifyJwt,
): Promise<{ email: string } | Response> {
  if (env.CF_ACCESS_AUD) {
    if (!env.CF_ACCESS_TEAM_DOMAIN) {
      // Without the team domain there is nothing to check the token against; failing
      // closed here is clearer than an "expired sign-in" every editor would report.
      return jsonError('The site editor is not configured: CF_ACCESS_TEAM_DOMAIN is not set.', 403);
    }
    if (!TEAM_DOMAIN_RE.test(env.CF_ACCESS_TEAM_DOMAIN)) {
      return jsonError('CMS is not configured: CF_ACCESS_TEAM_DOMAIN is invalid.', 403);
    }
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) return jsonError('Not signed in. Reload /admin/ and sign in again.', 401);
    try {
      return await verifyJwt(token, { teamDomain: env.CF_ACCESS_TEAM_DOMAIN, aud: env.CF_ACCESS_AUD });
    } catch (e) {
      // The verification reason (issuer/audience/key/claim) is diagnostic text — useful in
      // the log, but not something to hand back to the browser: a client should not learn
      // *why* a JWT it did not construct failed to verify. M7: log it, and answer with the
      // same plain 401 every other sign-in failure gets.
      console.log(JSON.stringify({ event: 'cms_auth', status: 401, message: errorMessage(e) }));
      return jsonError('Your sign-in has expired. Reload /admin/ and sign in again.', 401);
    }
  }

  if (LOCAL_HOSTS.includes(new URL(request.url).hostname)) return { email: LOCAL_EDITOR_EMAIL };

  return jsonError('The site editor is not configured: CF_ACCESS_AUD is not set.', 403);
}
