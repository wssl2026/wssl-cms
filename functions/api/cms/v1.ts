/**
 * The CMS backend: `POST /api/cms/v1`, speaking Decap's proxy-backend protocol.
 *
 * Cloudflare Access sits in front of this route and of /admin, so a request only gets
 * here with a `Cf-Access-Jwt-Assertion` header minted for our Access application. The
 * email in that token becomes the git author; the repository itself is written with a
 * single fine-grained bot token, so editors need no GitHub account.
 */
import { verifyAccessJwt } from '../../_lib/access-jwt';
import { GitHubApiError, createGitHubContentClient } from '../../_lib/github-content';
import { ProxyError, handleProxyAction } from '../../_lib/decap-proxy';
import type { Author, GitHubContentClient } from '../../_lib/github-content';

interface Env {
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  GITHUB_BOT_TOKEN?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}

export interface CmsProxyDeps {
  verifyJwt: (token: string, options: { teamDomain: string; aud: string }) => Promise<{ email: string }>;
  createClient: (config: { repo: string; branch: string; token: string }) => GitHubContentClient;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const LOCAL_AUTHOR: Author = { name: 'Local editor', email: 'local@wssl.org' };
// Guards against the documented `wrangler.toml` placeholder (`<team>.cloudflareaccess.com`)
// being left in place, which would otherwise surface as a confusing "sign-in expired" 401
// on every request instead of a clear configuration error.
const TEAM_DOMAIN_RE = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const defaultDeps: CmsProxyDeps = {
  verifyJwt: (token, options) => verifyAccessJwt(token, options),
  createClient: (config) => createGitHubContentClient(config),
};

export function createCmsProxyHandler(overrides: Partial<CmsProxyDeps> = {}): PagesFunction<Env> {
  const deps: CmsProxyDeps = { ...defaultDeps, ...overrides };

  return async ({ request, env }) => {
    const declaredLength = Number(request.headers.get('Content-Length') ?? 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413);

    // --- who is asking -------------------------------------------------------
    let author: Author;
    if (env.CF_ACCESS_AUD) {
      if (!env.CF_ACCESS_TEAM_DOMAIN) {
        // Without the team domain there is nothing to check the token against; failing
        // closed here is clearer than an "expired sign-in" every editor would report.
        return json({ error: 'The site editor is not configured: CF_ACCESS_TEAM_DOMAIN is not set.' }, 403);
      }
      if (!TEAM_DOMAIN_RE.test(env.CF_ACCESS_TEAM_DOMAIN)) {
        // Catches the documented `<team>.cloudflareaccess.com` placeholder left in place,
        // which would otherwise fail JWT verification and look like an expired sign-in.
        return json({ error: 'CMS is not configured: CF_ACCESS_TEAM_DOMAIN is invalid.' }, 403);
      }
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token) return json({ error: 'Not signed in. Reload /admin/ and sign in again.' }, 401);
      try {
        const { email } = await deps.verifyJwt(token, {
          teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
          aud: env.CF_ACCESS_AUD,
        });
        // The email is the author's identity; it never goes into the commit message.
        author = { name: email, email };
      } catch (e) {
        console.log(JSON.stringify({ cms: 'auth', status: 401, message: errorMessage(e) }));
        return json({ error: 'Your sign-in has expired. Reload /admin/ and sign in again.' }, 401);
      }
    } else if (LOCAL_HOSTS.includes(new URL(request.url).hostname)) {
      // Local development only: `wrangler pages dev` with no Access in front of it.
      author = LOCAL_AUTHOR;
    } else {
      return json({ error: 'The site editor is not configured: CF_ACCESS_AUD is not set.' }, 403);
    }

    // --- what are they asking for -------------------------------------------
    const raw = await request.text();
    // A UTF-16 code unit is at most 3 UTF-8 bytes, so anything shorter than a third of
    // the cap is certainly under it and needs no measuring.
    if (raw.length > MAX_BODY_BYTES / 3 && new Blob([raw]).size > MAX_BODY_BYTES) {
      return json({ error: 'Request too large' }, 413);
    }

    let body: { action?: unknown; params?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || typeof body.action !== 'string') {
      return json({ error: 'Missing action' }, 400);
    }
    const action = body.action;

    // --- do it ---------------------------------------------------------------
    const repo = env.GITHUB_REPO;
    if (!repo) {
      // An empty `repo` would otherwise leak into the `info` response and every other
      // action, instead of telling whoever is deploying this what is actually missing.
      return json({ error: 'CMS is not configured: GITHUB_REPO is not set.' }, 503);
    }
    // Built on first use, so that actions which never touch GitHub — `info`, which
    // Decap uses to detect this backend, `unpublishedEntries`, `getDeployPreview` —
    // and requests refused for their action or their path still answer for themselves
    // on a half-configured deployment, instead of all reporting the missing token.
    const github = lazyClient(() =>
      deps.createClient({
        repo,
        branch: env.GITHUB_BRANCH ?? 'main',
        token: requireToken(env),
      }),
    );

    try {
      return json(await handleProxyAction(action, body.params, { github, repo, author }));
    } catch (e) {
      if (e instanceof ProxyError) return json({ error: e.message }, e.status);
      if (e instanceof GitHubApiError && (e.status === 409 || e.status === 422)) {
        // GitHub answers this way when the blob sha we sent no longer matches HEAD —
        // someone else committed to the same file in between. That is not a server
        // failure; it is a heads-up the editor can act on by reloading and retrying.
        console.log(JSON.stringify({ cms: action, status: 409, message: e.message }));
        return json(
          { error: 'Someone else changed this page since you opened it. Reload the editor and try again.' },
          409,
        );
      }
      const message = errorMessage(e);
      console.log(JSON.stringify({ cms: action, status: 502, message }));
      if (e instanceof ConfigError) return json({ error: message }, 502);
      return json({ error: `The editor could not reach GitHub: ${message}` }, 502);
    }
  };
}

class ConfigError extends Error {}

function requireToken(env: Env): string {
  if (!env.GITHUB_BOT_TOKEN) {
    throw new ConfigError('The site editor is not configured: GITHUB_BOT_TOKEN is not set.');
  }
  return env.GITHUB_BOT_TOKEN;
}

/** A client that is only constructed once an action actually reaches for GitHub. */
function lazyClient(build: () => GitHubContentClient): GitHubContentClient {
  let client: GitHubContentClient | undefined;
  const get = () => (client ??= build());
  return {
    listTree: (...args) => get().listTree(...args),
    getFile: (...args) => get().getFile(...args),
    getRawFile: (...args) => get().getRawFile(...args),
    putFile: (...args) => get().putFile(...args),
    deleteFile: (...args) => get().deleteFile(...args),
  };
}

/** Error text for logs and responses. Never includes credentials — see github-content. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'unknown error';
}

export const onRequestPost = createCmsProxyHandler();

export const onRequestGet: PagesFunction<Env> = async () =>
  new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST', 'Cache-Control': 'no-store' },
  });
