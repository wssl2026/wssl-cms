# WSSL Site Migration + AI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Mura-based wssl.org with an Astro static site whose Markdown content is edited through Decap CMS, hosted on Cloudflare Pages, with a custom Claude-powered "Ask WSSL" assistant that answers from the site's own pages.

**Architecture:** A one-shot migration script pulls every page from the legacy Mura JSON API, converts HTML to Markdown under `src/content/pages/<section>/`, and downloads PDFs/images. Astro renders those files statically; Decap CMS at `/admin` commits edits to GitHub (all editors equal, direct publish); Cloudflare Pages rebuilds on every commit. Three Pages Functions provide the Decap GitHub OAuth handshake (`/api/auth`, `/api/callback`) and the assistant (`/api/chat`), which streams answers from `claude-opus-5` using the full ~66K-token site corpus as cached, citable documents.

**Tech Stack:** Node 24, TypeScript, Astro 5 (static output), Tailwind CSS 4 + typography plugin, Decap CMS 3, Cloudflare Pages + Pages Functions + KV, `@anthropic-ai/sdk`, turndown + turndown-plugin-gfm, gray-matter, yaml, marked + DOMPurify, Vitest, wrangler.

**Spec:** `docs/superpowers/specs/2026-09-08-wssl-migration-spec.md` (local capture of the Google Doc plus the decided deltas). Read it first.

## Global Constraints

- Node `>=24` (local machine has v24.11.1, npm 11.12.1). Cloudflare Pages build must set `NODE_VERSION=24`.
- Site URL is `https://www.wssl.org`; every page URL ends with a trailing slash (`trailingSlash: 'always'`).
- Content lives only in `src/content/pages/<section>/<file>.md`; sections are exactly `programs`, `registration`, `schedules`, `fields`, `volunteers`, `about`.
- Page frontmatter fields are exactly: `title` (string), `path` (string, `^$|^[a-z0-9-]+(/[a-z0-9-]+)*$`), `description?`, `draft` (default false), `updated?` (YYYY-MM-DD), `legacyUrl?`.
- Editors are GitHub collaborators with write access; Decap publishes straight to `main` (no editorial workflow).
- Assistant model is `claude-opus-5` (exact string, no date suffix). Streaming always. Adaptive thinking (omit or `{ type: 'adaptive' }`), `output_config.effort = 'medium'`, `fallbacks: 'default'` with beta header `server-side-fallback-2026-07-01`, prompt cache TTL `1h`. Never use `budget_tokens`, `temperature`, or assistant prefill.
- Hard daily cap on assistant requests (default 1500/day) enforced in KV; Cloudflare WAF rate-limit rule on `/api/chat`.
- Brand: navy `#002664`, gold `#ffbd41`, font "PT Sans".
- Secrets (`ANTHROPIC_API_KEY`, `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`) are never committed; locally they live in `.dev.vars` (git-ignored).
- Every task ends with green `npm test` and a commit. Work on branch `site-build` for Tasks 1–11; Task 12 merges to `main` and deploys.

---

## File Structure

```
wssl-cms/
├── astro.config.mjs                 # site URL, trailing slash, sitemap, tailwind vite plugin
├── package.json / tsconfig.json / vitest.config.ts / wrangler.toml
├── .gitignore  .dev.vars.example  README.md
├── public/
│   ├── admin/index.html             # Decap CMS shell
│   ├── admin/config.yml             # Decap collections (6 sections + Site Settings)
│   ├── images/                      # logos, carousel (downloaded by migrate)
│   ├── assets/legacy/               # PDFs/images pulled from Mura (downloaded by migrate)
│   ├── uploads/                     # Decap media uploads (editors)
│   ├── _redirects  robots.txt
├── src/
│   ├── content.config.ts            # Astro content collection `pages`
│   ├── content/pages/<section>/*.md # migrated + editor content
│   ├── data/nav.json  site.json  alerts.json   # Decap "Site Settings" files
│   ├── lib/page-schema.ts           # zod schema shared by Astro + tests
│   ├── lib/pages.ts                 # sectionOf(), urlFor()
│   ├── lib/chat-client.ts           # browser SSE parsing + fetch (pure parser is tested)
│   ├── layouts/BaseLayout.astro  PageLayout.astro
│   ├── components/Header.astro Footer.astro AlertBanner.astro ChatWidget.astro
│   ├── pages/index.astro  404.astro  [...slug].astro
│   └── styles/global.css            # tailwind + theme tokens
├── scripts/
│   ├── lib/mura.ts                  # fetchAllContent(), targetFor(), frontmatter(), buildNav()
│   ├── lib/convert.ts               # htmlToMarkdown(), asset path rewriting
│   ├── lib/corpus.ts                # buildCorpus()
│   ├── lib/links.ts                 # internalHrefs(), resolveInternal()
│   ├── migrate.ts                   # one-shot: Mura → markdown + assets + nav.json
│   ├── build-corpus.ts              # writes functions/_lib/corpus.json (runs in `npm run build`)
│   ├── count-corpus-tokens.ts       # prints token count of the assistant request
│   └── check-links.ts               # post-build internal link checker
├── functions/
│   ├── tsconfig.json
│   ├── _lib/oauth.ts                # callbackHtml()
│   ├── _lib/chat.ts                 # SYSTEM_PROMPT, validateHistory(), buildMessages()
│   ├── _lib/sse.ts                  # streamToClient(), encodeEvent()
│   ├── _lib/usage.ts                # checkDailyCap()
│   ├── _lib/corpus.json             # generated, git-ignored
│   ├── api/auth.ts  api/callback.ts # Decap GitHub OAuth
│   └── api/chat.ts                  # assistant endpoint
├── tests/*.test.ts
└── docs/editors.md  docs/runbook.md
```

---

### Task 1: Repository scaffold (Astro 5 + Tailwind 4 + Vitest)

**Files:**
- Create: `package.json` (via npm), `astro.config.mjs`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.dev.vars.example`, `src/styles/global.css`, `src/pages/index.astro` (placeholder), `README.md`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `dev`, `build`, `preview`, `test`, `migrate`, `corpus`, `check-links`; Tailwind theme tokens `--color-navy`, `--color-gold`, `--font-sans`.

- [ ] **Step 1: Create branch and package.json**

```bash
cd /Users/weitang/PycharmProjects/wssl-cms
git checkout -b site-build
npm init -y
npm pkg set type=module private=true name=wssl-cms
npm pkg set scripts.dev="astro dev" scripts.build="tsx scripts/build-corpus.ts && astro build" scripts.preview="wrangler pages dev dist" scripts.test="vitest run" scripts.migrate="tsx scripts/migrate.ts" scripts.corpus="tsx scripts/build-corpus.ts" scripts.check-links="tsx scripts/check-links.ts"
npm install astro @astrojs/sitemap tailwindcss @tailwindcss/vite @tailwindcss/typography yaml marked dompurify @anthropic-ai/sdk
npm install -D typescript vitest tsx turndown turndown-plugin-gfm @types/turndown gray-matter fast-glob wrangler @cloudflare/workers-types
```

- [ ] **Step 2: Write config files**

`astro.config.mjs`:
```js
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://www.wssl.org',
  trailingSlash: 'always',
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
});
```

`tsconfig.json`:
```json
{
  "extends": "astro/tsconfigs/strict",
  "compilerOptions": {
    "types": ["vitest/globals"],
    "resolveJsonModule": true,
    "strictNullChecks": true
  },
  "include": [".astro/types.d.ts", "src/**/*", "scripts/**/*", "functions/**/*", "tests/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], globals: true, testTimeout: 30_000 },
});
```

`.gitignore`:
```
node_modules/
dist/
.astro/
.wrangler/
.dev.vars
functions/_lib/corpus.json
scripts/migration-report.json
.superpowers/
.idea/
.DS_Store
```

`.dev.vars.example`:
```
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_OAUTH_CLIENT_ID=
GITHUB_OAUTH_CLIENT_SECRET=
DAILY_CAP=1500
```

`src/styles/global.css`:
```css
@import "tailwindcss";
@plugin "@tailwindcss/typography";

@theme {
  --color-navy: #002664;
  --color-gold: #ffbd41;
  --font-sans: "PT Sans", ui-sans-serif, system-ui, sans-serif;
}

/* PDF links get a small badge so "document download boxes" need no component */
.prose a[href$=".pdf"]::after { content: " (PDF)"; font-size: 0.8em; color: var(--color-navy); }
```

`src/pages/index.astro` (placeholder, replaced in Task 6):
```astro
---
import '../styles/global.css';
---
<html lang="en"><head><meta charset="utf-8" /><title>West Side Soccer League</title></head>
<body class="font-sans"><h1 class="text-navy text-3xl p-8">West Side Soccer League</h1></body></html>
```

`README.md`:
```markdown
# wssl-cms
Source for https://www.wssl.org — Astro static site, content in `src/content/pages`, edited via Decap CMS at `/admin`, hosted on Cloudflare Pages. See `docs/editors.md` (editing) and `docs/runbook.md` (operations).
```

- [ ] **Step 3: Write the smoke test**

`tests/smoke.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';

describe('scaffold', () => {
  it('package scripts exist', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const s of ['dev', 'build', 'test', 'migrate', 'corpus', 'check-links']) {
      expect(pkg.scripts[s], s).toBeTruthy();
    }
  });
  it('config files exist', () => {
    for (const f of ['astro.config.mjs', 'vitest.config.ts', '.dev.vars.example', 'src/styles/global.css']) {
      expect(existsSync(f), f).toBe(true);
    }
  });
});
```

- [ ] **Step 4: Run tests and a first build**

Run: `npm test`
Expected: 2 passed.

Run: `npx astro build`
Expected: `dist/index.html` exists (`test -f dist/index.html && echo ok`). (`npm run build` will fail until Task 8 adds `scripts/build-corpus.ts`; use `npx astro build` until then.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold Astro 5 + Tailwind 4 + Vitest project"
```

---

### Task 2: Content collection, page schema, and catch-all route

**Files:**
- Create: `src/lib/page-schema.ts`, `src/lib/pages.ts`, `src/content.config.ts`, `src/layouts/PageLayout.astro` (minimal, extended in Task 5), `src/pages/[...slug].astro`, fixture `src/content/pages/about/history.md`
- Test: `tests/pages.test.ts`

**Interfaces:**
- Produces: `pageSchema` (zod), `PAGE_FIELD_NAMES: readonly string[]`, `PATH_PATTERN: RegExp`, `sectionOf(id: string): string`, `urlFor(id: string, path: string): string` (returns `/section/path/` or `/section/` when path is `''`).

- [ ] **Step 1: Write the failing test**

`tests/pages.test.ts`:
```ts
import { sectionOf, urlFor } from '../src/lib/pages';
import { pageSchema, PATH_PATTERN, PAGE_FIELD_NAMES } from '../src/lib/page-schema';

describe('urlFor', () => {
  it('builds section + path URLs with trailing slash', () => {
    expect(urlFor('about/history', 'history')).toBe('/about/history/');
    expect(urlFor('volunteers/coaches-certification', 'coaches/certification')).toBe('/volunteers/coaches/certification/');
  });
  it('maps empty path to the section index', () => {
    expect(urlFor('programs/index', '')).toBe('/programs/');
  });
  it('sectionOf returns the first id segment', () => {
    expect(sectionOf('schedules/game-schedules-core-games')).toBe('schedules');
  });
});

describe('pageSchema', () => {
  it('accepts a valid page and applies defaults', () => {
    const r = pageSchema.parse({ title: 'History', path: 'history', updated: '2024-11-10' });
    expect(r.draft).toBe(false);
    expect(r.updated).toBeInstanceOf(Date);
  });
  it('rejects bad paths', () => {
    expect(() => pageSchema.parse({ title: 'x', path: 'Bad Path' })).toThrow();
    expect(PATH_PATTERN.test('')).toBe(true);
    expect(PATH_PATTERN.test('core/waitlists')).toBe(true);
    expect(PATH_PATTERN.test('/core/')).toBe(false);
  });
  it('exposes the field list used by the CMS config test', () => {
    expect(PAGE_FIELD_NAMES).toEqual(['title', 'path', 'description', 'draft', 'updated', 'legacyUrl', 'body']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pages.test.ts`
Expected: FAIL — cannot find module `../src/lib/pages`.

- [ ] **Step 3: Implement schema, helpers, collection, route**

`src/lib/page-schema.ts`:
```ts
import { z } from 'astro/zod';

export const PATH_PATTERN = /^$|^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export const pageSchema = z.object({
  title: z.string().min(1),
  path: z.string().regex(PATH_PATTERN, 'lowercase letters, digits, dashes and slashes only'),
  description: z.string().optional(),
  draft: z.boolean().default(false),
  updated: z.coerce.date().optional(),
  legacyUrl: z.string().optional(),
});

export type PageFrontmatter = z.infer<typeof pageSchema>;

/** Frontmatter keys + `body`; the Decap config test checks its fields against this list. */
export const PAGE_FIELD_NAMES = ['title', 'path', 'description', 'draft', 'updated', 'legacyUrl', 'body'] as const;
```

`src/lib/pages.ts`:
```ts
export function sectionOf(id: string): string {
  return id.split('/')[0];
}

/** URL for a content entry: `/section/path/`, or `/section/` when path is empty. */
export function urlFor(id: string, path: string): string {
  const section = sectionOf(id);
  return path === '' ? `/${section}/` : `/${section}/${path}/`;
}
```

`src/content.config.ts`:
```ts
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { pageSchema } from './lib/page-schema';

const pages = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
  schema: pageSchema,
});

export const collections = { pages };
```

`src/layouts/PageLayout.astro` (minimal for now; Task 5 swaps in BaseLayout):
```astro
---
import '../styles/global.css';
interface Props { title: string; description?: string }
const { title, description } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title} - West Side Soccer League</title>
    {description && <meta name="description" content={description} />}
  </head>
  <body class="font-sans">
    <main class="mx-auto max-w-4xl px-4 py-8">
      <h1 class="text-3xl font-bold text-navy mb-6">{title}</h1>
      <div class="prose max-w-none"><slot /></div>
    </main>
  </body>
</html>
```

`src/pages/[...slug].astro`:
```astro
---
import { getCollection, render } from 'astro:content';
import PageLayout from '../layouts/PageLayout.astro';
import { urlFor } from '../lib/pages';

export async function getStaticPaths() {
  const pages = await getCollection('pages', (p) => !p.data.draft);
  return pages.map((page) => ({
    params: { slug: urlFor(page.id, page.data.path).slice(1, -1) },
    props: { page },
  }));
}

const { page } = Astro.props;
const { Content } = await render(page);
---
<PageLayout title={page.data.title} description={page.data.description}>
  <Content />
</PageLayout>
```

