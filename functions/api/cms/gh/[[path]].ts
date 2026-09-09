/**
 * `ALL /api/cms/gh/*` — the GitHub API, as much of it as the editor needs and no more.
 *
 * Sveltia CMS runs in the browser and talks to GitHub directly. It must not be given a
 * GitHub credential, so its `api_root` points here instead: this function is the only
 * thing that holds `GITHUB_BOT_TOKEN`, and it will only use it after two independent
 * checks agree on who is asking.
 *
 *  1. The Cloudflare Access JWT on the request (Access fronts `/admin` and `/api/cms`).
 *  2. The session token Sveltia is carrying, minted by `/api/cms/auth` for that same
 *     editor. A token for anyone else, or one that has expired, is a 401 — so a session
 *     copied out of one editor's browser is useless in another's.
 *
 * What may be asked for at all is decided by `_lib/github-proxy.ts`, which is pure and
 * tested; this function is the plumbing around it.
 */
import { MIN_SESSION_SECRET_LENGTH, verifySession } from '../../../_lib/cms-session';
import {
  defaultVerifyJwt,
  errorMessage,
  jsonError,
  jsonResponse,
  resolveEditor,
} from '../../../_lib/cms-access';
import type { CmsEnv, VerifyJwt } from '../../../_lib/cms-access';
import {
  GITHUB_API_ORIGIN,
  classifyRequest,
  normalizeApiPath,
  repoRelativePath,
  synthesizeEmails,
  synthesizeUser,
} from '../../../_lib/github-proxy';

export interface GitHubProxyDeps {
  verifyJwt: VerifyJwt;
  fetchImpl: typeof fetch;
}

/** Media uploads arrive as base64 inside a GraphQL mutation, so the cap is generous. */
const MAX_BODY_BYTES = 15 * 1024 * 1024;

/** M9: GitHub is expected to answer well inside this; past it, Sveltia should hear a clear
 * 502 rather than the browser waiting on a request that may never resolve. */
const UPSTREAM_TIMEOUT_MS = 30_000;

const ROUTE_PREFIX = '/api/cms/gh';

/** Headers worth carrying upstream. Everything else — cookies, Access, forwarding and
 * hop-by-hop headers — is dropped rather than handed to GitHub. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'if-modified-since', 'x-github-api-version'];

/** Response headers worth carrying back. `Set-Cookie` is deliberately not among them. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'link', 'x-github-media-type'];

export function createGitHubProxyHandler(overrides: Partial<GitHubProxyDeps> = {}): PagesFunction<CmsEnv> {
  const verifyJwt = overrides.verifyJwt ?? defaultVerifyJwt;
  const fetchUpstream = overrides.fetchImpl ?? fetch;

  return async ({ request, env }) => {
    const url = new URL(request.url);
    const rawPath = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : url.pathname;
    const method = request.method.toUpperCase();
    // What goes in the log: the repository is a constant, not news, and the query string
    // of an allow-listed read carries nothing private.
    const logPath = () => repoRelativePath(`${normalizeApiPath(rawPath)}${url.search}`, env.GITHUB_REPO ?? '');
    const done = (response: Response) => {
      console.log(JSON.stringify({ event: 'cms_proxy', method, path: logPath(), status: response.status }));
      return response;
    };

    if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY_BYTES) {
      return done(jsonError('Request too large', 413));
    }

    // --- configuration -------------------------------------------------------
    if (!env.CMS_SESSION_SECRET) {
      return done(jsonError('The site editor is not configured: CMS_SESSION_SECRET is not set.', 503));
    }
    if (env.CMS_SESSION_SECRET.length < MIN_SESSION_SECRET_LENGTH) {
      return done(
        jsonError(`The site editor is not configured: CMS_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`, 503),
      );
    }
    if (!env.GITHUB_REPO) {
      return done(jsonError('The site editor is not configured: GITHUB_REPO is not set.', 503));
    }

    // --- who is asking -------------------------------------------------------
    const editor = await resolveEditor(request, env, verifyJwt);
    if (editor instanceof Response) return done(editor);

    const presented = bearerToken(request.headers.get('Authorization'));
    const session = presented ? await verifySession(presented, env.CMS_SESSION_SECRET) : null;
    if (!session || session.email !== editor.email) {
      // Either the editor never went through /api/cms/auth, or the session has run out,
      // or it belongs to someone else. Sveltia's answer to a 401 is to sign in again.
      return done(jsonError('Your editing session has expired. Reload /admin/ and sign in again.', 401));
    }

    // --- what are they asking for --------------------------------------------
    let body: string | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw: string = await request.text();
      // A UTF-16 code unit is at most 3 UTF-8 bytes, so anything shorter than a third of
      // the cap is certainly under it and needs no measuring.
      if (raw.length > MAX_BODY_BYTES / 3 && new Blob([raw]).size > MAX_BODY_BYTES) {
        return done(jsonError('Request too large', 413));
      }
      body = raw;
    }

    const decision = classifyRequest({
      method,
      path: rawPath,
      search: url.search,
      repo: env.GITHUB_REPO,
      branch: env.GITHUB_BRANCH ?? '',
      email: editor.email,
      body,
    });

    if (decision.kind === 'deny') {
      return done(jsonError(decision.reason, 403));
    }

    if (decision.kind === 'synthetic') {
      if (decision.response === 'user') return done(jsonResponse(synthesizeUser(editor.email)));
      if (decision.response === 'emails') return done(jsonResponse(synthesizeEmails(editor.email)));
      // GitHub answers the collaborator check with 204 and no body.
      return done(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));
    }

    // --- forward it ----------------------------------------------------------
    if (!env.GITHUB_BOT_TOKEN) {
      return done(jsonError('The site editor is not configured: GITHUB_BOT_TOKEN is not set.', 502));
    }

    const headers = new Headers({
      Authorization: `Bearer ${env.GITHUB_BOT_TOKEN}`,
      'User-Agent': 'wssl-cms-proxy',
    });
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    // `classifyRequest` returns a rewritten body for the requests it rewrites (GraphQL);
    // anything else goes upstream exactly as it arrived.
    const upstreamBody = decision.body ?? body;

    let upstream: Response;
    try {
      upstream = await fetchUpstream(`${GITHUB_API_ORIGIN}${decision.path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ...(upstreamBody === undefined ? {} : { body: upstreamBody }),
      });
    } catch (e) {
      // The message can only be ours or the runtime's, but it is reduced to a status and
      // a short reason either way — never the token, never the body.
      console.log(JSON.stringify({ event: 'cms_proxy_error', method, path: logPath(), message: safeMessage(e, env) }));
      return done(jsonError('The editor could not reach GitHub. Try again in a moment.', 502));
    }

    const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }

    // 204 and 304 must not carry a body, and `Response` refuses to build one that does.
    const withoutBody = upstream.status === 204 || upstream.status === 304;
    return done(
      new Response(withoutBody ? null : upstream.body, { status: upstream.status, headers: responseHeaders }),
    );
  };
}

/** `token <t>` and `Bearer <t>` both mean the session token; anything else means nothing. */
function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^(?:token|Bearer)\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Belt and braces: an error message can only reach the log with the token redacted. */
function safeMessage(e: unknown, env: CmsEnv): string {
  const message = errorMessage(e);
  return env.GITHUB_BOT_TOKEN ? message.split(env.GITHUB_BOT_TOKEN).join('[redacted]') : message;
}

export const onRequest = createGitHubProxyHandler();
