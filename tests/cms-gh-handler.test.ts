import { describe, it, expect, vi } from 'vitest';
import { createGitHubProxyHandler } from '../functions/api/cms/gh/[[path]]';
import { mintSession } from '../functions/_lib/cms-session';

const BOT_TOKEN = 'github_pat_do_not_log_me';
const SECRET = 'cms-session-secret-for-tests-000000';
const REPO = 'wssl2026/wssl-cms';
const EMAIL = 'editor@wssl.org';

const PROD_ENV = {
  GITHUB_REPO: REPO,
  GITHUB_BRANCH: 'main',
  GITHUB_BOT_TOKEN: BOT_TOKEN,
  CMS_SESSION_SECRET: SECRET,
  CF_ACCESS_TEAM_DOMAIN: 'wssl.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag-0123456789abcdef',
};

const LOCAL_ENV = { GITHUB_REPO: REPO, GITHUB_BOT_TOKEN: BOT_TOKEN, CMS_SESSION_SECRET: SECRET };

function context(request: Request, env: Record<string, string | undefined>) {
  return { request, env, params: {}, data: {}, waitUntil() {}, passThroughOnException() {}, next: async () => new Response() } as never;
}

const okVerifier = (email = EMAIL) => vi.fn(async () => ({ email }));

/** A fetch that records what it was asked for and answers with a canned GitHub response. */
function fakeFetch(response?: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return (
      response?.clone() ??
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: 'W/"abc"', 'Set-Cookie': 'logged_in=yes' },
      })
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

async function call(
  path: string,
  opts: {
    method?: string;
    body?: string;
    env?: Record<string, string | undefined>;
    jwt?: string | null;
    session?: string | null;
    headers?: Record<string, string>;
    host?: string;
    response?: Response;
  } = {},
) {
  const env = opts.env ?? PROD_ENV;
  const headers = new Headers(opts.headers ?? {});
  if (opts.jwt !== null) headers.set('Cf-Access-Jwt-Assertion', opts.jwt ?? 'access-jwt');
  const session = opts.session === null ? null : (opts.session ?? (await mintSession(EMAIL, SECRET)));
  if (session) headers.set('Authorization', `token ${session}`);
  const { fetchImpl, calls } = fakeFetch(opts.response);
  const handler = createGitHubProxyHandler({ verifyJwt: okVerifier(), fetchImpl });
  const request = new Request(`${opts.host ?? 'https://wssl-cms.pages.dev'}/api/cms/gh${path}`, {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: opts.body }),
  });
  const res = await handler(context(request, env));
  return { res, calls, fetchImpl };
}

const rest = (path: string) => `/api/v3${path}`;

describe('/api/cms/gh/* — authentication', () => {
  it('rejects a request with no Access JWT (401)', async () => {
    const { res, calls } = await call(rest('/user'), { jwt: null });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects a request with an Access JWT but no session token (401)', async () => {
    const { res, calls } = await call(rest('/user'), { session: null });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects a session token minted for a different editor (401)', async () => {
    const other = await mintSession('someone-else@wssl.org', SECRET);
    const { res, calls } = await call(rest('/user'), { session: other });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects a session token signed with another secret (401)', async () => {
    const forged = await mintSession(EMAIL, 'not-our-secret-but-still-32-plus-chars');
    const { res } = await call(rest('/user'), { session: forged });
    expect(res.status).toBe(401);
  });

  it('rejects an expired session token (401)', async () => {
    const expired = await mintSession(EMAIL, SECRET, -60);
    const { res } = await call(rest('/user'), { session: expired });
    expect(res.status).toBe(401);
  });

  it('accepts the session under the Bearer scheme too', async () => {
    const session = await mintSession(EMAIL, SECRET);
    const { res } = await call(rest('/user'), { session: null, headers: { Authorization: `Bearer ${session}` } });
    expect(res.status).toBe(200);
  });

  it('rejects an Authorization header that is not a session token (401)', async () => {
    for (const value of ['token ghp_realgithubtoken', 'Basic abc', 'token', '']) {
      const { res } = await call(rest('/user'), { session: null, headers: { Authorization: value } });
      expect(res.status).toBe(401);
    }
  });

  it('runs on localhost with no Access, as the local editor', async () => {
    const session = await mintSession('local@wssl.org', SECRET);
    const { res } = await call(rest('/user'), {
      env: LOCAL_ENV, jwt: null, session, host: 'http://localhost:8790',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'local@wssl.org' });
  });

  it('refuses an unauthenticated request on a public host even in local mode (403)', async () => {
    const session = await mintSession('local@wssl.org', SECRET);
    const { res } = await call(rest('/user'), { env: LOCAL_ENV, jwt: null, session });
    expect(res.status).toBe(403);
  });
});

