import { describe, it, expect } from 'vitest';
import { createGitHubContentClient, GitHubApiError, utf8ToBase64 } from '../functions/_lib/github-content';

const TOKEN = 'ghp_do_not_log_me';

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fake `fetchImpl` that records every request it sees and answers from a queue of
 * canned responses (or a `Map`-backed default when the queue is empty), so the tests
 * assert on the exact wire format the client sends rather than on internal calls.
 */
function makeFakeFetch(responses: (() => Response)[] = []) {
  const requests: RecordedRequest[] = [];
  const queue = [...responses];

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: unknown = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url: String(url), method: init.method ?? 'GET', headers, body });
    const next = queue.shift();
    if (!next) throw new Error(`makeFakeFetch: no canned response left for ${String(url)}`);
    return next();
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const AUTHOR = { name: 'Editor Person', email: 'editor@wssl.org' };

describe('createGitHubContentClient — listTree', () => {
  it('GETs the recursive tree of the branch, with the auth header, and filters to the prefix', async () => {
    const tree = {
      tree: [
        { path: 'src/content/pages/about.md', type: 'blob', sha: 'sha-about' },
        { path: 'src/content/pages/programs', type: 'tree', sha: 'sha-dir' },
        { path: 'src/content/pages/programs/core.md', type: 'blob', sha: 'sha-core' },
        { path: 'src/data/site.json', type: 'blob', sha: 'sha-site' },
      ],
      truncated: false,
    };
    const { fetchImpl, requests } = makeFakeFetch([() => jsonResponse(200, tree)]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    const entries = await client.listTree('src/content/pages');

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://api.github.com/repos/o/r/git/trees/main?recursive=1');
    expect(requests[0].headers['authorization']).toBe('Bearer t');

    expect(entries).toEqual([
      { path: 'src/content/pages/about.md', sha: 'sha-about' },
      { path: 'src/content/pages/programs/core.md', sha: 'sha-core' },
    ]);
  });

  it('throws a clear error when the tree response is truncated', async () => {
    const { fetchImpl } = makeFakeFetch([
      () => jsonResponse(200, { tree: [], truncated: true }),
      () => jsonResponse(200, { tree: [], truncated: true }),
    ]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    await expect(client.listTree('src/content/pages')).rejects.toThrow(GitHubApiError);
    await expect(client.listTree('src/content/pages')).rejects.toThrow(/too large/i);
  });
});

describe('createGitHubContentClient — getFile', () => {
  it('GETs the contents endpoint with ref=branch and decodes base64 content with embedded newlines', async () => {
    // GitHub wraps base64 content at 60 columns with embedded newlines.
    const wrapped = 'eyJuYW1lIjoi\nV1NTTCJ9\n';
    const { fetchImpl, requests } = makeFakeFetch([
      () => jsonResponse(200, { type: 'file', content: wrapped, encoding: 'base64', sha: 'sha-site' }),
    ]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    const file = await client.getFile('src/data/site.json');

    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://api.github.com/repos/o/r/contents/src/data/site.json?ref=main');
    expect(requests[0].headers['authorization']).toBe('Bearer t');
    expect(file).toEqual({ path: 'src/data/site.json', sha: 'sha-site', contentBase64: wrapped.replace(/\s+/g, '') });
    expect(Buffer.from(file!.contentBase64, 'base64').toString('utf8')).toBe('{"name":"WSSL"}');
  });

  it('returns null on a 404', async () => {
    const { fetchImpl } = makeFakeFetch([() => new Response('not found', { status: 404 })]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    expect(await client.getFile('src/data/missing.json')).toBeNull();
  });

  it('returns null when the Contents API answers with a JSON array (a directory)', async () => {
    const { fetchImpl } = makeFakeFetch([
      () => jsonResponse(200, [{ name: 'about.md', path: 'src/content/pages/about.md', type: 'file', sha: 'x' }]),
    ]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    expect(await client.getFile('src/content/pages')).toBeNull();
  });
});

describe('createGitHubContentClient — putFile', () => {
  it('PUTs the exact create body with no sha key, and URL-encodes path segments', async () => {
    const { fetchImpl, requests } = makeFakeFetch([
      () => jsonResponse(200, { content: { sha: 'new-sha' } }),
    ]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    const contentBase64 = utf8ToBase64('hello');
    const result = await client.putFile('src/content/pages/a b.md', contentBase64, 'content: create page "a b"', {
      author: AUTHOR,
    });

    expect(requests[0].method).toBe('PUT');
    expect(requests[0].url).toBe('https://api.github.com/repos/o/r/contents/src/content/pages/a%20b.md');
    expect(requests[0].headers['authorization']).toBe('Bearer t');
    expect(requests[0].body).toEqual({
      message: 'content: create page "a b"',
      content: contentBase64,
      branch: 'main',
      committer: { name: 'WSSL Site Editor', email: 'site-editor@wssl.org' },
      author: AUTHOR,
    });
    expect(requests[0].body as Record<string, unknown>).not.toHaveProperty('sha');
    expect(result).toEqual({ sha: 'new-sha' });
  });

  it('PUTs the sha on update', async () => {
    const { fetchImpl, requests } = makeFakeFetch([() => jsonResponse(200, { content: { sha: 'new-sha' } })]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    await client.putFile('src/data/site.json', utf8ToBase64('{}'), 'content: update site', {
      author: AUTHOR,
      sha: 'old-sha',
    });

    expect(requests[0].body).toMatchObject({ sha: 'old-sha' });
  });
});

describe('createGitHubContentClient — deleteFile', () => {
  it('DELETEs with message, branch, committer, author and sha', async () => {
    const { fetchImpl, requests } = makeFakeFetch([() => jsonResponse(200, {})]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: 't', fetchImpl });

    await client.deleteFile('public/uploads/old.png', 'content: delete old.png', { author: AUTHOR, sha: 'del-sha' });

    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].url).toBe('https://api.github.com/repos/o/r/contents/public/uploads/old.png');
    expect(requests[0].body).toEqual({
      message: 'content: delete old.png',
      branch: 'main',
      committer: { name: 'WSSL Site Editor', email: 'site-editor@wssl.org' },
      author: AUTHOR,
      sha: 'del-sha',
    });
  });
});

describe('createGitHubContentClient — errors', () => {
  it('throws GitHubApiError carrying the status, with a message that never includes the token', async () => {
    const { fetchImpl } = makeFakeFetch([() => jsonResponse(422, { message: 'Invalid request' })]);
    const client = createGitHubContentClient({ repo: 'o/r', branch: 'main', token: TOKEN, fetchImpl });

    const failure = client.putFile('src/data/site.json', utf8ToBase64('{}'), 'content: update site', {
      author: AUTHOR,
      sha: 'old-sha',
    });

    await expect(failure).rejects.toThrow(GitHubApiError);
    try {
      await failure;
      throw new Error('expected putFile to reject');
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubApiError);
      expect((e as InstanceType<typeof GitHubApiError>).status).toBe(422);
      expect((e as Error).message).not.toContain(TOKEN);
      expect((e as Error).message).toMatch(/Invalid request/);
    }
  });
});
