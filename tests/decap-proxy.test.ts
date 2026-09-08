import { describe, it, expect } from 'vitest';
import { handleProxyAction, ProxyError, ALLOWED_ROOTS } from '../functions/_lib/decap-proxy';
import { utf8ToBase64, base64ToUtf8 } from '../functions/_lib/github-content';
import type { Author, GitHubContentClient } from '../functions/_lib/github-content';

const EDITOR: Author = { name: 'editor@wssl.org', email: 'editor@wssl.org' };

type Write =
  | { type: 'put'; path: string; message: string; author: Author; sha?: string; contentBase64: string }
  | { type: 'delete'; path: string; message: string; author: Author; sha: string };

/**
 * In-memory stand-in for the GitHub Contents/Trees API: a Map of path → { base64, sha }
 * plus a log of every write, so the tests assert on real behaviour (what ended up in the
 * repo, under whose name) rather than on calls to the code under test.
 */
function makeFakeGitHub(seed: Record<string, string> = {}) {
  const files = new Map<string, { base64: string; sha: string }>();
  const writes: Write[] = [];
  let counter = 0;
  const nextSha = () => `sha-${++counter}`;

  for (const [path, text] of Object.entries(seed)) files.set(path, { base64: utf8ToBase64(text), sha: nextSha() });

  const github: GitHubContentClient = {
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
      const f = files.get(path);
      return f ? base64ToUtf8(f.base64) : null;
    },
    async putFile(path, contentBase64, message, opts) {
      writes.push({ type: 'put', path, message, author: opts.author, sha: opts.sha, contentBase64 });
      const sha = nextSha();
      files.set(path, { base64: contentBase64, sha });
      return { sha };
    },
    async deleteFile(path, message, opts) {
      writes.push({ type: 'delete', path, message, author: opts.author, sha: opts.sha });
      files.delete(path);
    },
  };

  const text = (path: string) => {
    const f = files.get(path);
    return f ? base64ToUtf8(f.base64) : null;
  };

  return { github, files, writes, text, deps: { github, repo: 'OWNER/REPO', author: EDITOR } };
}

const PAGES = 'src/content/pages';

describe('handleProxyAction — info', () => {
  it('answers the proxy-server detection probe with the shape Decap looks for', async () => {
    const { deps } = makeFakeGitHub();
    // Decap's detectProxyServer() POSTs { action: 'info' } with no params at all.
    const info = (await handleProxyAction('info', undefined, deps)) as Record<string, unknown>;
    expect(info).toEqual({ repo: 'OWNER/REPO', publish_modes: ['simple'], type: 'github' });
    expect(typeof info.repo).toBe('string');
    expect(Array.isArray(info.publish_modes)).toBe(true);
    expect(typeof info.type).toBe('string');
  });
});