Fixture `src/content/pages/about/history.md`:
```markdown
---
title: History
path: history
updated: 2024-11-10
---
West Side Soccer League was founded in 1972.
```

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run tests/pages.test.ts`
Expected: PASS (6 tests).

Run: `npx astro build && test -f dist/about/history/index.html && grep -c "founded in 1972" dist/about/history/index.html`
Expected: `1`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: content collection, page schema and catch-all page route"
```

---

### Task 3: HTML → Markdown converter (pure, fully tested)

**Files:**
- Create: `scripts/lib/convert.ts`
- Test: `tests/convert.test.ts`

**Interfaces:**
- Produces: `htmlToMarkdown(html: string): { markdown: string; assets: string[] }` where `assets` are legacy asset paths like `/sites/wssl/assets/File/Foo.pdf` (host stripped, URL-encoded as found); `stripHost(href)`, `isLegacyAsset(href)`, `localAssetPath(href): string` (e.g. `/assets/legacy/File/Foo-Bar.pdf`), `normalizeInternal(href): string`.

- [ ] **Step 1: Write the failing tests**

`tests/convert.test.ts`:
```ts
import { htmlToMarkdown, localAssetPath, isLegacyAsset, normalizeInternal, stripHost } from '../scripts/lib/convert';

describe('asset helpers', () => {
  it('detects legacy assets on any wssl host', () => {
    expect(isLegacyAsset('/sites/wssl/assets/File/A.pdf')).toBe(true);
    expect(isLegacyAsset('https://cms.wssl.org/sites/wssl/assets/File/A.pdf')).toBe(true);
    expect(isLegacyAsset('https://inleague.wssl.org/documents/files/611/x.pdf')).toBe(false);
  });
  it('maps legacy asset URLs to sanitized local paths', () => {
    expect(localAssetPath('/sites/wssl/assets/File/WSSL%20Clinic%20Week%201.pdf')).toBe('/assets/legacy/File/WSSL-Clinic-Week-1.pdf');
    expect(localAssetPath('https://www.wssl.org/sites/wssl/assets/Image/WSSL/g11 core - 1 (1).jpeg')).toBe('/assets/legacy/Image/WSSL/g11-core-1-1-.jpeg');
  });
  it('strips wssl hosts only', () => {
    expect(stripHost('https://www.wssl.org/programs/core/')).toBe('/programs/core/');
    expect(stripHost('https://randallsisland.org/map.pdf')).toBe('https://randallsisland.org/map.pdf');
  });
  it('normalizes internal links to trailing-slash paths', () => {
    expect(normalizeInternal('/registration/refund-policy')).toBe('/registration/refund-policy/');
    expect(normalizeInternal('https://www.wssl.org/fields/overview/')).toBe('/fields/overview/');
    expect(normalizeInternal('/about/contact/#form')).toBe('/about/contact/#form');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings, paragraphs, lists and bold', () => {
    const { markdown } = htmlToMarkdown('<h2>Fees</h2><p>Core is <strong>$250</strong>.</p><ul><li>One</li><li>Two</li></ul>');
    expect(markdown).toBe('## Fees\n\nCore is **$250**.\n\n- One\n- Two');
  });
  it('flattens bootstrap alert divs to paragraphs and removes nbsp', () => {
    const { markdown } = htmlToMarkdown('<p class="alert alert-danger"><span style="color:#e74c3c">There are NO REFUNDS&nbsp;for travel.</span></p>');
    expect(markdown).toBe('There are NO REFUNDS for travel.');
  });
  it('keeps tables as GFM tables', () => {
    const { markdown } = htmlToMarkdown('<table><thead><tr><th>Div</th><th>Day</th></tr></thead><tbody><tr><td>U8</td><td>Sat</td></tr></tbody></table>');
    expect(markdown).toContain('| Div | Day |');
    expect(markdown).toContain('| U8 | Sat |');
  });
  it('rewrites legacy PDF links and collects assets', () => {
    const { markdown, assets } = htmlToMarkdown('<a href="/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf">Card</a>');
    expect(markdown).toBe('[Card](/assets/legacy/File/Referee_Trifold_Card_2022.pdf)');
    expect(assets).toEqual(['/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf']);
  });
  it('rewrites legacy images', () => {
    const { markdown, assets } = htmlToMarkdown('<img src="https://www.wssl.org/sites/wssl/assets/Image/WSSL/girls-on-kantor.jpg" alt="Girls">');
    expect(markdown).toBe('![Girls](/assets/legacy/Image/WSSL/girls-on-kantor.jpg)');
    expect(assets).toEqual(['/sites/wssl/assets/Image/WSSL/girls-on-kantor.jpg']);
  });
  it('normalizes internal page links and leaves external ones alone', () => {
    const { markdown } = htmlToMarkdown('<a href="https://www.wssl.org/registration/refund-policy">Refunds</a> <a href="https://inleague.wssl.org/">inLeague</a>');
    expect(markdown).toBe('[Refunds](/registration/refund-policy/) [inLeague](https://inleague.wssl.org/)');
  });
  it('drops scripts/styles and keeps iframes as raw HTML', () => {
    const { markdown } = htmlToMarkdown('<script>x()</script><style>p{}</style><iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(markdown).toBe('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
  });
  it('collapses 3+ blank lines', () => {
    const { markdown } = htmlToMarkdown('<p>a</p><div></div><div></div><p>b</p>');
    expect(markdown).toBe('a\n\nb');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/convert.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/convert`.

- [ ] **Step 3: Implement the converter**

`scripts/lib/convert.ts`:
```ts
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export interface ConvertResult {
  markdown: string;
  /** Legacy asset paths (host stripped) to download, e.g. /sites/wssl/assets/File/X.pdf */
  assets: string[];
}

const WSSL_HOSTS = ['https://www.wssl.org', 'https://wssl.org', 'https://cms.wssl.org', 'http://www.wssl.org', 'http://wssl.org'];
const LEGACY_ASSET_PREFIX = '/sites/wssl/assets/';

export function stripHost(href: string): string {
  for (const host of WSSL_HOSTS) {
    if (href.startsWith(host)) return href.slice(host.length) || '/';
  }
  return href;
}

export function isLegacyAsset(href: string): boolean {
  return stripHost(href).startsWith(LEGACY_ASSET_PREFIX);
}

export function localAssetPath(href: string): string {
  const rel = decodeURIComponent(stripHost(href)).slice(LEGACY_ASSET_PREFIX.length);
  const safe = rel
    .split('/')
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]+/g, '-'))
    .join('/');
  return `/assets/legacy/${safe}`;
}

/** Internal page link = same-site path that is not an asset and not a Mura system path. */
export function isInternalPage(href: string): boolean {
  const p = stripHost(href);
  return p.startsWith('/') && !p.startsWith(LEGACY_ASSET_PREFIX) && !p.startsWith('/index.cfm') && !p.startsWith('/core/');
}

export function normalizeInternal(href: string): string {
  const p = stripHost(href);
  const m = p.match(/^([^?#]*)(.*)$/)!;
  let path = m[1];
  const suffix = m[2];
  if (!path.endsWith('/')) path += '/';
  return path + suffix;
}

export function htmlToMarkdown(html: string): ConvertResult {
  const assets = new Set<string>();
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript']);
  td.keep(['iframe']);

  td.addRule('legacyImage', {
    filter: (node) => node.nodeName === 'IMG' && isLegacyAsset(node.getAttribute('src') ?? ''),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute('src') ?? '';
      assets.add(stripHost(src));
      return `![${el.getAttribute('alt') ?? ''}](${localAssetPath(src)})`;
    },
  });

  td.addRule('legacyLink', {
    filter: (node) => node.nodeName === 'A' && isLegacyAsset(node.getAttribute('href') ?? ''),
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      assets.add(stripHost(href));
      return `[${content}](${localAssetPath(href)})`;
    },
  });

  td.addRule('internalLink', {
    filter: (node) => node.nodeName === 'A' && isInternalPage(node.getAttribute('href') ?? ''),
    replacement: (content, node) => `[${content}](${normalizeInternal((node as HTMLElement).getAttribute('href') ?? '')})`,
  });

  let markdown = td.turndown(html);
  markdown = markdown
    .replace(/ /g, ' ')
    .replace(/^(\s*)-   /gm, '$1- ')       // turndown pads bullets to 4 chars; use "- "
    .replace(/^(\s*\d+\.)  /gm, '$1 ')     // same for ordered lists
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, assets: [...assets] };
}
```

If `@types/turndown` complains about `node.getAttribute`, cast `node as HTMLElement` as shown; do not loosen the rules.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/convert.test.ts`
Expected: PASS (11 tests). If the iframe test fails because turndown wraps kept HTML with blank lines, the `.trim()` handles it; if the alert test produces `**` wrappers, no bold rule is involved — check that `<span style>` is passed through as plain text.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/convert.ts tests/convert.test.ts
git commit -m "feat: HTML to Markdown converter with legacy asset and link rewriting"
```

---

### Task 4: Mura extraction + migration runner (pages, assets, nav)

**Files:**
- Create: `scripts/lib/mura.ts`, `scripts/migrate.ts`
- Test: `tests/mura.test.ts`
- Generates (committed): `src/content/pages/**`, `public/assets/legacy/**`, `public/images/*`, `src/data/nav.json`, `src/data/home-legacy.md`

**Interfaces:**
- Consumes: `htmlToMarkdown`, `localAssetPath` from Task 3.
- Produces: `MuraItem` type; `fetchAllContent(fetchImpl?): Promise<MuraItem[]>`; `targetFor(filename): { file, section, path } | null`; `frontmatter(item, path): string`; `buildNav(items): NavItem[]` with `NavItem = { label: string; href: string; children: NavItem[] }`; `src/data/nav.json` shape `{ items: NavItem[] }`.

- [ ] **Step 1: Write the failing tests**

`tests/mura.test.ts`:
```ts
import { fetchAllContent, targetFor, frontmatter, buildNav, isoDate, type MuraItem } from '../scripts/lib/mura';

const item = (over: Partial<MuraItem>): MuraItem => ({
  contentid: 'X', filename: 'about/history', title: 'History', menutitle: 'History', type: 'Page',
  parentid: '00000000000000000000000000000000001', displayorder: 1, isnav: 1, lastupdate: '2024-11-10 09:00:00',
  body: '<p>hi</p>', summary: '', ...over,
});

describe('targetFor', () => {
  it('maps section root pages to index.md', () => {
    expect(targetFor('programs')).toEqual({ file: 'programs/index.md', section: 'programs', path: '' });
  });
  it('flattens nested paths into one file per section', () => {
    expect(targetFor('volunteers/coaches/certification')).toEqual({ file: 'volunteers/coaches-certification.md', section: 'volunteers', path: 'coaches/certification' });
    expect(targetFor('schedules/game-schedules/core-games/')).toEqual({ file: 'schedules/game-schedules-core-games.md', section: 'schedules', path: 'game-schedules/core-games' });
  });
  it('returns null for home, blog and unknown sections', () => {
    expect(targetFor('')).toBeNull();
    expect(targetFor('blog')).toBeNull();
    expect(targetFor('index')).toBeNull();
  });
});

describe('frontmatter', () => {
  it('emits the page schema fields as YAML', () => {
    const fm = frontmatter(item({ title: 'Refund "Policy"', summary: '<p>Fees &amp; refunds</p>' }), 'refund-policy');
    expect(fm).toBe('---\ntitle: Refund "Policy"\npath: refund-policy\ndescription: Fees & refunds\nlegacyUrl: /about/history/\nupdated: 2024-11-10\n---\n');
  });
  it('omits description when summary is empty', () => {
    expect(frontmatter(item({}), 'history')).not.toContain('description');
  });
  it('isoDate handles Mura and free-form dates', () => {
    expect(isoDate('2024-11-10 09:00:00')).toBe('2024-11-10');
    expect(isoDate('November 10, 2024 09:00:00 GMT')).toBe('2024-11-10');
    expect(isoDate('garbage')).toBeUndefined();
    expect(isoDate(undefined)).toBeUndefined();
  });
});

describe('fetchAllContent', () => {
  it('walks every page of the API', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('pageIndex'));
      return { ok: true, json: async () => ({ data: { totalpages: 2, items: [item({ contentid: `P${page}` })] } }) };
    }) as unknown as typeof fetch;
    const items = await fetchAllContent(fake);
    expect(items.map((i) => i.contentid)).toEqual(['P1', 'P2']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('maxitems=100');
  });
  it('throws on HTTP errors', async () => {
    const fake = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(fetchAllContent(fake)).rejects.toThrow('Mura API 500');
  });
});

describe('buildNav', () => {
  it('builds an ordered tree from parentid/displayorder, skipping non-nav items', () => {
    const HOME = '00000000000000000000000000000000001';
    const items = [
      item({ contentid: 'A', filename: 'programs', menutitle: 'Programs', parentid: HOME, displayorder: 2 }),
      item({ contentid: 'B', filename: 'about', menutitle: 'About', parentid: HOME, displayorder: 1 }),
      item({ contentid: 'C', filename: 'programs/core', menutitle: 'Core', parentid: 'A', displayorder: 1 }),
      item({ contentid: 'D', filename: 'programs/hidden', menutitle: 'Hidden', parentid: 'A', displayorder: 2, isnav: 0 }),
      item({ contentid: 'E', filename: 'tryout-form', title: 'Tryout form', menutitle: 'Tryout form', type: 'Link', parentid: 'A', displayorder: 3, url: 'https://forms.gle/x' }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'About', href: '/about/', children: [] },
      { label: 'Programs', href: '/programs/', children: [
        { label: 'Core', href: '/programs/core/', children: [] },
        { label: 'Tryout form', href: 'https://forms.gle/x', children: [] },
      ] },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/mura.test.ts`
Expected: FAIL — cannot find module `../scripts/lib/mura`.

- [ ] **Step 3: Implement `scripts/lib/mura.ts`**

