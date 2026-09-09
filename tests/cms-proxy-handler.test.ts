import { describe, it, expect, vi } from 'vitest';
import { createCmsProxyHandler, onRequestGet, onRequestPost } from '../functions/api/cms/v1';
import { GitHubApiError, utf8ToBase64 } from '../functions/_lib/github-content';
import type { GitHubContentClient } from '../functions/_lib/github-content';

const TOKEN = 'github_pat_do_not_log_me';

const PROD_ENV = {
  GITHUB_REPO: 'OWNER/REPO',
  GITHUB_BRANCH: 'main',
  GITHUB_BOT_TOKEN: TOKEN,
  CF_ACCESS_TEAM_DOMAIN: 'wssl.cloudflareaccess.com',
  CF_ACCESS_AUD: 'aud-tag-0123456789abcdef',
};

function makeContext(request: Request, env: Record<string, string | undefined> = PROD_ENV) {
  return {
    request,
    env,
    params: {},
    data: {},
    waitUntil() {},
    passThroughOnException() {},
    next: async () => new Response(),
  } as never;
}

function post(body: unknown, opts: { url?: string; jwt?: string; raw?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(opts.headers ?? {}) });
  if (opts.jwt) headers.set('Cf-Access-Jwt-Assertion', opts.jwt);
  return new Request(opts.url ?? 'https://www.wssl.org/api/cms/v1', {
    method: 'POST',
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
}

/** A GitHub client backed by a Map, plus the config it was built with. */
function fakeClientFactory(seed: Record<string, string> = {}) {
  const files = new Map<string, { base64: string; sha: string }>();
  let n = 0;
  for (const [p, text] of Object.entries(seed)) files.set(p, { base64: utf8ToBase64(text), sha: `sha-${++n}` });
  const seen: { repo: string; branch: string; token: string }[] = [];

  const createClient = (cfg: { repo: string; branch: string; token: string }): GitHubContentClient => {
    seen.push({ repo: cfg.repo, branch: cfg.branch, token: cfg.token });
    return {
      async listTree(prefix) {
        return [...files.entries()]
          .filter(([p]) => p === prefix || p.startsWith(`${prefix}/`))
          .map(([path, f]) => ({ path, sha: f.sha }));
      },
      async getFile(path) {
        const f = files.get(path);
        return f ? { path, sha: f.sha, contentBase64: f.base64 } : null;
      },
      async getRawFile(path) {
        return files.has(path) ? 'raw' : null;
      },
      async putFile(path, contentBase64) {
        const sha = `sha-${++n}`;
        files.set(path, { base64: contentBase64, sha });
        return { sha };
      },
      async deleteFile(path) {
        files.delete(path);
      },
    };
  };

  return { createClient, files, seen };
}

const acceptAnyJwt = async () => ({ email: 'editor@wssl.org' });

describe('POST /api/cms/v1 — authentication', () => {
  it('rejects a request with no Access JWT (401)', async () => {
    const response = await onRequestPost(makeContext(post({ action: 'info' })));
    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect((await response.json()).error).toMatch(/sign in|not signed in|unauthorized/i);
  });

  it('rejects a JWT that does not verify (401)', async () => {
    const handler = createCmsProxyHandler({
      verifyJwt: async () => {
        throw new Error('signature verification failed');
      },
    });
    const response = await handler(makeContext(post({ action: 'info' }, { jwt: 'bogus.jwt.value' })));
    expect(response.status).toBe(401);
  });

  it('accepts a verified JWT and answers the info probe', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const response = await handler(makeContext(post({ action: 'info' }, { jwt: 'good.jwt.value' })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repo: 'OWNER/REPO', publish_modes: ['simple'], type: 'github' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('passes the configured team domain and AUD to the verifier', async () => {
    const seen: { token: string; teamDomain: string; aud: string }[] = [];
    const handler = createCmsProxyHandler({
      verifyJwt: async (token, opts) => {
        seen.push({ token, teamDomain: opts.teamDomain, aud: opts.aud });
        return { email: 'editor@wssl.org' };
      },
    });
    await handler(makeContext(post({ action: 'info' }, { jwt: 'good.jwt.value' })));
    expect(seen).toEqual([
      { token: 'good.jwt.value', teamDomain: 'wssl.cloudflareaccess.com', aud: 'aud-tag-0123456789abcdef' },
    ]);
  });

  it('makes the verified editor the git author of writes', async () => {
    const { createClient } = fakeClientFactory({ 'src/content/pages/about/x.md': 'old' });
    const authors: unknown[] = [];
    const handler = createCmsProxyHandler({
      verifyJwt: async () => ({ email: 'alice@wssl.org' }),
      createClient: (cfg) => {
        const client = createClient(cfg);
        return { ...client, putFile: async (p, c, m, o) => (authors.push(o.author), client.putFile(p, c, m, o)) };
      },
    });
    const response = await handler(
      makeContext(
        post(
          {
            action: 'persistEntry',
            params: {
              branch: 'main',
              dataFiles: [{ slug: 'x', path: 'src/content/pages/about/x.md', raw: 'new body' }],
              assets: [],
              options: { commitMessage: 'content: update about "x"', useWorkflow: false, status: 'draft' },
            },
          },
          { jwt: 'good.jwt.value' },
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(authors).toEqual([{ name: 'alice@wssl.org', email: 'alice@wssl.org' }]);
  });
});

describe('POST /api/cms/v1 — the localhost development path', () => {
  const devEnv = { ...PROD_ENV, CF_ACCESS_AUD: undefined };

  it('runs without a JWT on localhost when CF_ACCESS_AUD is unset', async () => {
    const handler = createCmsProxyHandler();
    const response = await handler(
      makeContext(post({ action: 'info' }, { url: 'http://localhost:8790/api/cms/v1' }), devEnv),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ repo: 'OWNER/REPO', publish_modes: ['simple'], type: 'github' });
  });

  it('commits as the local editor on that path', async () => {
    const { createClient } = fakeClientFactory();
    const authors: unknown[] = [];
    const handler = createCmsProxyHandler({
      createClient: (cfg) => {
        const client = createClient(cfg);
        return { ...client, putFile: async (p, c, m, o) => (authors.push(o.author), client.putFile(p, c, m, o)) };
      },
    });
    await handler(
      makeContext(
        post(
          {
            action: 'persistEntry',
            params: {
              branch: 'main',
              dataFiles: [{ slug: 'x', path: 'src/content/pages/about/x.md', raw: 'body' }],
              assets: [],
              options: { commitMessage: 'content: create about "x"', useWorkflow: false, status: 'draft' },
            },
          },
          { url: 'http://127.0.0.1:8790/api/cms/v1' },
        ),
        devEnv,
      ),
    );
    expect(authors).toEqual([{ name: 'Local editor', email: 'local@wssl.org' }]);
  });

  it('refuses to serve an unauthenticated request on a public host (403)', async () => {
    const handler = createCmsProxyHandler();
    const response = await handler(makeContext(post({ action: 'info' }), devEnv));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/not configured|CF_ACCESS_AUD/i);
  });

  it('fails closed when the AUD is set but the team domain is not (403)', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const response = await handler(
      makeContext(post({ action: 'info' }, { jwt: 'good' }), { ...PROD_ENV, CF_ACCESS_TEAM_DOMAIN: undefined }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/CF_ACCESS_TEAM_DOMAIN/);
  });

  it('fails closed with a clear error when the team domain is still the documented placeholder (403)', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const response = await handler(
      makeContext(post({ action: 'info' }, { jwt: 'good' }), {
        ...PROD_ENV,
        CF_ACCESS_TEAM_DOMAIN: '<team>.cloudflareaccess.com',
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('CMS is not configured: CF_ACCESS_TEAM_DOMAIN is invalid.');
  });

  it('still requires a JWT on localhost once CF_ACCESS_AUD is configured', async () => {
    const handler = createCmsProxyHandler();
    const response = await handler(
      makeContext(post({ action: 'info' }, { url: 'http://localhost:8790/api/cms/v1' }), PROD_ENV),
    );
    expect(response.status).toBe(401);
  });
});

describe('POST /api/cms/v1 — request validation', () => {
  const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });

  it('rejects a body that is not JSON (400)', async () => {
    const response = await handler(makeContext(post(null, { raw: '{not json', jwt: 'good' })));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/json/i);
  });

  it('rejects a body that is not an object with an action (400)', async () => {
    const response = await handler(makeContext(post({ params: {} }, { jwt: 'good' })));
    expect(response.status).toBe(400);
  });

  it('rejects an unknown action (422)', async () => {
    const response = await handler(makeContext(post({ action: 'rmRf', params: {} }, { jwt: 'good' })));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('Unknown action rmRf');
  });

  it('rejects a path outside the allow-list (400)', async () => {
    const { createClient } = fakeClientFactory();
    const h = createCmsProxyHandler({ verifyJwt: acceptAnyJwt, createClient });
    const response = await h(
      makeContext(post({ action: 'getEntry', params: { branch: 'main', path: 'wrangler.toml' } }, { jwt: 'good' })),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a body larger than 8 MB by Content-Length, without reading it (413)', async () => {
    const response = await handler(
      makeContext(post({ action: 'info' }, { jwt: 'good', headers: { 'Content-Length': String(9 * 1024 * 1024) } })),
    );
    expect(response.status).toBe(413);
  });

  it('rejects an oversized body that lies about its length (413)', async () => {
    const big = 'x'.repeat(8 * 1024 * 1024 + 10);
    const response = await handler(
      makeContext(
        post(null, {
          jwt: 'good',
          raw: JSON.stringify({ action: 'persistMedia', params: { asset: { content: big } } }),
        }),
      ),
    );
    expect(response.status).toBe(413);
  });

  it('answers GET with 405', async () => {
    const response = await onRequestGet(makeContext(new Request('https://www.wssl.org/api/cms/v1')));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('POST /api/cms/v1 — configuration and upstream failures', () => {
  it('returns a clear 502 when the bot token is missing', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const env = { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined };
    const response = await handler(
      makeContext(
        post(
          {
            action: 'persistEntry',
            params: {
              branch: 'main',
              dataFiles: [{ slug: 'x', path: 'src/content/pages/about/x.md', raw: 'body' }],
              assets: [],
              options: { commitMessage: 'content: update about "x"', useWorkflow: false, status: 'draft' },
            },
          },
          { jwt: 'good' },
        ),
        env,
      ),
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/GITHUB_BOT_TOKEN/);
  });

  it('still answers the info probe with no bot token, so Decap can detect the backend', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const response = await handler(
      makeContext(post({ action: 'info' }, { jwt: 'good' }), { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).repo).toBe('OWNER/REPO');
  });

  it('reports a bad request as a bad request even when the bot token is missing', async () => {
    // A missing token must not mask the reason a request was refused: the caller
    // should still learn that the action or the path was the problem.
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const env = { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined };

    const unknown = await handler(makeContext(post({ action: 'rmRf', params: {} }, { jwt: 'good' }), env));
    expect(unknown.status).toBe(422);

    const outside = await handler(
      makeContext(post({ action: 'getEntry', params: { branch: 'main', path: 'wrangler.toml' } }, { jwt: 'good' }), env),
    );
    expect(outside.status).toBe(400);
  });

  it('answers the actions that never touch GitHub even with no bot token', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const env = { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined };

    const preview = await handler(
      makeContext(post({ action: 'getDeployPreview', params: { branch: 'main', collection: 'about', slug: 'x' } }, { jwt: 'good' }), env),
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toBeNull();

    const unpublished = await handler(
      makeContext(post({ action: 'unpublishedEntries', params: { branch: 'main' } }, { jwt: 'good' }), env),
    );
    expect(unpublished.status).toBe(200);
    expect(await unpublished.json()).toEqual([]);
  });

  it('states the missing-token problem plainly, with no “could not reach GitHub” wrapper', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const response = await handler(
      makeContext(
        post({ action: 'getEntry', params: { branch: 'main', path: 'src/content/pages/about/x.md' } }, { jwt: 'good' }),
        { ...PROD_ENV, GITHUB_BOT_TOKEN: undefined },
      ),
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe('The site editor is not configured: GITHUB_BOT_TOKEN is not set.');
  });

  it('turns a GitHub API failure into a 502 and never logs the token', async () => {
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      }),
    );
    try {
      const handler = createCmsProxyHandler({
        verifyJwt: acceptAnyJwt,
        createClient: () =>
          ({
            listTree: async () => {
              throw Object.assign(new Error('GitHub API 403 on GET /repos/OWNER/REPO/git/trees/main'), { status: 403 });
            },
          }) as unknown as GitHubContentClient,
      });
      const response = await handler(
        makeContext(
          post(
            { action: 'entriesByFolder', params: { branch: 'main', folder: 'src/content/pages/about', extension: 'md', depth: 1 } },
            { jwt: 'good' },
          ),
        ),
      );
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(typeof body.error).toBe('string');
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('builds the GitHub client from the configured repo and branch', async () => {
    const { createClient, seen } = fakeClientFactory({ 'src/content/pages/about/x.md': 'body' });
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt, createClient });
    await handler(
      makeContext(post({ action: 'getEntry', params: { branch: 'main', path: 'src/content/pages/about/x.md' } }, { jwt: 'good' })),
    );
    expect(seen).toEqual([{ repo: 'OWNER/REPO', branch: 'main', token: TOKEN }]);
  });

  it('returns a clear 503 when GITHUB_REPO is not set, instead of an empty repo string', async () => {
    const handler = createCmsProxyHandler({ verifyJwt: acceptAnyJwt });
    const response = await handler(
      makeContext(post({ action: 'info' }, { jwt: 'good' }), { ...PROD_ENV, GITHUB_REPO: undefined }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('CMS is not configured: GITHUB_REPO is not set.');
  });

  it('turns a GitHub conflict (409) into a 409 the editor understands, not a 502', async () => {
    const handler = createCmsProxyHandler({
      verifyJwt: acceptAnyJwt,
      createClient: () =>
        ({
          getFile: async () => {
            throw new GitHubApiError('GitHub PUT /repos/OWNER/REPO/contents/x.md failed with 409: sha mismatch', 409);
          },
        }) as unknown as GitHubContentClient,
    });
    const response = await handler(
      makeContext(
        post({ action: 'getEntry', params: { branch: 'main', path: 'src/content/pages/about/x.md' } }, { jwt: 'good' }),
      ),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe(
      'Someone else changed this page since you opened it. Reload the editor and try again.',
    );
  });

  it('turns a GitHub validation failure (422) into the same 409 conflict message', async () => {
    const handler = createCmsProxyHandler({
      verifyJwt: acceptAnyJwt,
      createClient: () =>
        ({
          getFile: async () => {
            throw new GitHubApiError('GitHub PUT failed with 422', 422);
          },
        }) as unknown as GitHubContentClient,
    });
    const response = await handler(
      makeContext(
        post({ action: 'getEntry', params: { branch: 'main', path: 'src/content/pages/about/x.md' } }, { jwt: 'good' }),
      ),
    );
    expect(response.status).toBe(409);
  });

  it('leaves other GitHub errors as 502', async () => {
    const handler = createCmsProxyHandler({
      verifyJwt: acceptAnyJwt,
      createClient: () =>
        ({
          getFile: async () => {
            throw new GitHubApiError('GitHub GET failed with 403', 403);
          },
        }) as unknown as GitHubContentClient,
    });
    const response = await handler(
      makeContext(
        post({ action: 'getEntry', params: { branch: 'main', path: 'src/content/pages/about/x.md' } }, { jwt: 'good' }),
      ),
    );
    expect(response.status).toBe(502);
  });
});