describe('handleProxyAction — reads', () => {
  const seed = {
    [`${PAGES}/programs/index.md`]: '# Programs',
    [`${PAGES}/programs/core.md`]: '# Core',
    [`${PAGES}/programs/sub/deep.md`]: '# Deep',
    [`${PAGES}/programs/notes.txt`]: 'not an entry',
    'src/data/site.json': '{"name":"WSSL"}',
  };

  it('entriesByFolder returns { data, file: { path, id } } and honours extension and depth', async () => {
    const { deps } = makeFakeGitHub(seed);
    const entries = (await handleProxyAction(
      'entriesByFolder',
      { branch: 'main', folder: `${PAGES}/programs`, extension: 'md', depth: 1 },
      deps,
    )) as { data: string; file: { path: string; id: string } }[];

    expect(entries.map((e) => e.file.path).sort()).toEqual([`${PAGES}/programs/core.md`, `${PAGES}/programs/index.md`]);
    const index = entries.find((e) => e.file.path.endsWith('index.md'))!;
    expect(index.data).toBe('# Programs');
    expect(typeof index.file.id).toBe('string');
    expect(index.file.id.length).toBeGreaterThan(0);
  });

  it('entriesByFolder reaches nested folders when Decap asks for more depth', async () => {
    const { deps } = makeFakeGitHub(seed);
    const entries = (await handleProxyAction(
      'entriesByFolder',
      { branch: 'main', folder: `${PAGES}/programs`, extension: 'md', depth: 2 },
      deps,
    )) as { file: { path: string } }[];
    expect(entries.map((e) => e.file.path)).toContain(`${PAGES}/programs/sub/deep.md`);
  });

  it('entriesByFolder returns [] for a folder that does not exist yet', async () => {
    const { deps } = makeFakeGitHub(seed);
    const entries = await handleProxyAction(
      'entriesByFolder',
      { branch: 'main', folder: `${PAGES}/nothing-here`, extension: 'md', depth: 1 },
      deps,
    );
    expect(entries).toEqual([]);
  });

  it('entriesByFiles preserves the label and reports missing files as data: null, id: null', async () => {
    const { deps } = makeFakeGitHub(seed);
    const entries = (await handleProxyAction(
      'entriesByFiles',
      {
        branch: 'main',
        files: [
          { path: 'src/data/site.json', label: 'Contact & links' },
          { path: 'src/data/missing.json' },
        ],
      },
      deps,
    )) as { data: string | null; file: { path: string; label?: string; id: string | null } }[];

    expect(entries[0].data).toBe('{"name":"WSSL"}');
    expect(entries[0].file.label).toBe('Contact & links');
    expect(entries[1]).toEqual({ data: null, file: { path: 'src/data/missing.json', label: undefined, id: null } });
  });

  it('getEntry returns the single entry object, not an array', async () => {
    const { deps } = makeFakeGitHub(seed);
    const entry = (await handleProxyAction(
      'getEntry',
      { branch: 'main', path: `${PAGES}/programs/core.md` },
      deps,
    )) as { data: string; file: { path: string } };
    expect(entry.data).toBe('# Core');
    expect(entry.file.path).toBe(`${PAGES}/programs/core.md`);
  });

  it('unpublishedEntries returns [] because there is no editorial workflow', async () => {
    const { deps } = makeFakeGitHub(seed);
    expect(await handleProxyAction('unpublishedEntries', { branch: 'main' }, deps)).toEqual([]);
  });

  it('getDeployPreview returns null', async () => {
    const { deps } = makeFakeGitHub(seed);
    expect(await handleProxyAction('getDeployPreview', { branch: 'main', collection: 'programs', slug: 'core' }, deps)).toBeNull();
  });
});