```ts
import { stringify } from 'yaml';

export interface MuraItem {
  contentid: string;
  filename: string;
  title: string;
  menutitle: string;
  type: string; // 'Page' | 'Link' | ...
  parentid: string;
  displayorder: number;
  isnav: number;
  lastupdate: string; // 'YYYY-MM-DD HH:mm:ss'
  body?: string;
  summary?: string;
  url?: string; // Link items
}

export interface NavItem { label: string; href: string; children: NavItem[] }

export const MURA_API = 'https://www.wssl.org/index.cfm/_api/json/v1/wssl/content/';
const FIELDS = 'contentid,filename,title,menutitle,type,body,summary,parentid,displayorder,isnav,lastupdate,url';
export const HOME_ID = '00000000000000000000000000000000001';
export const SECTIONS = ['programs', 'registration', 'schedules', 'fields', 'volunteers', 'about'] as const;

export async function fetchAllContent(fetchImpl: typeof fetch = fetch): Promise<MuraItem[]> {
  const items: MuraItem[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetchImpl(`${MURA_API}?fields=${FIELDS}&maxitems=100&pageIndex=${page}`);
    if (!res.ok) throw new Error(`Mura API ${res.status}`);
    const json = (await res.json()) as { data: { totalpages: number; items: MuraItem[] } };
    totalPages = json.data.totalpages;
    items.push(...json.data.items);
    page++;
  } while (page <= totalPages);
  return items;
}

export function targetFor(filename: string): { file: string; section: string; path: string } | null {
  const parts = filename.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const section = parts[0];
  if (!(SECTIONS as readonly string[]).includes(section)) return null;
  const rest = parts.slice(1);
  return {
    file: rest.length === 0 ? `${section}/index.md` : `${section}/${rest.join('-')}.md`,
    section,
    path: rest.join('/'),
  };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 'YYYY-MM-DD' from Mura's lastupdate ('2024-11-10 09:00:00' or any Date-parsable string). */
export function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function frontmatter(item: MuraItem, path: string): string {
  const data: Record<string, unknown> = { title: item.title, path };
  const description = stripTags(item.summary ?? '');
  if (description) data.description = description;
  data.legacyUrl = `/${item.filename.replace(/\/+$/, '')}/`;
  const updated = isoDate(item.lastupdate);
  if (updated) data.updated = updated;
  return `---\n${stringify(data)}---\n`;
}

function hrefFor(item: MuraItem): string | null {
  if (item.type === 'Link') return item.url ?? null;
  if (item.type !== 'Page') return null;
  return `/${item.filename.replace(/\/+$/, '')}/`;
}

export function buildNav(items: MuraItem[]): NavItem[] {
  const byParent = new Map<string, MuraItem[]>();
  for (const it of items) {
    if (!Number(it.isnav)) continue;   // Mura may return 0/1 as numbers or strings
    const list = byParent.get(it.parentid) ?? [];
    list.push(it);
    byParent.set(it.parentid, list);
  }
  const build = (parentid: string, depth: number): NavItem[] =>
    (byParent.get(parentid) ?? [])
      .sort((a, b) => Number(a.displayorder) - Number(b.displayorder))
      .flatMap((it) => {
        const href = hrefFor(it);
        if (!href) return [];
        return [{ label: it.menutitle || it.title, href, children: depth < 3 ? build(it.contentid, depth + 1) : [] }];
      });
  return build(HOME_ID, 1);
}
```

Note: `yaml`'s `stringify` writes `updated: 2024-11-10` unquoted and `legacyUrl: /about/history/` unquoted, matching the test. `title: Refund "Policy"` stays unquoted because it does not start with a quote.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mura.test.ts`
Expected: PASS (9 tests). If `frontmatter` output differs only in quoting, adjust the test expectation to the exact `yaml` output after confirming it still parses with gray-matter — do not change key order.

- [ ] **Step 5: Write the migration runner**

`scripts/migrate.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fetchAllContent, targetFor, frontmatter, buildNav, type MuraItem } from './lib/mura';
import { htmlToMarkdown, localAssetPath } from './lib/convert';

const THEME_IMAGES: Record<string, string> = {
  'https://www.wssl.org/sites/wssl/themes/wssl-theme/images/wssl-header-lg.png': 'public/images/wssl-header-lg.png',
  'https://www.wssl.org/sites/wssl/themes/wssl-theme/images/mobile-logo.png': 'public/images/mobile-logo.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-1.png': 'public/images/carousel-1.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-2.png': 'public/images/carousel-2.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-3.png': 'public/images/carousel-3.png',
  'https://www.wssl.org/sites/wssl/assets/Carousel/carousel-4.png': 'public/images/carousel-4.png',
};

async function download(url: string, dest: string): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) return false;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function downloadLegacyAsset(assetPath: string): Promise<'ok' | 'missing'> {
  const dest = join('public', localAssetPath(assetPath));
  for (const host of ['https://www.wssl.org', 'https://cms.wssl.org']) {
    if (await download(host + assetPath, dest)) return 'ok';
  }
  return 'missing';
}

async function main() {
  const items = await fetchAllContent();
  const report = { written: [] as string[], skipped: [] as string[], assetsOk: [] as string[], assetsMissing: [] as string[] };
  const allAssets = new Set<string>();

  for (const item of items) {
    if (item.filename === '' || item.filename === 'index') {
      const { markdown } = htmlToMarkdown(item.body ?? '');
      await mkdir('src/data', { recursive: true });
      await writeFile('src/data/home-legacy.md', markdown + '\n');
      report.written.push('src/data/home-legacy.md');
      continue;
    }
    const target = targetFor(item.filename);
    if (!target || item.type !== 'Page') {
      report.skipped.push(`${item.type}:${item.filename}`);
      continue;
    }
    const { markdown, assets } = htmlToMarkdown(item.body ?? '');
    assets.forEach((a) => allAssets.add(a));
    const out = join('src/content/pages', target.file);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, frontmatter(item as MuraItem, target.path) + '\n' + markdown + '\n');
    report.written.push(out);
  }

  for (const asset of allAssets) {
    (await downloadLegacyAsset(asset)) === 'ok' ? report.assetsOk.push(asset) : report.assetsMissing.push(asset);
  }
  for (const [url, dest] of Object.entries(THEME_IMAGES)) {
    (await download(url, dest)) ? report.assetsOk.push(url) : report.assetsMissing.push(url);
  }

  await mkdir('src/data', { recursive: true });
  await writeFile('src/data/nav.json', JSON.stringify({ items: buildNav(items) }, null, 2) + '\n');
  await writeFile('scripts/migration-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`written=${report.written.length} skipped=${report.skipped.length} assetsOk=${report.assetsOk.length} assetsMissing=${report.assetsMissing.length}`);
  console.log('skipped:', report.skipped.join(', '));
  console.log('missing assets:', report.assetsMissing.join(', '));
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 6: Run the migration**

```bash
rm -f src/content/pages/about/history.md   # drop the Task 2 fixture; the real page replaces it
npm run migrate
```
Expected output: `written` between 85 and 92, `skipped` listing only `Link:tryout-inquiry-form2`, `Page:blog` and similar non-section items, `assetsMissing` small (external hosts that block downloads are acceptable — leave those links pointing at the original URL by editing the Markdown by hand).

- [ ] **Step 7: Verify the build and spot-check content**

```bash
npx astro build
ls dist/registration/refund-policy/index.html dist/volunteers/referees/referee-faq/index.html dist/programs/core/divisions/spring-2026/index.html
grep -c "registrar@wssl.org" dist/registration/refund-policy/index.html
ls public/assets/legacy/File | head
cat src/data/nav.json | head -40
```
Expected: all three files exist; grep prints `1` or more; PDFs listed; `nav.json` starts with the top-level sections in the same order as the live site (Programs, Registration, Schedules, Fields, Volunteers, About).

If `astro build` fails on a page, the frontmatter of that page violates the schema (most likely a `path` with uppercase or spaces). Fix `targetFor` or the file, re-run, and keep going.

- [ ] **Step 8: Commit content and assets**

```bash
git add -A
git commit -m "feat: migrate all Mura pages, assets and navigation from wssl.org"
```

---

### Task 5: Base layout, header navigation, alert banner, footer, site settings

**Files:**
- Create: `src/data/site.json`, `src/data/alerts.json`, `src/layouts/BaseLayout.astro`, `src/components/Header.astro`, `src/components/AlertBanner.astro`, `src/components/Footer.astro`
- Modify: `src/layouts/PageLayout.astro` (use BaseLayout)
- Test: `tests/nav.test.ts`

**Interfaces:**
- Consumes: `src/data/nav.json` from Task 4; `urlFor` from Task 2.
- Produces: `BaseLayout` props `{ title: string; description?: string }`; `site.json` shape `{ name, shortName, tagline, email, registrationUrl, facebook, instagram }`; `alerts.json` shape `{ active: boolean; level: 'info'|'warning'|'danger'; message: string; href?: string }`.

- [ ] **Step 1: Write the failing test (nav integrity)**

`tests/nav.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { urlFor } from '../src/lib/pages';