describe('/api/cms/gh/* — configuration', () => {
  it('returns 503 when CMS_SESSION_SECRET is missing', async () => {
    const { res } = await call(rest('/user'), { env: { ...PROD_ENV, CMS_SESSION_SECRET: undefined } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('CMS_SESSION_SECRET');
  });

  it('returns 503 when GITHUB_REPO is missing', async () => {
    const { res } = await call(rest('/user'), { env: { ...PROD_ENV, GITHUB_REPO: undefined } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('GITHUB_REPO');
  });

  it('returns 503 when CMS_SESSION_SECRET is shorter than 32 characters (M8)', async () => {
    const { res } = await call(rest('/user'), { env: { ...PROD_ENV, CMS_SESSION_SECRET: 'too-short' } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('CMS_SESSION_SECRET');
  });

  it('returns 502 with a clear message when the bot token is missing', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/git/trees/main`), {
      env: { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined },
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('GITHUB_BOT_TOKEN');
    expect(calls).toHaveLength(0);
  });

  it('still answers the synthesized endpoints with no bot token, so sign-in works', async () => {
    const { res } = await call(rest('/user'), { env: { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined } });
    expect(res.status).toBe(200);
  });
});

describe('/api/cms/gh/* — the synthesized identity', () => {
  it('answers GET /user from the Access email and never calls GitHub', async () => {
    const { res, calls } = await call(rest('/user'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ login: 'editor', name: EMAIL, email: EMAIL });
    expect(calls).toHaveLength(0);
  });

  it('answers GET /user/emails', async () => {
    const { res, calls } = await call(rest('/user/emails'));
    expect(await res.json()).toEqual([{ email: EMAIL, primary: true, verified: true }]);
    expect(calls).toHaveLength(0);
  });

  it('answers the collaborator check with a bare 204, the way GitHub does', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/collaborators/editor`));
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });
});

describe('/api/cms/gh/* — forwarding', () => {
  it('sends an allow-listed read to GitHub with the bot token and our user agent', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/git/trees/main?recursive=1`), {
      headers: { Accept: 'application/vnd.github.raw' },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`);
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${BOT_TOKEN}`);
    expect(headers.get('User-Agent')).toBe('wssl-cms-proxy');
    expect(headers.get('Accept')).toBe('application/vnd.github.raw');
  });

  it('passes through the conditional-request and API version headers', async () => {
    const { calls } = await call(rest(`/repos/${REPO}/git/blobs/abc`), {
      headers: { 'If-None-Match': 'W/"etag"', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('If-None-Match')).toBe('W/"etag"');
    expect(headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  it('never forwards the browser cookie or the Access header to GitHub', async () => {
    const { calls } = await call(rest(`/repos/${REPO}/git/blobs/abc`), {
      headers: { Cookie: 'CF_Authorization=secret', 'X-Forwarded-For': '203.0.113.1' },
    });
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get('Cookie')).toBeNull();
    expect(headers.get('Cf-Access-Jwt-Assertion')).toBeNull();
    expect(headers.get('X-Forwarded-For')).toBeNull();
  });

  it('returns GitHub’s status, body and content type, and strips its Set-Cookie', async () => {
    const upstream = new Response('{"tree":[]}', {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'a=b', ETag: 'W/"x"' },
    });
    const { res } = await call(rest(`/repos/${REPO}/git/trees/main`), { response: upstream });
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('ETag')).toBe('W/"x"');
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(await res.text()).toBe('{"tree":[]}');
  });

  it('answers a 304 without inventing a body', async () => {
    const upstream = new Response(null, { status: 304, headers: { ETag: 'W/"x"' } });
    const { res } = await call(rest(`/repos/${REPO}/git/blobs/abc`), { response: upstream });
    expect(res.status).toBe(304);
  });

  it('turns a failure to reach GitHub into a 502, without leaking the token', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`connect failed for ${BOT_TOKEN}`); });
    const handler = createGitHubProxyHandler({ verifyJwt: okVerifier(), fetchImpl: fetchImpl as never });
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': 'jwt', Authorization: `token ${await mintSession(EMAIL, SECRET)}` });
    const request = new Request(`https://wssl-cms.pages.dev/api/cms/gh${rest(`/repos/${REPO}/git/trees/main`)}`, { headers });
    const res = await handler(context(request, PROD_ENV));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(BOT_TOKEN);
  });

  it('turns an upstream timeout into a 502, and asks fetch for one (M9)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    const handler = createGitHubProxyHandler({ verifyJwt: okVerifier(), fetchImpl: fetchImpl as never });
    const headers = new Headers({ 'Cf-Access-Jwt-Assertion': 'jwt', Authorization: `token ${await mintSession(EMAIL, SECRET)}` });
    const request = new Request(`https://wssl-cms.pages.dev/api/cms/gh${rest(`/repos/${REPO}/git/trees/main`)}`, { headers });
    const res = await handler(context(request, PROD_ENV));
    expect(res.status).toBe(502);
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('/api/cms/gh/* — the tree read is pinned to the production branch (I2, M4)', () => {
  it('forwards a tree read for the configured branch', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/git/trees/main`));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('forwards a tree read pinned to a 40-hex commit SHA', async () => {
    const sha = 'a'.repeat(40);
    const { res, calls } = await call(rest(`/repos/${REPO}/git/trees/${sha}`));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('refuses a tree read for any other branch (403)', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/git/trees/feature-x`));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a ref carrying a percent-encoded traversal attempt (403)', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/git/trees/main%2F..%2F..%2Fuser`));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('/api/cms/gh/* — refusals', () => {
  it('refuses a path outside the allow-list with 403 and calls nothing', async () => {
    for (const path of ['/users/octocat', '/user/repos', `/repos/${REPO}`, '/orgs/wssl2026']) {
      const { res, calls } = await call(rest(path));
      expect(res.status, path).toBe(403);
      expect(calls, path).toHaveLength(0);
    }
  });

  it('refuses another repository (403)', async () => {
    const { res } = await call(rest('/repos/someone/else/git/trees/main'));
    expect(res.status).toBe(403);
  });

  it('refuses a write GitHub would have accepted (403)', async () => {
    const { res, calls } = await call(rest(`/repos/${REPO}/contents/src/data/site.json`), {
      method: 'PUT', body: JSON.stringify({ message: 'x', content: 'e30=' }),
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects a body over 15 MB by Content-Length, without reading it', async () => {
    const { res, calls } = await call('/api/graphql', {
      method: 'POST', body: '{}', headers: { 'Content-Length': String(16 * 1024 * 1024) },
    });
    expect(res.status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe('/api/cms/gh/* — GraphQL', () => {
  const QUERY =
    'query($owner: String!, $repo: String!, $branch: String!) { repository(owner: $owner, name: $repo) { ref(qualifiedName: $branch) { target { ... on Commit { history(first: 1) { nodes { oid message } } } } } } }';
  const MUTATION =
    'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid committedDate } } }';

  it('forwards a query to GitHub’s GraphQL endpoint', async () => {
    const { res, calls } = await call('/api/graphql', {
      method: 'POST',
      body: JSON.stringify({ query: QUERY, variables: { branch: 'main' } }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe('https://api.github.com/graphql');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body)).variables).toMatchObject({ owner: 'wssl2026', repo: 'wssl-cms' });
  });

  it('records the editor on a commit it forwards', async () => {
    const input = {
      branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
      expectedHeadOid: 'abc',
      fileChanges: { additions: [], deletions: [] },
      message: { headline: 'content: update about "index"' },
    };
    const { calls } = await call('/api/graphql', {
      method: 'POST', body: JSON.stringify({ query: MUTATION, variables: { input } }),
    });
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.variables.input.message.body).toContain(`Co-authored-by: ${EMAIL} <${EMAIL}>`);
  });

  it('refuses a GraphQL request aimed at another repository (403)', async () => {
    const { res, calls } = await call('/api/graphql', {
      method: 'POST', body: JSON.stringify({ query: QUERY, variables: { owner: 'someone' } }),
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a commit that touches a path outside the content roots (403, C1)', async () => {
    const input = {
      branch: { repositoryNameWithOwner: REPO, branchName: 'main' },
      expectedHeadOid: 'abc',
      fileChanges: { additions: [{ path: 'functions/api/evil.ts', contents: 'ZXZpbA==' }], deletions: [] },
      message: { headline: 'content: update about "index"' },
    };
    const { res, calls } = await call('/api/graphql', {
      method: 'POST', body: JSON.stringify({ query: MUTATION, variables: { input } }),
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a commit aimed at a branch other than the configured one (403, I2)', async () => {
    const input = {
      branch: { repositoryNameWithOwner: REPO, branchName: 'feature-x' },
      expectedHeadOid: 'abc',
      fileChanges: { additions: [], deletions: [] },
      message: { headline: 'content: update about "index"' },
    };
    const { res, calls } = await call('/api/graphql', {
      method: 'POST', body: JSON.stringify({ query: MUTATION, variables: { input } }),
    });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('/api/cms/gh/* — logging', () => {
  it('logs the method, the repo-relative path and the status, and never a credential', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await call(rest(`/repos/${REPO}/git/trees/main?recursive=1`));
      const lines = log.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes('cms_proxy'));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string)).toEqual({
        event: 'cms_proxy', method: 'GET', path: '/git/trees/main?recursive=1', status: 200,
      });
      expect(lines.join('\n')).not.toContain(BOT_TOKEN);
      expect(lines.join('\n')).not.toContain(REPO);
    } finally {
      log.mockRestore();
    }
  });

  it('logs a refusal too, and never the request body', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await call('/api/graphql', {
        method: 'POST',
        body: JSON.stringify({ query: 'query { viewer { login } }', variables: { secret: 'hunter2' } }),
      });
      const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).toContain('"status":403');
      expect(lines).not.toContain('hunter2');
      expect(lines).not.toContain('viewer');
    } finally {
      log.mockRestore();
    }
  });
});