describe('handleProxyAction — persistEntry', () => {
  const commitMessage = 'content: update programs "core"';

  it('writes the raw file, attributes the commit to the editor and reuses the existing blob sha', async () => {
    const { deps, writes, text } = makeFakeGitHub({ [`${PAGES}/programs/core.md`]: 'old' });
    const before = await deps.github.getFile(`${PAGES}/programs/core.md`);

    const result = await handleProxyAction(
      'persistEntry',
      {
        branch: 'main',
        dataFiles: [{ slug: 'core', path: `${PAGES}/programs/core.md`, raw: '# New body' }],
        assets: [],
        options: { commitMessage, useWorkflow: false, status: 'draft' },
      },
      deps,
    );

    expect(result).toEqual({ message: 'entry persisted' });
    expect(text(`${PAGES}/programs/core.md`)).toBe('# New body');
    expect(writes).toEqual([
      {
        type: 'put',
        path: `${PAGES}/programs/core.md`,
        message: commitMessage,
        author: EDITOR,
        sha: before!.sha,
        contentBase64: utf8ToBase64('# New body'),
      },
    ]);
  });

  it('creates a new file with no sha when the entry does not exist yet', async () => {
    const { deps, writes, text } = makeFakeGitHub();
    await handleProxyAction(
      'persistEntry',
      {
        branch: 'main',
        dataFiles: [{ slug: 'new', path: `${PAGES}/programs/new.md`, raw: 'hello' }],
        assets: [],
        options: { commitMessage: 'content: create programs "new"', useWorkflow: false, status: 'draft' },
      },
      deps,
    );
    expect(text(`${PAGES}/programs/new.md`)).toBe('hello');
    expect(writes[0].sha).toBeUndefined();
  });

  it('supports the legacy single `entry` param that older Decap clients send', async () => {
    const { deps, text } = makeFakeGitHub();
    await handleProxyAction(
      'persistEntry',
      {
        branch: 'main',
        entry: { slug: 'legacy', path: `${PAGES}/about/legacy.md`, raw: 'legacy body' },
        assets: [],
        options: { commitMessage, useWorkflow: false, status: 'draft' },
      },
      deps,
    );
    expect(text(`${PAGES}/about/legacy.md`)).toBe('legacy body');
  });

  it('writes attached assets as base64 under the editor’s name', async () => {
    const { deps, writes, files } = makeFakeGitHub();
    const pngBase64 = utf8ToBase64('pretend-png-bytes');
    await handleProxyAction(
      'persistEntry',
      {
        branch: 'main',
        dataFiles: [{ slug: 'core', path: `${PAGES}/programs/core.md`, raw: 'body' }],
        assets: [{ path: 'public/uploads/photo.png', content: pngBase64, encoding: 'base64' }],
        options: { commitMessage, useWorkflow: false, status: 'draft' },
      },
      deps,
    );
    expect(files.get('public/uploads/photo.png')!.base64).toBe(pngBase64);
    expect(writes.every((w) => w.author === EDITOR)).toBe(true);
  });

  it('renames via newPath by writing the new file and deleting the old one', async () => {
    const { deps, writes, files } = makeFakeGitHub({ [`${PAGES}/programs/old.md`]: 'body' });
    const old = await deps.github.getFile(`${PAGES}/programs/old.md`);

    await handleProxyAction(
      'persistEntry',
      {
        branch: 'main',
        dataFiles: [{ slug: 'new', path: `${PAGES}/programs/old.md`, raw: 'moved body', newPath: `${PAGES}/programs/new.md` }],
        assets: [],
        options: { commitMessage, useWorkflow: false, status: 'draft' },
      },
      deps,
    );

    expect(files.has(`${PAGES}/programs/old.md`)).toBe(false);
    expect(files.get(`${PAGES}/programs/new.md`)).toBeDefined();
    expect(writes.map((w) => [w.type, w.path])).toEqual([
      ['put', `${PAGES}/programs/new.md`],
      ['delete', `${PAGES}/programs/old.md`],
    ]);
    expect(writes[1]).toMatchObject({ type: 'delete', sha: old!.sha, author: EDITOR });
  });

  it('never puts the editor email in the commit message', async () => {
    const { deps, writes } = makeFakeGitHub();
    await handleProxyAction(
      'persistEntry',
      {
        branch: 'main',
        dataFiles: [{ slug: 'core', path: `${PAGES}/programs/core.md`, raw: 'body' }],
        assets: [],
        options: { commitMessage, useWorkflow: false, status: 'draft' },
      },
      deps,
    );
    expect(writes[0].message).toBe(commitMessage);
    expect(writes[0].message).not.toContain('@wssl.org');
  });
});

