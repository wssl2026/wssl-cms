import { describe, it, expect, vi } from 'vitest';
import { createCmsAuthHandler } from '../functions/api/cms/auth';
import { verifySession } from '../functions/_lib/cms-session';

const SECRET = 'cms-session-secret-for-tests-000000';

const PROD_ENV = {
  GITHUB_REPO: 'wssl2026/wssl-cms',
  CMS_SESSION_SECRET: SECRET,
  CF_ACCESS_TEAM_DOMAIN: 'wssl.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag-0123456789abcdef',
};

const LOCAL_ENV = { GITHUB_REPO: 'wssl2026/wssl-cms', CMS_SESSION_SECRET: SECRET };

function context(request: Request, env: Record<string, string | undefined>) {
  return { request, env, params: {}, data: {}, waitUntil() {}, passThroughOnException() {}, next: async () => new Response() } as never;
}

/** Sveltia opens `<base_url>/<auth_endpoint>?provider=github&site_id=…&scope=repo,user`. */
function authRequest(opts: { url?: string; jwt?: string } = {}) {
  const headers = new Headers();
  if (opts.jwt) headers.set('Cf-Access-Jwt-Assertion', opts.jwt);
  const url = opts.url ?? 'https://wssl-cms.pages.dev/api/cms/auth?provider=github&site_id=wssl-cms.pages.dev&scope=repo,user';
  return new Request(url, { headers });
}

const okVerifier = (email = 'editor@wssl.org') => vi.fn(async () => ({ email }));

/** The session token the page hands to the opener, dug out of the HTML. */
function tokenFrom(html: string): string {
  const match = html.match(/"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/);
  return match ? match[1] : '';
}

describe('GET /api/cms/auth — who is asking', () => {
  it('rejects a request with no Access JWT (401)', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest(), PROD_ENV));
    expect(res.status).toBe(401);
  });

  it('rejects a JWT that does not verify (401)', async () => {
    const verifyJwt = vi.fn(async () => { throw new Error('bad token'); });
    const handler = createCmsAuthHandler({ verifyJwt });
    const res = await handler(context(authRequest({ jwt: 'nope' }), PROD_ENV));
    expect(res.status).toBe(401);
  });

  it('passes the configured team domain and AUD to the verifier', async () => {
    const verifyJwt = okVerifier();
    const handler = createCmsAuthHandler({ verifyJwt });
    await handler(context(authRequest({ jwt: 'jwt' }), PROD_ENV));
    expect(verifyJwt).toHaveBeenCalledWith('jwt', {
      teamDomain: PROD_ENV.CF_ACCESS_TEAM_DOMAIN,
      aud: PROD_ENV.CF_ACCESS_AUD,
    });
  });

  it('mints the session for the email in the Access token', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier('carol@wssl.org') });
    const res = await handler(context(authRequest({ jwt: 'jwt' }), PROD_ENV));
    expect(res.status).toBe(200);
    await expect(verifySession(tokenFrom(await res.text()), SECRET)).resolves.toEqual({ email: 'carol@wssl.org' });
  });

  it('signs in the local editor on localhost when CF_ACCESS_AUD is unset', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest({ url: 'http://localhost:8790/api/cms/auth' }), LOCAL_ENV));
    expect(res.status).toBe(200);
    await expect(verifySession(tokenFrom(await res.text()), SECRET)).resolves.toEqual({ email: 'local@wssl.org' });
  });

  it('refuses that same unauthenticated request on a public host (403)', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest(), LOCAL_ENV));
    expect(res.status).toBe(403);
  });

  it('still requires a JWT on localhost once Access is configured', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest({ url: 'http://localhost:8790/api/cms/auth' }), PROD_ENV));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/cms/auth — configuration', () => {
  it('returns a 503 config error when CMS_SESSION_SECRET is missing', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest({ jwt: 'jwt' }), { ...PROD_ENV, CMS_SESSION_SECRET: undefined }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('CMS_SESSION_SECRET');
  });

  it('returns a 503 config error when CMS_SESSION_SECRET is shorter than 32 characters (M8)', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(
      context(authRequest({ jwt: 'jwt' }), { ...PROD_ENV, CMS_SESSION_SECRET: 'too-short' }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('CMS_SESSION_SECRET');
  });

  it('fails closed when the AUD is set but the team domain is not (403)', async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest({ jwt: 'jwt' }), { ...PROD_ENV, CF_ACCESS_TEAM_DOMAIN: undefined }));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/cms/auth — the handshake page', () => {
  const render = async () => {
    const handler = createCmsAuthHandler({ verifyJwt: okVerifier() });
    const res = await handler(context(authRequest({ jwt: 'jwt' }), PROD_ENV));
    return { res, html: await res.text() };
  };

  it('is uncacheable HTML that search engines are told to ignore', async () => {
    const { res, html } = await render();
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain('name="robots"');
    expect(html).toContain('noindex');
  });

  it('speaks the two-step postMessage handshake Sveltia listens for', async () => {
    const { html } = await render();
    expect(html).toContain("'authorizing:' + provider");
    expect(html).toContain("'authorization:' + provider + ':success:'");
    expect(html).toContain("var provider = 'github'");
    expect(html).toContain('JSON.stringify({ provider: provider, token: token })');
  });

  it('only ever talks to the window that opened it, on this origin', async () => {
    const { html } = await render();
    expect(html).toContain('window.opener');
    expect(html).toContain('window.location.origin');
    expect(html).toContain('event.origin !== window.location.origin');
  });

  it('carries the session token and nothing that looks like a GitHub credential', async () => {
    const { html } = await render();
    expect(tokenFrom(html)).not.toBe('');
    expect(html).not.toMatch(/gh[pousr]_|github_pat_/);
    expect(html).not.toContain('api.github.com');
  });
});