function contentUrls(): Set<string> {
  const urls = new Set<string>(['/']);
  for (const f of fg.sync('src/content/pages/**/*.md')) {
    const { data } = matter(readFileSync(f, 'utf8'));
    const id = f.replace(/^src\/content\/pages\//, '').replace(/\.md$/, '');
    if (!data.draft) urls.add(urlFor(id, data.path));
  }
  return urls;
}

function flatten(items: any[]): any[] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

describe('site data', () => {
  it('every internal nav link points at a real page', () => {
    const nav = JSON.parse(readFileSync('src/data/nav.json', 'utf8'));
    const urls = contentUrls();
    const missing = flatten(nav.items).map((i) => i.href).filter((h) => h.startsWith('/') && !urls.has(h));
    expect(missing).toEqual([]);
  });
  it('site.json and alerts.json have the expected shape', () => {
    const site = JSON.parse(readFileSync('src/data/site.json', 'utf8'));
    for (const k of ['name', 'shortName', 'tagline', 'email', 'registrationUrl', 'facebook', 'instagram']) expect(site[k], k).toBeTruthy();
    const alerts = JSON.parse(readFileSync('src/data/alerts.json', 'utf8'));
    expect(typeof alerts.active).toBe('boolean');
    expect(['info', 'warning', 'danger']).toContain(alerts.level);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/nav.test.ts`
Expected: FAIL — `src/data/site.json` does not exist (the nav test may already pass; if it reports missing hrefs, those are nav entries whose page was skipped — remove them from `nav.json` or fix the page).

- [ ] **Step 3: Create site data files**

`src/data/site.json`:
```json
{
  "name": "West Side Soccer League",
  "shortName": "WSSL",
  "tagline": "AYSO Region 473 — volunteer-run youth soccer on Manhattan's West Side",
  "email": "registrar@wssl.org",
  "registrationUrl": "https://inleague.wssl.org",
  "facebook": "https://www.facebook.com/wsslnyc/",
  "instagram": "https://www.instagram.com/wsslnyc/"
}
```

`src/data/alerts.json`:
```json
{
  "active": false,
  "level": "warning",
  "message": "Fields are closed today due to rain. Check the schedule page for updates.",
  "href": "/schedules/"
}
```

- [ ] **Step 4: Write layout and components**

`src/components/AlertBanner.astro`:
```astro
---
import alerts from '../data/alerts.json';
const colors: Record<string, string> = {
  info: 'bg-blue-100 text-blue-900',
  warning: 'bg-gold text-navy',
  danger: 'bg-red-600 text-white',
};
---
{alerts.active && (
  <div class={`text-center px-4 py-2 font-semibold ${colors[alerts.level] ?? colors.info}`} role="status">
    {alerts.href ? <a href={alerts.href} class="underline">{alerts.message}</a> : alerts.message}
  </div>
)}
```

`src/components/Header.astro`:
```astro
---
import nav from '../data/nav.json';
import site from '../data/site.json';
---
<header class="bg-navy text-white">
  <div class="mx-auto max-w-6xl px-4">
    <div class="flex items-center justify-between h-16">
      <a href="/" class="flex items-center gap-3">
        <img src="/images/mobile-logo.png" alt={site.shortName} class="h-10 w-auto" />
        <span class="font-bold text-lg hidden sm:inline">{site.name}</span>
      </a>
      <a href={site.registrationUrl} class="hidden lg:inline-block bg-gold text-navy font-bold px-4 py-2 rounded">Register</a>
      <button id="nav-toggle" class="lg:hidden px-3 py-2 border border-white/40 rounded" aria-expanded="false" aria-controls="site-nav">Menu</button>
    </div>
    <nav id="site-nav" class="hidden lg:block pb-2 lg:pb-0">
      <ul class="flex flex-col lg:flex-row lg:gap-6">
        {nav.items.map((item) => (
          <li class="relative group">
            <a href={item.href} class="block py-2 font-semibold hover:text-gold">{item.label}</a>
            {(item.children ?? []).length > 0 && (
              <ul class="pl-4 lg:pl-0 lg:absolute lg:left-0 lg:top-full lg:hidden lg:group-hover:block lg:bg-navy lg:min-w-64 lg:shadow-lg lg:z-20">
                {(item.children ?? []).map((child) => (
                  <li>
                    <a href={child.href} class="block px-4 py-2 hover:bg-white/10">{child.label}</a>
                    {(child.children ?? []).length > 0 && (
                      <ul class="pl-4">
                        {(child.children ?? []).map((g) => (
                          <li><a href={g.href} class="block px-4 py-1 text-sm hover:bg-white/10">{g.label}</a></li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        <li class="lg:hidden"><a href={site.registrationUrl} class="block py-2 font-bold text-gold">Register</a></li>
      </ul>
    </nav>
  </div>
</header>
<script>
  const btn = document.getElementById('nav-toggle');
  const nav = document.getElementById('site-nav');
  btn?.addEventListener('click', () => {
    const open = !nav!.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(open));
  });
</script>
```

`src/components/Footer.astro`:
```astro
---
import site from '../data/site.json';
const year = new Date().getFullYear();
---
<footer class="bg-navy text-white mt-16">
  <div class="mx-auto max-w-6xl px-4 py-8 grid gap-6 md:grid-cols-3 text-sm">
    <div>
      <p class="font-bold text-base">{site.name}</p>
      <p class="text-white/80">{site.tagline}</p>
    </div>
    <div>
      <p class="font-bold">Quick links</p>
      <ul class="space-y-1">
        <li><a href={site.registrationUrl} class="hover:text-gold">Register / inLeague</a></li>
        <li><a href="/schedules/" class="hover:text-gold">Schedules</a></li>
        <li><a href="/fields/" class="hover:text-gold">Fields</a></li>
        <li><a href="/about/contact/" class="hover:text-gold">Contact</a></li>
      </ul>
    </div>
    <div>
      <p class="font-bold">Follow</p>
      <ul class="space-y-1">
        <li><a href={site.facebook} class="hover:text-gold" rel="noopener">Facebook</a></li>
        <li><a href={site.instagram} class="hover:text-gold" rel="noopener">Instagram</a></li>
        <li><a href={`mailto:${site.email}`} class="hover:text-gold">{site.email}</a></li>
      </ul>
    </div>
  </div>
  <div class="text-center text-white/60 text-xs pb-4">© {year} {site.name}</div>
</footer>
```

`src/layouts/BaseLayout.astro`:
```astro
---
import '../styles/global.css';
import Header from '../components/Header.astro';
import AlertBanner from '../components/AlertBanner.astro';
import Footer from '../components/Footer.astro';
import site from '../data/site.json';
interface Props { title: string; description?: string }
const { title, description } = Astro.props;
const fullTitle = title === site.name ? title : `${title} - ${site.name}`;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{fullTitle}</title>
    {description && <meta name="description" content={description} />}
    <link rel="icon" href="/images/mobile-logo.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=PT+Sans:wght@400;700&display=swap" />
    <link rel="sitemap" href="/sitemap-index.xml" />
  </head>
  <body class="font-sans text-gray-900 bg-white min-h-screen flex flex-col">
    <AlertBanner />
    <Header />
    <main class="flex-1"><slot /></main>
    <Footer />
  </body>
</html>
```

Replace `src/layouts/PageLayout.astro` with:
```astro
---
import BaseLayout from './BaseLayout.astro';
interface Props { title: string; description?: string }
const { title, description } = Astro.props;
---
<BaseLayout title={title} description={description}>
  <article class="mx-auto max-w-4xl px-4 py-8">
    <h1 class="text-3xl font-bold text-navy mb-6">{title}</h1>
    <div class="prose prose-lg max-w-none prose-a:text-navy prose-headings:text-navy"><slot /></div>
  </article>
</BaseLayout>
```

- [ ] **Step 5: Run tests and build, then look at it**

Run: `npm test`
Expected: all passing.

Run: `npx astro build && npx astro preview` then open http://localhost:4321/registration/refund-policy/ — header nav dropdowns work on hover (desktop) and the Menu button toggles on a narrow window; footer renders; set `"active": true` in `alerts.json`, rebuild, and confirm the gold banner shows. Set it back to `false`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: base layout with navigation, alert banner, footer and site settings"
```

---

### Task 6: Home page, 404, redirects, robots, sitemap

**Files:**
- Modify: `src/pages/index.astro`
- Create: `src/pages/404.astro`, `public/_redirects`, `public/robots.txt`
- Test: build assertions (shell)

**Interfaces:**
- Consumes: `BaseLayout`, `site.json`, `src/data/home-legacy.md` (reference text only).

- [ ] **Step 1: Write the home page**

Read `src/data/home-legacy.md` for the current welcome copy, then write `src/pages/index.astro`:
```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import site from '../data/site.json';
const cards = [
  { title: 'Register', text: 'Sign up for Core, Playground, EPIC, Development Academy and travel tryouts on inLeague.', href: site.registrationUrl },
  { title: 'Schedules', text: 'Game and training schedules for every program.', href: '/schedules/' },
  { title: 'Fields', text: 'Where we play, directions and rainout policy.', href: '/fields/overview/' },
  { title: 'Volunteer', text: 'Coach, referee or help run the league.', href: '/volunteers/' },
];
---
<BaseLayout title={site.name} description={site.tagline}>
  <section class="relative bg-navy text-white">
    <img src="/images/carousel-1.png" alt="" class="absolute inset-0 h-full w-full object-cover opacity-40" />
    <div class="relative mx-auto max-w-6xl px-4 py-24 text-center">
      <img src="/images/wssl-header-lg.png" alt={site.name} class="mx-auto max-h-32 w-auto mb-6" />
      <p class="text-xl md:text-2xl font-semibold">{site.tagline}</p>
      <a href={site.registrationUrl} class="inline-block mt-8 bg-gold text-navy font-bold px-6 py-3 rounded text-lg">Register on inLeague</a>
    </div>
  </section>
  <section class="mx-auto max-w-6xl px-4 py-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
    {cards.map((c) => (
      <a href={c.href} class="block border border-gray-200 rounded-lg p-6 hover:shadow-lg hover:border-navy">
        <h2 class="text-xl font-bold text-navy mb-2">{c.title}</h2>
        <p class="text-gray-700">{c.text}</p>
      </a>
    ))}
  </section>
  <section class="mx-auto max-w-4xl px-4 pb-16 text-center">
    <h2 class="text-2xl font-bold text-navy mb-3">Have a question?</h2>
    <p class="text-gray-700">Use the <strong>Ask WSSL</strong> button in the corner — it answers from this website and links you to the right page.</p>
  </section>
</BaseLayout>
```

If `home-legacy.md` contains announcements worth keeping, paste them as a third section between the cards and the question block.

- [ ] **Step 2: Write 404, redirects and robots**

`src/pages/404.astro`:
```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Page not found">
  <div class="mx-auto max-w-2xl px-4 py-24 text-center">
    <h1 class="text-3xl font-bold text-navy mb-4">Page not found</h1>
    <p class="mb-6">The page may have moved when we rebuilt the site.</p>
    <a href="/" class="text-navy underline">Go to the home page</a>
  </div>
</BaseLayout>
```

`public/_redirects`:
```
/sites/wssl/assets/*  /assets/legacy/:splat  301
/index.cfm/*          /                      301
/blog                 /                      301
/blog/*               /                      301
/fields/overview      /fields/overview/      301
```

`public/robots.txt`:
```
User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Sitemap: https://www.wssl.org/sitemap-index.xml
```

- [ ] **Step 3: Build and verify**

```bash
npx astro build
test -f dist/index.html && test -f dist/404.html && test -f dist/sitemap-index.xml && test -f dist/_redirects && test -f dist/robots.txt && echo ok
grep -c "wssl.org/registration/refund-policy/" dist/sitemap-0.xml
```
Expected: `ok`, then `1`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: home page, 404, legacy redirects, robots and sitemap"
```

---

### Task 7: Decap CMS admin, config, and GitHub OAuth functions

**Files:**
- Create: `public/admin/index.html`, `public/admin/config.yml`, `functions/tsconfig.json`, `functions/_lib/oauth.ts`, `functions/api/auth.ts`, `functions/api/callback.ts`, `docs/editors.md`
- Test: `tests/cms-config.test.ts`, `tests/oauth.test.ts`

**Interfaces:**
- Consumes: `PAGE_FIELD_NAMES` from Task 2; section folders from Task 4.
- Produces: `callbackHtml(provider: string, payload: { token: string; provider: string }): string`; Pages Functions `GET /api/auth` and `GET /api/callback`; env `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`.

- [ ] **Step 1: Write the failing tests**

`tests/cms-config.test.ts`:
```ts
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { PAGE_FIELD_NAMES } from '../src/lib/page-schema';

const config = parse(readFileSync('public/admin/config.yml', 'utf8'));

describe('Decap config', () => {
  it('uses the github backend with the Pages OAuth endpoint', () => {
    expect(config.backend.name).toBe('github');
    expect(config.backend.branch).toBe('main');
    expect(config.backend.auth_endpoint).toBe('api/auth');
    expect(config.backend.base_url).toMatch(/^https:\/\//);
  });
  it('has one folder collection per content section pointing at an existing folder', () => {
    const folders = config.collections.filter((c: any) => c.folder);
    expect(folders.map((c: any) => c.name).sort()).toEqual(['about', 'fields', 'programs', 'registration', 'schedules', 'volunteers']);
    for (const c of folders) expect(existsSync(c.folder), c.folder).toBe(true);
  });
  it('page fields match the Astro schema exactly', () => {
    for (const c of config.collections.filter((c: any) => c.folder)) {
      expect(c.fields.map((f: any) => f.name)).toEqual([...PAGE_FIELD_NAMES]);
    }
  });
  it('site settings edit the JSON data files', () => {
    const settings = config.collections.find((c: any) => c.name === 'settings');
    expect(settings.files.map((f: any) => f.file).sort()).toEqual(['src/data/alerts.json', 'src/data/nav.json', 'src/data/site.json']);
  });
});
```

`tests/oauth.test.ts`:
```ts
import { onRequestGet as auth } from '../functions/api/auth';
import { onRequestGet as callback } from '../functions/api/callback';
import { callbackHtml } from '../functions/_lib/oauth';

const env = { GITHUB_OAUTH_CLIENT_ID: 'cid', GITHUB_OAUTH_CLIENT_SECRET: 'sec' };
const ctx = (request: Request) => ({ request, env, params: {}, data: {}, waitUntil() {}, passThroughOnException() {}, next: async () => new Response() }) as any;

describe('GET /api/auth', () => {
  it('redirects to GitHub with client id, callback and a state cookie', async () => {
    const res = await auth(ctx(new Request('https://www.wssl.org/api/auth?provider=github')));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location')!);
    expect(loc.origin + loc.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://www.wssl.org/api/callback');
    expect(loc.searchParams.get('scope')).toBe('repo,user');
    const state = loc.searchParams.get('state')!;
    expect(res.headers.get('Set-Cookie')).toContain(`decap_oauth_state=${state}`);
  });
});

describe('GET /api/callback', () => {
  it('rejects a state mismatch', async () => {
    const req = new Request('https://www.wssl.org/api/callback?code=abc&state=one', { headers: { Cookie: 'decap_oauth_state=two' } });
    const res = await callback(ctx(req));
    expect(res.status).toBe(400);
  });
  it('exchanges the code and returns the Decap handshake page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'gho_123' }), { headers: { 'Content-Type': 'application/json' } })));
    const req = new Request('https://www.wssl.org/api/callback?code=abc&state=one', { headers: { Cookie: 'decap_oauth_state=one' } });
    const res = await callback(ctx(req));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('authorization:github:success:{\\"token\\":\\"gho_123\\",\\"provider\\":\\"github\\"}');
    expect(html).toContain("postMessage('authorizing:github', '*')");
    vi.unstubAllGlobals();
  });
});

describe('callbackHtml', () => {
  it('embeds the message as a JSON string literal', () => {
    expect(callbackHtml('github', { token: 't', provider: 'github' })).toContain('"authorization:github:success:{\\"token\\":\\"t\\",\\"provider\\":\\"github\\"}"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cms-config.test.ts tests/oauth.test.ts`
Expected: FAIL — config file and function modules missing.

- [ ] **Step 3: Write the Decap shell and config**

`public/admin/index.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>WSSL Site Editor</title>
</head>
<body>
  <script src="https://unpkg.com/decap-cms@^3.0.0/dist/decap-cms.js"></script>
</body>
</html>
```

`public/admin/config.yml` (replace `OWNER/REPO` with the GitHub repo created in Task 12 — until then it can stay as-is because local editing uses `local_backend`):
```yaml
backend:
  name: github
  repo: OWNER/REPO
  branch: main
  base_url: https://www.wssl.org
  auth_endpoint: api/auth
  commit_messages:
    create: 'content: create {{collection}} "{{slug}}"'
    update: 'content: update {{collection}} "{{slug}}"'
    delete: 'content: delete {{collection}} "{{slug}}"'
    uploadMedia: 'content: upload {{path}}'
    deleteMedia: 'content: delete {{path}}'

local_backend: true
site_url: https://www.wssl.org
display_url: https://www.wssl.org
logo_url: /images/mobile-logo.png
media_folder: public/uploads
public_folder: /uploads
editor:
  preview: false
slug:
  encoding: ascii
  clean_accents: true
  sanitize_replacement: '-'

collections:
  - name: programs
    label: Programs
    folder: src/content/pages/programs
    create: true
    slug: '{{slug}}'
    summary: '{{title}} — /programs/{{path}}/'
    fields: &page_fields
      - { label: Title, name: title, widget: string }
      - label: URL path
        name: path
        widget: string
        hint: 'Under this section, lowercase with dashes, e.g. core/waitlists → /programs/core/waitlists/. Leave empty only for the section home page.'
        pattern: ['^$|^[a-z0-9-]+(/[a-z0-9-]+)*$', 'Lowercase letters, numbers, dashes and slashes only']
      - { label: Description (for search engines), name: description, widget: string, required: false }
      - { label: Draft (hide from the site), name: draft, widget: boolean, default: false, required: false }
      - { label: Last updated, name: updated, widget: datetime, format: 'YYYY-MM-DD', date_format: 'YYYY-MM-DD', time_format: false, required: false }
      - { label: Old site URL (reference only), name: legacyUrl, widget: string, required: false }
      - { label: Body, name: body, widget: markdown }
  - name: registration
    label: Registration
    folder: src/content/pages/registration
    create: true
    slug: '{{slug}}'
    summary: '{{title}} — /registration/{{path}}/'
    fields: *page_fields
  - name: schedules
    label: Schedules
    folder: src/content/pages/schedules
    create: true
    slug: '{{slug}}'
    summary: '{{title}} — /schedules/{{path}}/'
    fields: *page_fields
  - name: fields
    label: Fields
    folder: src/content/pages/fields
    create: true
    slug: '{{slug}}'
    summary: '{{title}} — /fields/{{path}}/'
    fields: *page_fields
  - name: volunteers
    label: Volunteers (coaches, referees)
    folder: src/content/pages/volunteers
    create: true
    slug: '{{slug}}'
    summary: '{{title}} — /volunteers/{{path}}/'
    fields: *page_fields
  - name: about
    label: About
    folder: src/content/pages/about
    create: true
    slug: '{{slug}}'
    summary: '{{title}} — /about/{{path}}/'
    fields: *page_fields

  - name: settings
    label: Site Settings
    files:
      - name: alerts
        label: Alert banner (rainouts, closures)
        file: src/data/alerts.json
        fields:
          - { label: Show banner, name: active, widget: boolean, default: false }
          - { label: Color, name: level, widget: select, options: [info, warning, danger], default: warning }
          - { label: Message, name: message, widget: string }
          - { label: Link (optional), name: href, widget: string, required: false }
      - name: site
        label: Contact & links
        file: src/data/site.json
        fields:
          - { label: League name, name: name, widget: string }
          - { label: Short name, name: shortName, widget: string }
          - { label: Tagline, name: tagline, widget: string }
          - { label: Contact email, name: email, widget: string }
          - { label: Registration URL, name: registrationUrl, widget: string }
          - { label: Facebook URL, name: facebook, widget: string }
          - { label: Instagram URL, name: instagram, widget: string }
      - name: nav
        label: Navigation menu
        file: src/data/nav.json
        fields:
          - label: Menu items
            name: items
            widget: list
            fields:
              - { label: Label, name: label, widget: string }
              - { label: Link, name: href, widget: string }
              - label: Sub-items
                name: children
                widget: list
                required: false
                fields:
                  - { label: Label, name: label, widget: string }
                  - { label: Link, name: href, widget: string }
                  - label: Sub-sub-items
                    name: children
                    widget: list
                    required: false
                    fields:
                      - { label: Label, name: label, widget: string }
                      - { label: Link, name: href, widget: string }
```

- [ ] **Step 4: Write the OAuth functions**

`functions/tsconfig.json`:
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"], "lib": ["ES2022"], "module": "ESNext", "moduleResolution": "Bundler" },
  "include": ["./**/*.ts"]
}
```

`functions/_lib/oauth.ts`:
```ts
/** HTML page that completes Decap CMS's popup OAuth handshake. */
export function callbackHtml(provider: string, payload: { token: string; provider: string }): string {
  const message = `authorization:${provider}:success:${JSON.stringify(payload)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body><p>Signing you in…</p>
<script>
(function () {
  function receiveMessage(e) {
    window.opener.postMessage(${JSON.stringify(message)}, e.origin);
    window.removeEventListener('message', receiveMessage, false);
  }
  window.addEventListener('message', receiveMessage, false);
  window.opener.postMessage('authorizing:${provider}', '*');
})();
</script>
</body></html>`;
}
```

`functions/api/auth.ts`:
```ts
interface Env { GITHUB_OAUTH_CLIENT_ID: string; GITHUB_OAUTH_CLIENT_SECRET: string }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const origin = new URL(request.url).origin;
  const state = crypto.randomUUID();
  const target = new URL('https://github.com/login/oauth/authorize');
  target.searchParams.set('client_id', env.GITHUB_OAUTH_CLIENT_ID);
  target.searchParams.set('redirect_uri', `${origin}/api/callback`);
  target.searchParams.set('scope', 'repo,user');
  target.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      'Set-Cookie': `decap_oauth_state=${state}; Path=/api/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
};
```

`functions/api/callback.ts`:
```ts
import { callbackHtml } from '../_lib/oauth';

interface Env { GITHUB_OAUTH_CLIENT_ID: string; GITHUB_OAUTH_CLIENT_SECRET: string }

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = (request.headers.get('Cookie') ?? '').match(/decap_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || state !== cookieState) {
    return new Response('Invalid OAuth state. Close this window and try signing in again.', { status: 400 });
  }
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: env.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/callback`,
    }),
  });
  const data = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    return new Response(`GitHub sign-in failed: ${data.error ?? 'no token returned'}`, { status: 400 });
  }
  return new Response(callbackHtml('github', { token: data.access_token, provider: 'github' }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'decap_oauth_state=; Path=/api/callback; Max-Age=0',
    },
  });
};
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/cms-config.test.ts tests/oauth.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Try the CMS locally with the local backend**

```bash
npx decap-server &          # git proxy on :8081, writes straight to the working tree
npx astro dev               # :4321
```
Open http://localhost:4321/admin/index.html → the six sections and Site Settings appear → open Registration → Refund Policy → change one word → Publish → `git status` shows the file modified. Revert with `git checkout -- src/content/pages`. Stop both servers.

- [ ] **Step 7: Write the editor guide**

`docs/editors.md`:
```markdown
# Editing wssl.org

## One-time setup (per editor)
1. Create a free GitHub account at https://github.com/signup (use your @wssl.org email).
2. Send your GitHub username to the webmaster, who adds you as a collaborator with **Write** access on the content repository. Every editor has the same access.
3. Go to https://www.wssl.org/admin/ and click **Login with GitHub**.

## Editing a page
- Pick the section (Programs, Registration, Schedules, Fields, Volunteers, About), open the page, edit, click **Publish**.
- Publishing commits to GitHub and the site rebuilds automatically in about 1–2 minutes.
- **Draft**: tick "Draft" and publish to hide a page without deleting it.
- **New page**: click **New** in a section. "URL path" becomes the address under that section (e.g. `core/waitlists` → /programs/core/waitlists/). Add it to the menu under Site Settings → Navigation menu if it should appear in the nav.
- **PDFs and images**: use the image/file button in the editor; files are stored in `/uploads/`.

## Rainout / closure banner
Site Settings → Alert banner → tick "Show banner", write the message, Publish. Untick to remove.

## Undo
Every publish is a Git commit. Ask the webmaster to revert a change (`git revert <commit>`), or re-edit the page.
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: Decap CMS admin with GitHub OAuth via Pages Functions and editor guide"
```

---

### Task 8: Assistant corpus builder

**Files:**
- Create: `scripts/lib/corpus.ts`, `scripts/build-corpus.ts`, `functions/_lib/corpus-types.ts`
- Test: `tests/corpus.test.ts`

**Interfaces:**
- Consumes: `urlFor` from Task 2.
- Produces: `CorpusDoc = { title: string; url: string; text: string }`; `buildCorpus(root?: string): Promise<CorpusDoc[]>` (sorted by file path, drafts excluded, frontmatter stripped, absolute `https://www.wssl.org` URLs); writes `functions/_lib/corpus.json` (git-ignored, regenerated by `npm run build`).

- [ ] **Step 1: Write the failing test**

`tests/corpus.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus } from '../scripts/lib/corpus';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'corpus-'));
  mkdirSync(join(root, 'registration'), { recursive: true });
  mkdirSync(join(root, 'about'), { recursive: true });
  writeFileSync(join(root, 'registration/refund-policy.md'), '---\ntitle: Refund Policy\npath: refund-policy\n---\nNo refunds for travel.\n');
  writeFileSync(join(root, 'registration/secret.md'), '---\ntitle: Secret\npath: secret\ndraft: true\n---\nhidden\n');
  writeFileSync(join(root, 'about/index.md'), '---\ntitle: About\npath: ""\n---\nWe are WSSL.\n');
  return root;
}

describe('buildCorpus', () => {
  it('returns published pages in stable path order with absolute URLs and no frontmatter', async () => {
    const docs = await buildCorpus(fixture());
    expect(docs).toEqual([
      { title: 'About', url: 'https://www.wssl.org/about/', text: 'We are WSSL.' },
      { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', text: 'No refunds for travel.' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/corpus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`functions/_lib/corpus-types.ts`:
```ts
export interface CorpusDoc { title: string; url: string; text: string }
```

`scripts/lib/corpus.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { urlFor } from '../../src/lib/pages';
import type { CorpusDoc } from '../../functions/_lib/corpus-types';

export const SITE = 'https://www.wssl.org';

export async function buildCorpus(root = 'src/content/pages'): Promise<CorpusDoc[]> {
  const files = (await fg('**/*.md', { cwd: root })).sort();
  const docs: CorpusDoc[] = [];
  for (const file of files) {
    const { data, content } = matter(await readFile(join(root, file), 'utf8'));
    if (data.draft) continue;
    const id = file.replace(/\.md$/, '');
    docs.push({ title: String(data.title), url: SITE + urlFor(id, String(data.path ?? '')), text: content.trim() });
  }
  return docs;
}
```

`scripts/build-corpus.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { buildCorpus } from './lib/corpus';

const docs = await buildCorpus();
await mkdir('functions/_lib', { recursive: true });
await writeFile('functions/_lib/corpus.json', JSON.stringify(docs));
const chars = docs.reduce((n, d) => n + d.text.length, 0);
console.log(`corpus: ${docs.length} docs, ${chars} chars (~${Math.round(chars / 4)} tokens)`);
```

- [ ] **Step 4: Run tests and the real build**

Run: `npx vitest run tests/corpus.test.ts`
Expected: PASS.

Run: `npm run build`
Expected: prints `corpus: ~85 docs, ~265000 chars (~66000 tokens)` then the Astro build succeeds; `functions/_lib/corpus.json` exists and is git-ignored (`git status` does not list it).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: build assistant corpus from published pages"
```

---

### Task 9: Assistant API (`POST /api/chat`) with streaming, citations, caching, daily cap

**Files:**
- Create: `functions/_lib/chat.ts`, `functions/_lib/sse.ts`, `functions/_lib/usage.ts`, `functions/api/chat.ts`, `wrangler.toml`, `scripts/count-corpus-tokens.ts`
- Test: `tests/chat.test.ts`, `tests/sse.test.ts`, `tests/usage.test.ts`

**Interfaces:**
- Consumes: `CorpusDoc`, `functions/_lib/corpus.json` from Task 8.
- Produces: `ClientMessage = { role: 'user'|'assistant'; content: string }`; `validateHistory(input: unknown): ClientMessage[] | { error: string }`; `buildMessages(corpus, history): Anthropic.Beta.BetaMessageParam[]`; `ClientEvent` union (`text` | `citation` | `done` | `error`); `encodeEvent(e): string` (SSE `data:` line); `streamToClient(stream, docUrls): ReadableStream<Uint8Array>`; `checkDailyCap(kv, cap, now?)`. Wire protocol consumed by Task 10: one SSE `data:` JSON object per event.

- [ ] **Step 1: Write the failing tests**

`tests/chat.test.ts`:
```ts
import { validateHistory, buildMessages, SYSTEM_PROMPT, MODEL, MAX_MESSAGE_CHARS } from '../functions/_lib/chat';

const corpus = [
  { title: 'A', url: 'https://www.wssl.org/a/', text: 'aaa' },
  { title: 'B', url: 'https://www.wssl.org/b/', text: 'bbb' },
];

describe('validateHistory', () => {
  it('accepts alternating user/assistant strings ending with a user turn', () => {
    expect(validateHistory([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('rejects non-arrays, bad roles, empty and oversized content, and non-user last turn', () => {
    expect(validateHistory('x')).toHaveProperty('error');
    expect(validateHistory([{ role: 'system', content: 'x' }])).toHaveProperty('error');
    expect(validateHistory([{ role: 'user', content: '' }])).toHaveProperty('error');
    expect(validateHistory([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }])).toHaveProperty('error');
    expect(validateHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toHaveProperty('error');
  });
  it('keeps only the most recent turns', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    long.push({ role: 'user', content: 'last' });
    const r = validateHistory(long) as any[];
    expect(r.length).toBeLessThanOrEqual(13);
    expect(r[0].role).toBe('user');
    expect(r.at(-1).content).toBe('last');
  });
});

describe('buildMessages', () => {
  it('puts every corpus doc as a citable document in the first user turn with a 1h cache marker on the last block', () => {
    const msgs = buildMessages(corpus, [{ role: 'user', content: 'q' }]) as any[];
    expect(msgs).toHaveLength(3);
    const first = msgs[0].content;
    expect(first.filter((b: any) => b.type === 'document')).toHaveLength(2);
    expect(first[0]).toMatchObject({ type: 'document', title: 'A', context: 'https://www.wssl.org/a/', citations: { enabled: true }, source: { type: 'text', media_type: 'text/plain', data: 'aaa' } });
    expect(first.at(-1)).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2]).toEqual({ role: 'user', content: 'q' });
  });
  it('is byte-stable across calls (cache prefix)', () => {
    expect(JSON.stringify(buildMessages(corpus, [{ role: 'user', content: 'x' }])[0])).toBe(JSON.stringify(buildMessages(corpus, [{ role: 'user', content: 'y' }])[0]));
  });
  it('constants', () => {
    expect(MODEL).toBe('claude-opus-5');
    expect(SYSTEM_PROMPT).toContain('wssl.org');
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates → stable cache
  });
});
```

`tests/sse.test.ts`:
```ts
import { encodeEvent, streamToClient } from '../functions/_lib/sse';

function fakeStream(events: any[], final: any) {
  const it = { async *[Symbol.asyncIterator]() { for (const e of events) yield e; }, finalMessage: async () => final };
  return it as any;
}
async function collect(rs: ReadableStream<Uint8Array>): Promise<any[]> {
  const text = await new Response(rs).text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
}

describe('encodeEvent', () => {
  it('writes one SSE data line', () => {
    expect(encodeEvent({ type: 'text', text: 'hi' })).toBe('data: {"type":"text","text":"hi"}\n\n');
  });
});

describe('streamToClient', () => {
  const docUrls = ['https://www.wssl.org/a/', 'https://www.wssl.org/b/'];
  it('forwards text deltas and resolves citations to page URLs', async () => {
    const out = await collect(streamToClient(fakeStream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', document_index: 1, document_title: 'B', cited_text: 'bbb', start_char_index: 0, end_char_index: 3 } } },
    ], { stop_reason: 'end_turn', model: 'claude-opus-5', usage: {} }), docUrls));
    expect(out).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'citation', title: 'B', url: 'https://www.wssl.org/b/', quote: 'bbb' },
      { type: 'done', served_by: 'claude-opus-5' },
    ]);
  });
  it('replaces a refusal with a friendly message', async () => {
    const out = await collect(streamToClient(fakeStream([], { stop_reason: 'refusal', model: 'claude-opus-5', usage: {} }), docUrls));
    expect(out[0].type).toBe('text');
    expect(out[0].text).toContain("can't help");
    expect(out.at(-1).type).toBe('done');
  });
  it('emits an error event and closes when the upstream throws', async () => {
    const broken = { async *[Symbol.asyncIterator]() { throw new Error('boom'); }, finalMessage: async () => ({}) } as any;
    const out = await collect(streamToClient(broken, docUrls));
    expect(out).toEqual([{ type: 'error', message: 'The assistant is unavailable right now. Please try again in a minute.' }]);
  });
});
```

`tests/usage.test.ts`:
```ts
import { checkDailyCap } from '../functions/_lib/usage';

function fakeKv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } } as any;
}

describe('checkDailyCap', () => {
  it('counts per UTC day and blocks above the cap', async () => {
    const kv = fakeKv();
    const now = new Date('2026-09-08T12:00:00Z');
    expect(await checkDailyCap(kv, 2, now)).toEqual({ ok: true, count: 1 });
    expect(await checkDailyCap(kv, 2, now)).toEqual({ ok: true, count: 2 });
    expect(await checkDailyCap(kv, 2, now)).toEqual({ ok: false, count: 3 });
    expect(kv.store.get('chat:2026-09-08')).toBe('2');
    expect(await checkDailyCap(kv, 2, new Date('2026-09-09T00:00:00Z'))).toEqual({ ok: true, count: 1 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/chat.test.ts tests/sse.test.ts tests/usage.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the pure modules**

`functions/_lib/chat.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { CorpusDoc } from './corpus-types';

export const MODEL = 'claude-opus-5';
export const MAX_TURNS = 13;          // trailing turns kept (odd → starts and ends with user)
export const MAX_MESSAGE_CHARS = 2000;

export const SYSTEM_PROMPT = `You are "Ask WSSL", the assistant on wssl.org, the website of West Side Soccer League (WSSL), AYSO Region 473, a volunteer-run youth soccer league on Manhattan's West Side in New York City.

How to answer:
- Answer only from the wssl.org documents provided in this conversation. If they do not cover the question, say so plainly and point to the Contact page (/about/contact/) or, for registration, refunds and waitlists, the Registrar at registrar@wssl.org. Never invent dates, fees, deadlines, field locations or policies.
- Cite the page(s) you used. Put the direct answer first, then the link to the page in Markdown, e.g. [Refund Policy](https://www.wssl.org/registration/refund-policy/).
- Be concise: two to six sentences or a short bulleted list. Plain language for busy parents.
- Reply in the language the user writes in (many WSSL families speak Spanish, Chinese, French and other languages).
- Registration, payments, rosters, team assignments and game schedules live on inLeague (https://inleague.wssl.org). Send people there for anything account-specific; you cannot see their account.
- Do not give medical, legal or safety-incident advice. For player-safety concerns point to the Safety page (/registration/safety/) and SafeSport (/volunteers/volunteers/safesport/).
- If a question is unrelated to WSSL or youth soccer, or is abusive, politely say you only help with WSSL questions.
- Latency-sensitive; begin your visible answer immediately.
- Do not include internal or system XML tags in your response.`;

export interface ClientMessage { role: 'user' | 'assistant'; content: string }

export function validateHistory(input: unknown): ClientMessage[] | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: 'messages must be a non-empty array' };
  const out: ClientMessage[] = [];
  for (const m of input) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return { error: 'invalid role' };
    if (typeof m.content !== 'string' || m.content.trim() === '') return { error: 'empty message' };
    if (m.content.length > MAX_MESSAGE_CHARS) return { error: `messages must be under ${MAX_MESSAGE_CHARS} characters` };
    out.push({ role: m.role, content: m.content.trim() });
  }
  if (out.at(-1)!.role !== 'user') return { error: 'last message must be from the user' };
  let kept = out.slice(-MAX_TURNS);
  while (kept.length && kept[0].role !== 'user') kept = kept.slice(1);
  return kept;
}

const CORPUS_INTRO = 'These documents are the complete, current content of wssl.org. Use them to answer my questions and cite the pages you rely on.';
const CORPUS_ACK = 'Understood. I have the wssl.org pages loaded and will answer from them, citing the pages I use.';

export function buildMessages(corpus: CorpusDoc[], history: ClientMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const documents = corpus.map((d) => ({
    type: 'document' as const,
    source: { type: 'text' as const, media_type: 'text/plain' as const, data: d.text },
    title: d.title,
    context: d.url,
    citations: { enabled: true },
  }));
  return [
    {
      role: 'user',
      content: [
        ...documents,
        { type: 'text', text: CORPUS_INTRO, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
    },
    { role: 'assistant', content: CORPUS_ACK },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
}
```

If the SDK's `BetaMessageParam` type rejects `context` or `ttl`, look up `Anthropic.Beta.BetaRequestDocumentBlock` / `BetaCacheControlEphemeral` in `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` and adjust the *type annotations* only — the fields are part of the API.

`functions/_lib/sse.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';

export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; title: string; url: string; quote: string }
  | { type: 'done'; served_by?: string }
  | { type: 'error'; message: string };

export const REFUSAL_TEXT = "I can't help with that one. For league questions, try the Contact page: https://www.wssl.org/about/contact/";
export const ERROR_TEXT = 'The assistant is unavailable right now. Please try again in a minute.';

export function encodeEvent(e: ClientEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

type UpstreamStream = AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
};

export function streamToClient(stream: UpstreamStream, docUrls: string[], onFinal?: (m: Anthropic.Beta.BetaMessage) => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ClientEvent) => controller.enqueue(enc.encode(encodeEvent(e)));
      try {
        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          const delta = event.delta as { type: string; text?: string; citation?: { document_index: number; document_title?: string | null; cited_text: string } };
          if (delta.type === 'text_delta' && delta.text) send({ type: 'text', text: delta.text });
          else if (delta.type === 'citations_delta' && delta.citation) {
            const c = delta.citation;
            send({ type: 'citation', title: c.document_title ?? '', url: docUrls[c.document_index] ?? '', quote: c.cited_text });
          }
        }
        const final = await stream.finalMessage();
        onFinal?.(final);
        if (final.stop_reason === 'refusal') send({ type: 'text', text: REFUSAL_TEXT });
        send({ type: 'done', served_by: final.model });
      } catch {
        send({ type: 'error', message: ERROR_TEXT });
      } finally {
        controller.close();
      }
    },
  });
}
```

`functions/_lib/usage.ts`:
```ts
/** Increments today's counter (UTC) and reports whether the request is within the cap. */
export async function checkDailyCap(kv: KVNamespace, cap: number, now = new Date()): Promise<{ ok: boolean; count: number }> {
  const key = `chat:${now.toISOString().slice(0, 10)}`;
  const count = Number((await kv.get(key)) ?? '0') + 1;
  if (count > cap) return { ok: false, count };
  await kv.put(key, String(count), { expirationTtl: 60 * 60 * 48 });
  return { ok: true, count };
}
```

- [ ] **Step 4: Run the unit tests**

Run: `npx vitest run tests/chat.test.ts tests/sse.test.ts tests/usage.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Write the handler, wrangler config, and token counter**

`functions/api/chat.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import corpusJson from '../_lib/corpus.json';
import type { CorpusDoc } from '../_lib/corpus-types';
import { MODEL, SYSTEM_PROMPT, buildMessages, validateHistory } from '../_lib/chat';
import { streamToClient } from '../_lib/sse';
import { checkDailyCap } from '../_lib/usage';

interface Env { ANTHROPIC_API_KEY: string; USAGE: KVNamespace; DAILY_CAP?: string }

const corpus = corpusJson as CorpusDoc[];
const docUrls = corpus.map((d) => d.url);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403);

  let body: { messages?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const history = validateHistory(body?.messages);
  if ('error' in history) return json({ error: history.error }, 400);

  const cap = await checkDailyCap(env.USAGE, Number(env.DAILY_CAP ?? 1500));
  if (!cap.ok) return json({ error: 'Ask WSSL has reached its daily limit. Please try again tomorrow or use the Contact page.' }, 429);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 4096,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: buildMessages(corpus, history),
  });

  return new Response(
    streamToClient(stream, docUrls, (final) => console.log(JSON.stringify({ usage: final.usage, model: final.model, stop: final.stop_reason, day_count: cap.count }))),
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } },
  );
};
```

If the installed SDK's TypeScript types do not yet include the scalar `fallbacks: 'default'`, keep the value and spread it in as `...({ fallbacks: 'default' } as Record<string, unknown>)` — the API accepts it with that beta header. Do not switch to the array form.

`wrangler.toml` (create the KV namespace first):
```bash
npx wrangler login
npx wrangler kv namespace create USAGE            # prints an id → paste below
npx wrangler kv namespace create USAGE --preview  # prints a preview_id → paste below
```
```toml
name = "wssl-cms"
compatibility_date = "2026-09-01"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "dist"

[vars]
DAILY_CAP = "1500"

[[kv_namespaces]]
binding = "USAGE"
id = "<id printed by wrangler kv namespace create USAGE>"
preview_id = "<preview_id printed by the --preview command>"
```

`scripts/count-corpus-tokens.ts` (checks the corpus fits comfortably and prints the cost per question):
```ts
import Anthropic from '@anthropic-ai/sdk';
import { buildCorpus } from './lib/corpus';
import { MODEL, SYSTEM_PROMPT, buildMessages } from '../functions/_lib/chat';

const client = new Anthropic();
const corpus = await buildCorpus();
const res = await client.beta.messages.countTokens({
  model: MODEL,
  system: SYSTEM_PROMPT,
  messages: buildMessages(corpus, [{ role: 'user', content: 'What is the refund policy?' }]),
});
const t = res.input_tokens;
console.log(`input tokens: ${t}`);
console.log(`cached read cost/question ≈ $${((t / 1e6) * 5 * 0.1).toFixed(4)}; 1h cache write ≈ $${((t / 1e6) * 5 * 2).toFixed(3)}`);
if (t > 150_000) { console.error('Corpus is larger than expected — revisit the full-context design (see spec).'); process.exit(1); }
```

- [ ] **Step 6: Live test locally**

```bash
cp .dev.vars.example .dev.vars   # then put the real ANTHROPIC_API_KEY in .dev.vars
npx tsx --env-file=.dev.vars scripts/count-corpus-tokens.ts
```
Expected: `input tokens:` between 55,000 and 110,000 and no exit error.

```bash
npm run build
npx wrangler pages dev dist
```
In another terminal:
```bash
curl -sN -X POST http://localhost:8788/api/chat -H 'Content-Type: application/json' -H 'Origin: http://localhost:8788' \
  -d '{"messages":[{"role":"user","content":"Can I get a refund for core if my child is injured?"}]}'
```
Expected: a series of `data: {"type":"text",...}` lines forming an answer that mentions the $30 administrative fee and a doctor's note, at least one `{"type":"citation","title":"Refund Policy","url":"https://www.wssl.org/registration/refund-policy/",...}`, then `{"type":"done",...}`.

Run the same curl a second time. In the `wrangler pages dev` terminal the logged `usage` JSON for the second call must show `cache_read_input_tokens` > 50000. If it is 0, something in the prefix changes between requests — compare `JSON.stringify(buildMessages(...)[0])` across calls (the unit test guards this) and make sure `SYSTEM_PROMPT` has no timestamps.

Also check the guards:
```bash
curl -s -X POST http://localhost:8788/api/chat -H 'Content-Type: application/json' -d '{"messages":[]}'            # → 400
curl -s -X POST http://localhost:8788/api/chat -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -d '{}'   # → 403
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Ask WSSL assistant endpoint with streaming, citations, prompt caching and daily cap"
```

---

### Task 10: "Ask WSSL" chat widget in the site layout

**Files:**
- Create: `src/lib/chat-client.ts`, `src/components/ChatWidget.astro`
- Modify: `src/layouts/BaseLayout.astro` (mount the widget)
- Test: `tests/chat-client.test.ts`

**Interfaces:**
- Consumes: SSE wire protocol from Task 9 (`ClientEvent`).
- Produces: `parseSseChunk(buffer: string): { events: ClientEvent[]; rest: string }`; `streamChat(messages, onEvent, signal?)`.

- [ ] **Step 1: Write the failing test**

`tests/chat-client.test.ts`:
```ts
import { parseSseChunk } from '../src/lib/chat-client';

describe('parseSseChunk', () => {
  it('parses complete events and keeps the incomplete tail', () => {
    const buf = 'data: {"type":"text","text":"He"}\n\ndata: {"type":"text","text":"llo"}\n\ndata: {"type":"do';
    const { events, rest } = parseSseChunk(buf);
    expect(events).toEqual([{ type: 'text', text: 'He' }, { type: 'text', text: 'llo' }]);
    expect(rest).toBe('data: {"type":"do');
  });
  it('ignores malformed frames', () => {
    expect(parseSseChunk('data: not json\n\n').events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/chat-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client library**

`src/lib/chat-client.ts`:
```ts
export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; title: string; url: string; quote: string }
  | { type: 'done'; served_by?: string }
  | { type: 'error'; message: string };

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export function parseSseChunk(buffer: string): { events: ClientEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: ClientEvent[] = [];
  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* skip malformed frame */ }
  }
  return { events, rest };
}

export async function streamChat(messages: ChatMessage[], onEvent: (e: ClientEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }));
    onEvent({ type: 'error', message: data.error ?? 'Request failed' });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/chat-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the widget**

`src/components/ChatWidget.astro`:
```astro
---
const suggestions = [
  'How do I register my child?',
  'What is the refund policy?',
  'Where are the fields?',
  'How do I become a referee?',
];
---
<button id="ask-open" class="fixed bottom-5 right-5 z-40 bg-navy text-white font-bold px-5 py-3 rounded-full shadow-lg hover:bg-gold hover:text-navy" aria-controls="ask-panel" aria-expanded="false">Ask WSSL</button>

<section id="ask-panel" class="fixed bottom-5 right-5 z-50 w-[min(24rem,calc(100vw-2.5rem))] h-[min(36rem,calc(100vh-2.5rem))] bg-white border border-gray-300 rounded-xl shadow-2xl flex flex-col" hidden aria-label="Ask WSSL assistant">
  <header class="flex items-center justify-between bg-navy text-white px-4 py-3 rounded-t-xl">
    <span class="font-bold">Ask WSSL</span>
    <button id="ask-close" class="text-white/80 hover:text-white" aria-label="Close">✕</button>
  </header>
  <div id="ask-messages" class="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
    <div class="text-gray-700">Hi! I answer questions using the pages on wssl.org and link you to them. What would you like to know?</div>
    <div id="ask-suggestions" class="flex flex-wrap gap-2">
      {suggestions.map((s) => <button class="ask-suggest border border-navy text-navy rounded-full px-3 py-1 text-xs hover:bg-navy hover:text-white">{s}</button>)}
    </div>
  </div>
  <form id="ask-form" class="border-t border-gray-200 p-3 flex gap-2">
    <input id="ask-input" class="flex-1 border border-gray-300 rounded px-3 py-2 text-sm" placeholder="Ask about registration, schedules, fields…" maxlength="2000" autocomplete="off" required />
    <button id="ask-send" class="bg-navy text-white font-bold px-4 rounded disabled:opacity-50" type="submit">Send</button>
  </form>
  <p class="text-[11px] text-gray-500 px-3 pb-2">Answers come from wssl.org pages and may be incomplete — check the linked page. Don't share personal or medical details.</p>
</section>

<script>
  import { marked } from 'marked';
  import DOMPurify from 'dompurify';
  import { streamChat, type ChatMessage, type ClientEvent } from '../lib/chat-client';

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const panel = $('ask-panel'), openBtn = $('ask-open'), closeBtn = $('ask-close');
  const list = $('ask-messages'), form = $<HTMLFormElement>('ask-form'), input = $<HTMLInputElement>('ask-input'), send = $<HTMLButtonElement>('ask-send');

  const STORAGE = 'askwssl:history';
  let history: ChatMessage[] = [];
  try { history = JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]'); } catch { history = []; }

  function render(md: string): string {
    return DOMPurify.sanitize(marked.parse(md, { async: false }) as string, { ADD_ATTR: ['target'] });
  }
  function bubble(role: 'user' | 'assistant'): HTMLDivElement {
    const el = document.createElement('div');
    el.className = role === 'user' ? 'ml-8 bg-navy text-white rounded-lg px-3 py-2' : 'mr-4 bg-gray-100 rounded-lg px-3 py-2 prose prose-sm max-w-none prose-a:text-navy';
    list.appendChild(el);
    return el;
  }
  function sourcesEl(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'mr-4 text-xs text-gray-600';
    list.appendChild(el);
    return el;
  }
  function scroll() { list.scrollTop = list.scrollHeight; }

  for (const m of history) { bubble(m.role).innerHTML = m.role === 'user' ? DOMPurify.sanitize(m.content) : render(m.content); }

  async function ask(question: string) {
    $('ask-suggestions')?.remove();
    history.push({ role: 'user', content: question });
    bubble('user').textContent = question;
    const out = bubble('assistant');
    out.textContent = '…';
    send.disabled = true; input.disabled = true;
    let text = '';
    const sources = new Map<string, string>();
    const onEvent = (e: ClientEvent) => {
      if (e.type === 'text') { text += e.text; out.innerHTML = render(text); }
      else if (e.type === 'citation' && e.url) sources.set(e.url, e.title || e.url);
      else if (e.type === 'error') { text = text || e.message; out.innerHTML = render(text); }
      scroll();
    };
    try { await streamChat(history, onEvent); }
    finally {
      if (sources.size) {
        const s = sourcesEl();
        s.innerHTML = 'Sources: ' + [...sources].map(([url, title]) => `<a class="underline" href="${url}">${DOMPurify.sanitize(title)}</a>`).join(' · ');
      }
      history.push({ role: 'assistant', content: text });
      try { sessionStorage.setItem(STORAGE, JSON.stringify(history.slice(-20))); } catch { /* storage unavailable */ }
      send.disabled = false; input.disabled = false; input.focus(); scroll();
    }
  }

  openBtn.addEventListener('click', () => { panel.hidden = false; openBtn.setAttribute('aria-expanded', 'true'); openBtn.hidden = true; input.focus(); });
  closeBtn.addEventListener('click', () => { panel.hidden = true; openBtn.hidden = false; openBtn.setAttribute('aria-expanded', 'false'); });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); const q = input.value.trim(); if (!q) return; input.value = ''; ask(q); });
  list.addEventListener('click', (ev) => { const b = (ev.target as HTMLElement).closest('.ask-suggest'); if (b) ask(b.textContent!.trim()); });
</script>
```

Mount it in `src/layouts/BaseLayout.astro`: add `import ChatWidget from '../components/ChatWidget.astro';` and place `<ChatWidget />` after `<Footer />`.

- [ ] **Step 6: Run everything and try it in a browser**

```bash
npm test
npm run build && npx wrangler pages dev dist
```
Open http://localhost:8788/ → click **Ask WSSL** → click "What is the refund policy?" → the answer streams in, renders Markdown, and a "Sources: Refund Policy" link appears. Reload the page: the conversation is still there (sessionStorage). Ask a follow-up ("and for travel teams?") to confirm history is sent. Try on a 375px-wide viewport: the panel fits the screen.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: Ask WSSL chat widget with streaming answers and source links"
```

---

### Task 11: Link checker and content QA

**Files:**
- Create: `scripts/lib/links.ts`, `scripts/check-links.ts`, `docs/content-qa.md`
- Test: `tests/links.test.ts`

**Interfaces:**
- Produces: `internalHrefs(html: string): string[]`; `resolveInternal(href: string, distDir: string): boolean`.

- [ ] **Step 1: Write the failing test**

`tests/links.test.ts`:
```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalHrefs, resolveInternal } from '../scripts/lib/links';

describe('internalHrefs', () => {
  it('returns unique site-relative hrefs and src without hash/query, ignoring external and mailto', () => {
    const html = '<a href="/a/">x</a><a href="/a/#top">y</a><a href="https://inleague.wssl.org/">z</a><a href="mailto:x@y">m</a><img src="/images/l.png"><a href="/docs/f.pdf?v=1">p</a>';
    expect(internalHrefs(html)).toEqual(['/a/', '/images/l.png', '/docs/f.pdf']);
  });
});

describe('resolveInternal', () => {
  it('resolves directories to index.html and files directly', () => {
    const dist = mkdtempSync(join(tmpdir(), 'dist-'));
    mkdirSync(join(dist, 'a'), { recursive: true });
    writeFileSync(join(dist, 'a/index.html'), '');
    mkdirSync(join(dist, 'images'), { recursive: true });
    writeFileSync(join(dist, 'images/l.png'), '');
    expect(resolveInternal('/a/', dist)).toBe(true);
    expect(resolveInternal('/a', dist)).toBe(true);
    expect(resolveInternal('/images/l.png', dist)).toBe(true);
    expect(resolveInternal('/missing/', dist)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/links.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/links.ts`:
```ts
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function internalHrefs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    out.add(decodeURIComponent(raw.split('#')[0].split('?')[0]));
  }
  return [...out];
}

export function resolveInternal(href: string, distDir: string): boolean {
  const p = join(distDir, href);
  if (existsSync(p) && statSync(p).isFile()) return true;
  return existsSync(join(p, 'index.html'));
}
```

`scripts/check-links.ts`:
```ts
import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { internalHrefs, resolveInternal } from './lib/links';

const broken: string[] = [];
for (const file of fg.sync('dist/**/*.html')) {
  for (const href of internalHrefs(readFileSync(file, 'utf8'))) {
    if (href.startsWith('/api/')) continue;
    if (!resolveInternal(href, 'dist')) broken.push(`${file.replace(/^dist/, '')} → ${href}`);
  }
}
if (broken.length) { console.error(`${broken.length} broken internal links:\n` + broken.join('\n')); process.exit(1); }
console.log('no broken internal links');
```

- [ ] **Step 4: Run the tests and the checker**

Run: `npx vitest run tests/links.test.ts`
Expected: PASS.

Run: `npm run build && npm run check-links`
Expected: a list of broken links on the first run (legacy links to pages that were renamed, missing assets). Fix each one by editing the Markdown in `src/content/pages` (or adding a line to `public/_redirects` when a legacy path is linked from outside). Re-run until it prints `no broken internal links`.

- [ ] **Step 5: Write the content QA checklist and work through it**

`docs/content-qa.md`:
```markdown
# Content QA — legacy vs new

Do this on `npx astro preview` (or the staging URL) with the old site open side by side.

For each top-level section, open every page listed in `src/data/nav.json` and check:
- [ ] Title and body text match the old page (tables, bullet lists, bold warnings such as the refund notice).
- [ ] Every PDF link opens (`/assets/legacy/...`), or points to the original external URL if the download failed.
- [ ] Images show; remove decorative ones that came through broken.
- [ ] Old Mura forms (Contact, Coach comment form, Referee feedback) are replaced with a link to a Google Form created by the section owner.
- [ ] Embedded YouTube/Maps iframes render (Referee videos, Fields pages).
- [ ] Pages that are out of date (e.g. Fall 2025 divisions) are either updated or marked Draft.

Record anything you cannot fix as a line in this file under "Open items".

## Open items
```

Then run through it and fix the Markdown; commit as you go.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: internal link checker and content QA pass"
```

---

### Task 12: Deploy to Cloudflare Pages (staging) and wire the CMS

**Files:**
- Create: `docs/runbook.md`
- Modify: `public/admin/config.yml` (`repo`, `base_url`)

**Interfaces:**
- Consumes: everything above.
- Produces: staging site at `https://wssl-cms.pages.dev`, GitHub repo, Pages project with secrets and KV binding, GitHub OAuth App.

- [ ] **Step 1: Merge to main and push to a new private GitHub repo**

```bash
git checkout main && git merge --ff-only site-build
gh repo create wssl-cms --private --source . --push --description "wssl.org site: Astro + Decap CMS + Ask WSSL assistant"
```
Use the WSSL GitHub organization if one exists (`gh repo create <org>/wssl-cms ...`); otherwise create under the webmaster's account and transfer later. Note the final `OWNER/REPO`.

- [ ] **Step 2: Create the Pages project connected to GitHub**

In the Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → select `OWNER/wssl-cms`:
- Production branch: `main`
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variables (Production **and** Preview): `NODE_VERSION=24`, `DAILY_CAP=1500`
- Secrets (Production and Preview): `ANTHROPIC_API_KEY` (create a dedicated key in the Anthropic Console named "wssl-site-assistant" with a monthly spend limit of $100), `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (from Step 3)
- Bindings → KV namespace: variable `USAGE` → the namespace created in Task 9 (`wrangler.toml` already declares it; the dashboard binding must match)

Save and let the first build run. Expected: build succeeds in < 3 minutes, `https://wssl-cms.pages.dev` shows the home page, and `https://wssl-cms.pages.dev/registration/refund-policy/` renders.

- [ ] **Step 3: Create the GitHub OAuth App for the CMS**

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:
- Application name: `WSSL site editor (staging)`
- Homepage URL: `https://wssl-cms.pages.dev`
- Authorization callback URL: `https://wssl-cms.pages.dev/api/callback`
Generate a client secret; put the id/secret into the Pages secrets from Step 2 and redeploy (Deployments → Retry).

Edit `public/admin/config.yml`: `repo: OWNER/wssl-cms`, `base_url: https://wssl-cms.pages.dev`. Commit and push:
```bash
git commit -am "chore: point Decap at the staging deployment" && git push
```

- [ ] **Step 4: Verify the editing loop end to end**

Open `https://wssl-cms.pages.dev/admin/` → Login with GitHub → authorize → Registration → Refund Policy → append a sentence → Publish. Expected: a commit `content: update registration "refund-policy"` appears on `main` within seconds, Pages starts a build, and the sentence is live within ~2 minutes. Revert the sentence the same way.

- [ ] **Step 5: Verify the assistant and add the WAF rate limit**

Ask "How much is the administrative fee on a core refund?" on the staging site. Expected: streamed answer with `$30` and a Refund Policy source link. In Cloudflare → the `wssl.org` zone → Security → WAF → Rate limiting rules → Create:
- Name: `ask-wssl-chat`
- If incoming requests match: URI Path equals `/api/chat`
- Rate: 10 requests per 10 seconds per IP
- Action: Block for 1 minute
(The rule attaches to the zone; it applies once `www.wssl.org` points at Pages in Task 13. Preview `*.pages.dev` traffic is protected by the KV daily cap only.)

- [ ] **Step 6: Write the runbook**

`docs/runbook.md`:
```markdown
# Operations runbook — wssl.org

## Where things live
- Code + content: GitHub `OWNER/wssl-cms` (branch `main` = production)
- Hosting/build: Cloudflare Pages project `wssl-cms` (auto-builds on every push to `main`)
- Editor login: GitHub OAuth App "WSSL site editor" (owner: webmaster's GitHub account)
- Assistant: Cloudflare Pages Function `/api/chat` → Anthropic API key "wssl-site-assistant" (Anthropic Console, $100/month limit)
- Usage counter: Cloudflare KV namespace `USAGE` (`chat:YYYY-MM-DD` = requests that day)

## Adding / removing an editor
GitHub repo → Settings → Collaborators → add username with **Write**. Remove the same way. All editors have identical rights.

## Rolling back a bad edit
`git revert <sha> && git push` (or GitHub UI → commit → Revert). Pages rebuilds automatically.

## Assistant cost and limits
- Daily request cap: Pages env var `DAILY_CAP` (default 1500). Raise/lower in Pages → Settings → Variables, then redeploy.
- Per-question cost ≈ $0.03–0.06 (cached corpus read + answer). Whole-corpus cache write ≈ $0.66 once per hour of activity.
- To use a cheaper model, change `MODEL` in `functions/_lib/chat.ts` to `claude-sonnet-5` (≈60% cheaper); keep every other request field unchanged.
- Zone WAF rule `ask-wssl-chat` blocks > 10 requests / 10 s per IP.

## Rotating the Anthropic key
Create a new key in the Anthropic Console → Pages → Settings → Secrets → update `ANTHROPIC_API_KEY` → Retry deployment → delete the old key.

## Rebuilding the corpus
It is rebuilt on every deploy (`npm run build` runs `scripts/build-corpus.ts`). Drafts are excluded automatically.

## Local development
`npm install`, `cp .dev.vars.example .dev.vars` (add the key), `npm run build && npm run preview` for the full site + functions; `npx decap-server` + `npm run dev` for CMS editing against the working tree.
```

- [ ] **Step 7: Commit**

```bash
git add docs/runbook.md
git commit -m "docs: operations runbook" && git push
```

---

### Task 13: Production cutover (DNS) and post-launch checks

**Files:**
- Modify: `public/admin/config.yml` (`base_url: https://www.wssl.org`)

- [ ] **Step 1: Freeze legacy edits and re-run the migration diff**

Tell the board no edits on the Mura site from this point. Re-run `npm run migrate` on a scratch branch and `git diff --stat src/content/pages`; port any page that changed on the old site since Task 4 (apply the diff), then discard the scratch branch. Push `main`.

- [ ] **Step 2: Switch the OAuth app and Decap config to production**

Create a second GitHub OAuth App "WSSL site editor" with homepage `https://www.wssl.org` and callback `https://www.wssl.org/api/callback`; put its id/secret into the Pages **Production** secrets (leave the staging app on Preview). Edit `public/admin/config.yml` → `base_url: https://www.wssl.org`; commit and push.

- [ ] **Step 3: Attach the custom domains**

Cloudflare Pages → `wssl-cms` → Custom domains → add `www.wssl.org`, then `wssl.org`. Cloudflare offers to create/replace the DNS records in the zone — accept. **Do not touch** the `inleague`, `cms`, or mail (`MX`, `TXT`) records. Expected: both domains show "Active" within a few minutes; `https://www.wssl.org/` serves the new site; `https://wssl.org/` redirects to `www` (Pages handles apex → www when both are added; if not, add a Bulk Redirect `wssl.org/*` → `https://www.wssl.org/$1`).

Keep the old Mura instance reachable at `https://cms.wssl.org` for 30 days as a reference, then decommission it with inLeague.

- [ ] **Step 4: Post-launch verification**

```bash
curl -sI https://www.wssl.org/ | grep -i "HTTP/"                                    # 200
curl -sI https://www.wssl.org/registration/refund-policy | grep -i "location"        # 308 → trailing slash
curl -sI https://www.wssl.org/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf | grep -iE "HTTP/|location"   # 301 → /assets/legacy/...
curl -s https://www.wssl.org/robots.txt | grep Sitemap
```
Then in a browser: log in at `https://www.wssl.org/admin/` and publish a one-word change; confirm it goes live. Ask the assistant three real questions from the board's list (registration, practice times, referee class schedule) and confirm each cites the right page.

Google Search Console: add the `www.wssl.org` property (DNS verification via Cloudflare) and submit `https://www.wssl.org/sitemap-index.xml`.

- [ ] **Step 5: Hand-off**

Send the board `docs/editors.md`, the `/admin/` URL, and the runbook location. Add each editor's GitHub username as a collaborator (Task 12 runbook). Close out the project with a final commit if any docs changed.

---

## Self-review notes

- **Spec coverage**: extraction (Task 3–4), layouts/nav/alerts/footer/docs styling (Task 5–6), transactional links preserved (external links untouched in Task 3, Register CTAs in Task 5–6), CMS schema + validation + auth (Task 7), deployment + AI in root layout + DNS (Tasks 9–13), permissions delta = all editors equal (Task 7 config, Task 12 collaborators), custom assistant with latest model/features (Task 9), cost table respected (Task 12 runbook), forms → Google Forms (Task 11 QA list). Blog, PDF-text corpus, role zones are declared non-goals in the spec.
- **Type consistency**: `urlFor(id, path)` used identically in Tasks 2, 5, 8; `CorpusDoc {title,url,text}` shared by Tasks 8–9; `ClientEvent` union identical in `functions/_lib/sse.ts` and `src/lib/chat-client.ts`; `PAGE_FIELD_NAMES` order matches the Decap field order in Task 7; `validateHistory` returns exactly `ClientMessage[] | {error}` as the handler checks with `'error' in history`.
- **Known judgment calls for the executor**: exact `yaml.stringify` quoting in Task 4 Step 4; SDK type names for `context`/`ttl`/`fallbacks` in Task 9 — adjust annotations, never the request payload.

---

### Task 14: Home page and header parity with the legacy site

Added 2026-09-08 after the owner compared the new home page with the live one and asked to "keep the same layout and styles". Reference captures of the live site are in the SDD workspace: `legacy-home-template.html` (the home body), `legacy-custom.css` and `legacy-site.css` (the theme), `legacy-home.html` (full page).

**Files:**
- Create: `src/data/home.json`, `src/components/Carousel.astro`, `src/components/HomeCard.astro`, `tests/home.test.ts`
- Modify: `src/pages/index.astro`, `src/components/Header.astro`, `src/components/Footer.astro`, `src/data/site.json`, `public/admin/config.yml`, `scripts/migrate.ts` (`THEME_IMAGES`), `tests/cms-config.test.ts`, `tests/nav.test.ts` (site.json shape)
- Download once (and add to `THEME_IMAGES` so re-runs keep them): `https://www.wssl.org/sites/wssl/assets/Carousel/carousel-5.png` → `public/images/carousel-5.png`, `https://www.wssl.org/sites/wssl/assets/Image/soccerball-icon.png` → `public/images/soccerball-icon.png`, `https://www.wssl.org/sites/wssl/assets/Image/referee-icon.png` → `public/images/referee-icon.png`

**Interfaces:**
- `site.json` gains `loginUrl: "https://inleague.wssl.org"`, `searchCx: "012165111916761362607:zaoi28ltsvu"`, `footerNote` (the AYSO 501(c)(3)/donations paragraph from the legacy footer, plain text, two sentences allowed as one string with `\n\n`).
- `home.json` shape:
```json
{
  "fieldStatus": "",
  "carousel": ["/images/carousel-1.png", "/images/carousel-2.png", "/images/carousel-3.png", "/images/carousel-4.png", "/images/carousel-5.png"],
  "programButtons": [
    { "label": "Core League U6-U19", "href": "/programs/core/" },
    { "label": "Development Academy U6-U14", "href": "/programs/da/" },
    { "label": "Travel Teams U8-U19", "href": "/programs/travel-teams/" },
    { "label": "Tournament Teams U9-U14", "href": "/programs/tournament-teams/" },
    { "label": "VIP Program (Special Needs)", "href": "/programs/epic/" },
    { "label": "Playground (3 and 4 year olds)", "href": "/programs/playground/" }
  ],
  "cards": [
    { "title": "Registration and Tryouts", "icon": "/images/soccerball-icon.png", "body": "<markdown of the legacy card 0 text, links preserved>" },
    { "title": "Volunteer Training", "icon": "/images/referee-icon.png", "body": "<markdown of the legacy card 1 text, links preserved>" }
  ]
}
```
- Card `body` is Markdown rendered at build time with `marked` (editors are trusted; no DOMPurify on the server).

**Layout to reproduce (from `legacy-home-template.html`):**
1. Header: the banner image `/images/wssl-header-lg.png` centered above the nav (max width ~1200px, white/light background), then the navy nav bar: uppercase bold links in PT Sans, `Home` first, the six sections with dropdowns, then `Login` → `site.loginUrl`. Mobile keeps the Menu toggle.
2. Home body, in a `max-w-6xl` container: (a) a full-width row with the Google Programmable Search box: `<div class="gcse-searchbox-only"></div>` plus `<script async src={`https://cse.google.com/cse.js?cx=${site.searchCx}`}></script>` (home page only); (b) a two-column row at `md+`: left = `Carousel` (the five images, auto-rotating every 5s with a tiny inline script, first image visible without JS) followed by the program buttons as a stacked `list-group` (navy background, white text, centered, gold on hover); right = `**FIELD STATUS:**` line with `home.fieldStatus` (rendered even when empty, like the legacy site), then the two `HomeCard`s (navy header bar with gold uppercase title, white body, icon before the first line).
3. Footer: `site.footerNote` paragraph, a divider, then the social links, then the copyright line. Keep the existing quick links.
4. Colors/typography come from `legacy-custom.css` (`.card-header`, `.list-group-item`, `.navbar` rules) — reproduce them with Tailwind utilities or a few rules in `src/styles/global.css`; do not import the legacy CSS files.
5. Delete the four cards + "Have a question?" section from the current `index.astro`; the Ask WSSL button remains (it is in `BaseLayout`).

**Decap:** add a `home` file to the `settings` collection editing `src/data/home.json` with fields: `fieldStatus` (string, optional), `carousel` (list of `image` widgets with `media_folder: public/images`, `public_folder: /images`), `programButtons` (list of `{label: string, href: string}`), `cards` (list of `{title: string, icon: string, body: markdown}`). Add `loginUrl`, `searchCx`, `footerNote` to the `site` file's fields.

**Tests** (`tests/home.test.ts`): `home.json` has exactly the keys above; every `programButtons[].href` and every internal link inside `cards[].body` resolves to a published content page (reuse the `contentUrls()` approach from `tests/nav.test.ts`, extracted into `tests/helpers/content-urls.ts` and imported by both tests); every `carousel[]` and `cards[].icon` path exists under `public/`; `site.json` has `loginUrl`, `searchCx`, `footerNote`. Update `tests/cms-config.test.ts` so the settings files list includes `src/data/home.json` and the `home` file's field names equal `['fieldStatus','carousel','programButtons','cards']`.

**Build checks:** after `npm run build`: `dist/index.html` contains `gcse-searchbox-only`, `cse.js?cx=012165111916761362607`, `Registration and Tryouts`, `Volunteer Training`, `Core League U6-U19`, `FIELD STATUS`, `wssl-header-lg.png`, `href="https://inleague.wssl.org"` (Login), and the footer note's "95-6205398"; `dist/registration/refund-policy/index.html` contains `wssl-header-lg.png` (banner on every page) and `>Login<`. `npm run check-links` stays clean. Take a screenshot of `http://localhost:8788/` in the in-app browser at desktop width and compare against the legacy structure: banner, navy nav, search row, carousel+buttons left, field status+cards right.

**Commit:** `feat: home page and header layout matching the legacy site`

---

### Task 15: CMS login by email (Cloudflare Access) with a shared GitHub bot token

Added 2026-09-08 at the owner's request: editors must not need GitHub accounts. Replaces the per-editor GitHub OAuth flow from Task 7.

**Architecture:** Cloudflare Access (Zero Trust, "self-hosted" application, One-time PIN login, policy = allowed emails or `@wssl.org`) protects `/admin/*` and `/api/cms/*` on the zone. Decap runs with its **proxy backend** (the protocol `decap-server` speaks: `POST <proxy_url>` with a JSON `{ action, params }` body) pointed at a Pages Function `functions/api/cms/v1.ts`, which implements that protocol against the GitHub REST API using one fine-grained personal access token (Contents: read/write on the content repo only). Every request must carry a valid Access JWT (`Cf-Access-Jwt-Assertion` header, RS256, verified against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, `aud` = the Access application's AUD tag); the editor's `email` claim becomes the git **author** of each commit (the bot is the committer), preserving per-person history. No editorial workflow (`publish_modes: ['simple']`).

**Files:**
- Create: `functions/_lib/access-jwt.ts` (`verifyAccessJwt(token, { teamDomain, aud, fetchImpl?, now? }): Promise<{ email: string }>` using `jose`'s `createRemoteJWKSet`/`jwtVerify`; add `jose` as a dependency), `functions/_lib/github-content.ts` (thin typed client over the GitHub Contents/Trees API: `listTree(prefix)`, `getFile(path)`, `putFile(path, contentBase64, message, { author, sha? })`, `deleteFile(path, message, { author, sha })`, `getRawFile(path)`), `functions/_lib/decap-proxy.ts` (pure handler `handleProxyAction(action, params, deps): Promise<unknown>` implementing `info`, `entriesByFolder`, `entriesByFiles`, `getEntry`, `unpublishedEntries` (→ `[]`), `persistEntry`, `getMedia`, `getMediaFile`, `persistMedia`, `deleteFiles`/`deleteFile`, `getDeployPreview` (→ `null`)), `functions/api/cms/v1.ts` (POST handler: CORS none, method check, JWT verification, JSON parse, dispatch, error → JSON `{ error }` with 4xx/5xx), `tests/access-jwt.test.ts`, `tests/decap-proxy.test.ts`, `tests/cms-proxy-handler.test.ts`
- Modify: `public/admin/index.html` (manual init: on `localhost`/`127.0.0.1` use `http://localhost:8081/api/v1` (decap-server, unchanged); otherwise `local_backend: { url: location.origin + '/api/cms/v1', allowed_hosts: [location.hostname] }`), `public/admin/config.yml` (`backend` stays `name: github` as the declared fallback with `repo: OWNER/REPO`, but remove `base_url`/`auth_endpoint`; add `publish_mode: simple`), `wrangler.toml` (`[vars] GITHUB_REPO = "OWNER/REPO"`, `GITHUB_BRANCH = "main"`, `CF_ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"`, `CF_ACCESS_AUD = "<aud tag>"` as documented placeholders; the secret `GITHUB_BOT_TOKEN` is set in the dashboard / `.dev.vars`), `.dev.vars.example`, `README.md` ("Before this goes live": Access application + policy, AUD tag, team domain, bot token; remove the GitHub OAuth App items), `docs/editors.md` (email one-time-code login; no GitHub account), `tests/cms-config.test.ts`
- Delete: `functions/api/auth.ts`, `functions/api/callback.ts`, `functions/_lib/oauth.ts`, `tests/oauth.test.ts`; drop the `/api/callback` block from `public/_headers`; drop `GITHUB_OAUTH_*` from `.dev.vars.example`.

**Protocol source of truth:** install `decap-server` as a devDependency and read `node_modules/decap-server/dist/middlewares/localFs/index.js` (action handlers and response shapes) and `node_modules/decap-server/dist/middlewares/joi/index.js` (request schemas). Mirror those shapes exactly; Decap's browser client is unforgiving about them. Entries are `{ file: { path, id? }, data: <file text> }`; media files are `{ id, name, path, url|content, encoding }` (match localFs); `persistEntry` params carry `entry: { path, raw, newPath? }` (Decap ≥3 sends `dataFiles: [{ path, raw, newPath? }]` — support both), `assets: [{ path, content, encoding: 'base64' }]`, `options: { commitMessage }`. `info` returns `{ repo: <owner/repo>, publish_modes: ['simple'], type: 'github' }`.

**Security requirements:** reject when the JWT header is missing/invalid (401), when `aud` or issuer mismatch, when expired; never accept a JWT in dev unless `env.CF_ACCESS_AUD` is unset **and** the request host is `localhost`/`127.0.0.1` (then use `author = { name: 'Local editor', email: 'local@wssl.org' }`); reject any `path` that is not under `src/content/pages/`, `src/data/`, or `public/uploads/` or that contains `..` (400); size-limit request bodies to 8 MB; commit messages come from Decap's `commit_messages` with the editor email appended as `Author: <email>` only in the git author field, never in the message; never log token values.

**Tests:** `access-jwt.test.ts` generates an RSA key pair with `jose`, signs a JWT, serves a fake JWKS through the injected `fetchImpl`, and asserts: valid → email; wrong aud → rejects; expired → rejects; missing `email` → rejects. `decap-proxy.test.ts` drives every action against an in-memory fake of the github-content client (a `Map<path, {content, sha}>`) and asserts request/response shapes, path validation (400), author attribution on writes, `newPath` renames (delete old + put new), and that `unpublishedEntries` returns `[]`. `cms-proxy-handler.test.ts` calls `onRequestPost` with a fake context: no JWT → 401; bad JSON → 400; `info` with a valid JWT (stubbed verifier via injectable `deps`) → 200 JSON; GET → 405.

**Manual check (needs a bot token; do what is possible without one):** with `GITHUB_BOT_TOKEN` in `.dev.vars` and `CF_ACCESS_AUD` unset, `npm run build && npx wrangler pages dev dist --kv USAGE --port 8790`, open `http://localhost:8790/admin/`, log in (no GitHub prompt), open a page, edit, Publish → a commit authored by `Local editor <local@wssl.org>` appears on the configured branch. Without a token, verify `POST /api/cms/v1` `{ action: 'info' }` returns the `info` shape and that a `persistEntry` fails with a clear 502 JSON error.

**Docs:** `docs/editors.md` becomes: go to `https://www.wssl.org/admin/`, enter your email, enter the code from the email, edit, Publish. `README.md` "Before this goes live" lists the Access setup: Zero Trust → Access → Applications → Add (Self-hosted) → domain `www.wssl.org`, paths `/admin` and `/api/cms` (two applications or one with both paths), policy Allow → Emails / Emails ending in `@wssl.org`, identity provider One-time PIN; copy the **Application Audience (AUD) tag** into `CF_ACCESS_AUD` and the team domain into `CF_ACCESS_TEAM_DOMAIN`; create a fine-grained GitHub PAT (repository access: only the content repo; permissions: Contents read/write, Metadata read) as the `GITHUB_BOT_TOKEN` secret; set `GITHUB_REPO`.

**Commit:** `feat: email login via Cloudflare Access with a GitHub bot-token CMS backend` (plus a separate `chore:` commit for the removal of the OAuth flow if you prefer two commits).