describe('handleProxyAction — media', () => {
  it('getMedia returns { id, name, path, content, encoding } for direct children only', async () => {
    const { deps } = makeFakeGitHub({
      'public/uploads/flyer.pdf': 'pdf-bytes',
      'public/uploads/nested/ignored.png': 'nope',
    });
    const media = (await handleProxyAction('getMedia', { branch: 'main', mediaFolder: 'public/uploads' }, deps)) as {
      id: string;
      name: string;
      path: string;
      content: string;
      encoding: string;
    }[];

    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      name: 'flyer.pdf',
      path: 'public/uploads/flyer.pdf',
      content: utf8ToBase64('pdf-bytes'),
      encoding: 'base64',
    });
    expect(typeof media[0].id).toBe('string');
  });

  it('getMediaFile returns one media file in the same shape', async () => {
    const { deps } = makeFakeGitHub({ 'public/uploads/flyer.pdf': 'pdf-bytes' });
    const file = await handleProxyAction('getMediaFile', { branch: 'main', path: 'public/uploads/flyer.pdf' }, deps);
    expect(file).toMatchObject({ name: 'flyer.pdf', path: 'public/uploads/flyer.pdf', encoding: 'base64' });
  });

  it('getMediaFile on a missing file is a 404 the editor can act on', async () => {
    const { deps } = makeFakeGitHub();
    await expect(
      handleProxyAction('getMediaFile', { branch: 'main', path: 'public/uploads/gone.pdf' }, deps),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('persistMedia commits the upload and returns the stored media file', async () => {
    const { deps, files, writes } = makeFakeGitHub();
    const content = utf8ToBase64('image-bytes');
    const file = (await handleProxyAction(
      'persistMedia',
      {
        branch: 'main',
        asset: { path: 'public/uploads/logo.png', content, encoding: 'base64' },
        options: { commitMessage: 'content: upload public/uploads/logo.png' },
      },
      deps,
    )) as { id: string; name: string; path: string; content: string; encoding: string };

    expect(files.get('public/uploads/logo.png')!.base64).toBe(content);
    expect(file).toMatchObject({ name: 'logo.png', path: 'public/uploads/logo.png', content, encoding: 'base64' });
    expect(writes[0]).toMatchObject({ type: 'put', author: EDITOR, message: 'content: upload public/uploads/logo.png' });
  });
});

describe('handleProxyAction — deletes', () => {
  it('deleteFiles removes every path with the editor as author', async () => {
    const { deps, files, writes } = makeFakeGitHub({
      'public/uploads/a.png': 'a',
      'public/uploads/b.png': 'b',
    });
    const result = await handleProxyAction(
      'deleteFiles',
      { branch: 'main', paths: ['public/uploads/a.png', 'public/uploads/b.png'], options: { commitMessage: 'content: delete public/uploads/a.png' } },
      deps,
    );
    expect(result).toEqual({ message: 'deleted files public/uploads/a.png, public/uploads/b.png' });
    expect(files.size).toBe(0);
    expect(writes.map((w) => w.type)).toEqual(['delete', 'delete']);
    expect(writes.every((w) => w.author === EDITOR)).toBe(true);
  });

  it('deleteFile removes a single path', async () => {
    const { deps, files } = makeFakeGitHub({ 'public/uploads/a.png': 'a' });
    const result = await handleProxyAction(
      'deleteFile',
      { branch: 'main', path: 'public/uploads/a.png', options: { commitMessage: 'content: delete public/uploads/a.png' } },
      deps,
    );
    expect(result).toEqual({ message: 'deleted file public/uploads/a.png' });
    expect(files.size).toBe(0);
  });

  it('deleting something that is already gone succeeds, as it does on the local proxy', async () => {
    const { deps, writes } = makeFakeGitHub();
    await handleProxyAction(
      'deleteFile',
      { branch: 'main', path: 'public/uploads/gone.png', options: { commitMessage: 'content: delete public/uploads/gone.png' } },
      deps,
    );
    expect(writes).toEqual([]);
  });
});

describe('handleProxyAction — path allow-list', () => {
  it('names exactly the four writable roots', () => {
    expect([...ALLOWED_ROOTS]).toEqual(['src/content/pages', 'src/data', 'public/uploads', 'public/images']);
  });

  it('allows media under public/images (the home-page image widgets) but not other public/ folders', async () => {
    const { deps, files, writes } = makeFakeGitHub({ 'public/images/hero.png': 'hero-bytes' });
    const content = utf8ToBase64('new-hero-bytes');

    const media = (await handleProxyAction('getMedia', { branch: 'main', mediaFolder: 'public/images' }, deps)) as {
      path: string;
    }[];
    expect(media).toEqual([expect.objectContaining({ path: 'public/images/hero.png' })]);

    const persisted = (await handleProxyAction(
      'persistMedia',
      {
        branch: 'main',
        asset: { path: 'public/images/hero.png', content, encoding: 'base64' },
        options: { commitMessage: 'content: upload public/images/hero.png' },
      },
      deps,
    )) as { path: string };
    expect(persisted.path).toBe('public/images/hero.png');
    expect(files.get('public/images/hero.png')!.base64).toBe(content);
    expect(writes[writes.length - 1]).toMatchObject({ type: 'put', path: 'public/images/hero.png' });

    await expect(
      handleProxyAction('getMedia', { branch: 'main', mediaFolder: 'public/other' }, deps),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      handleProxyAction(
        'persistMedia',
        {
          branch: 'main',
          asset: { path: 'public/other/x.png', content, encoding: 'base64' },
          options: { commitMessage: 'x' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  const rejected: [string, string, Record<string, unknown>][] = [
    ['a source file outside the content roots', 'getEntry', { path: 'astro.config.mjs' }],
    ['a workflow file', 'getEntry', { path: '.github/workflows/deploy.yml' }],
    ['a traversal out of an allowed root', 'getEntry', { path: 'src/content/pages/../../../etc/passwd' }],
    ['a bare .. segment', 'getEntry', { path: '../secrets.env' }],
    ['an absolute path', 'getEntry', { path: '/etc/passwd' }],
    ['a prefix that only looks allowed', 'getEntry', { path: 'src/datalake/secret.json' }],
    ['a folder listing outside the roots', 'entriesByFolder', { folder: 'functions/_lib', extension: 'ts', depth: 1 }],
    ['a media folder outside the roots', 'getMedia', { mediaFolder: 'functions' }],
  ];

  for (const [label, action, params] of rejected) {
    it(`rejects ${label} with 400`, async () => {
      const { deps } = makeFakeGitHub();
      await expect(handleProxyAction(action, { branch: 'main', ...params }, deps)).rejects.toMatchObject({
        status: 400,
      });
    });
  }

  it('rejects a persistEntry that writes outside the roots, before writing anything', async () => {
    const { deps, writes } = makeFakeGitHub();
    await expect(
      handleProxyAction(
        'persistEntry',
        {
          branch: 'main',
          dataFiles: [{ slug: 'x', path: 'functions/api/chat.ts', raw: 'pwned' }],
          assets: [],
          options: { commitMessage: 'nope', useWorkflow: false, status: 'draft' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it('rejects a persistEntry whose newPath escapes the roots, before writing anything', async () => {
    const { deps, writes } = makeFakeGitHub();
    await expect(
      handleProxyAction(
        'persistEntry',
        {
          branch: 'main',
          dataFiles: [{ slug: 'x', path: `${PAGES}/about/x.md`, raw: 'body', newPath: 'package.json' }],
          assets: [],
          options: { commitMessage: 'nope', useWorkflow: false, status: 'draft' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it('rejects an asset written outside the roots, before writing anything', async () => {
    const { deps, writes } = makeFakeGitHub();
    await expect(
      handleProxyAction(
        'persistEntry',
        {
          branch: 'main',
          dataFiles: [{ slug: 'x', path: `${PAGES}/about/x.md`, raw: 'body' }],
          assets: [{ path: 'public/_headers', content: utf8ToBase64('evil'), encoding: 'base64' }],
          options: { commitMessage: 'nope', useWorkflow: false, status: 'draft' },
        },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });

  it('rejects deleteFiles when any one path escapes the roots, before deleting anything', async () => {
    const { deps, writes } = makeFakeGitHub({ 'public/uploads/a.png': 'a' });
    await expect(
      handleProxyAction(
        'deleteFiles',
        { branch: 'main', paths: ['public/uploads/a.png', 'wrangler.toml'], options: { commitMessage: 'nope' } },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(writes).toEqual([]);
  });
});

describe('handleProxyAction — bad requests', () => {
  it('rejects an unknown action the way decap-server does (422)', async () => {
    const { deps } = makeFakeGitHub();
    await expect(handleProxyAction('rmRf', { branch: 'main' }, deps)).rejects.toMatchObject({
      status: 422,
      message: 'Unknown action rmRf',
    });
  });

  it('rejects the editorial-workflow actions this backend does not implement', async () => {
    const { deps } = makeFakeGitHub();
    await expect(
      handleProxyAction('publishUnpublishedEntry', { branch: 'main', collection: 'programs', slug: 'core' }, deps),
    ).rejects.toBeInstanceOf(ProxyError);
  });

  it('rejects params that are missing required fields (400)', async () => {
    const { deps } = makeFakeGitHub();
    await expect(handleProxyAction('getEntry', { branch: 'main' }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(
      handleProxyAction('persistEntry', { branch: 'main', assets: [], options: { commitMessage: 'x' } }, deps),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      handleProxyAction(
        'persistMedia',
        { branch: 'main', asset: { path: 'public/uploads/a.png', content: 'x', encoding: 'utf-8' }, options: { commitMessage: 'x' } },
        deps,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});
