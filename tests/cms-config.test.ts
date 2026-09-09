import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { PAGE_FIELD_NAMES } from '../src/lib/page-schema';

const config = parse(readFileSync('public/admin/config.yml', 'utf8'));
const html = readFileSync('public/admin/index.html', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
/** Sveltia ships the JSON schema for its own config file; option names are checked against it. */
const schema = JSON.parse(readFileSync('node_modules/@sveltia/cms/schema/sveltia-cms.json', 'utf8'));

describe('Sveltia config', () => {
  it('uses the github backend against the content repository', () => {
    expect(config.backend.name).toBe('github');
    expect(config.backend.repo).toBe('wssl2026/wssl-cms');
    expect(config.backend.branch).toBe('main');
  });
  it('points sign-in at our Access-protected handshake, not at GitHub OAuth', () => {
    expect(config.backend.auth_endpoint).toBe('api/cms/auth');
    expect(config.backend.auth_methods).toEqual(['oauth']);
    // No personal-access-token dialog: the proxy would refuse a real GitHub token.
    expect(config.backend.auth_methods).not.toContain('token');
    expect(config.backend.app_id).toBeUndefined();
  });
  it('leaves the origin-dependent endpoints to the page, so every host works', () => {
    expect(config.backend.base_url).toBeUndefined();
    expect(config.backend.api_root).toBeUndefined();
  });
  it('only uses option names Sveltia knows', () => {
    const rootProps = Object.keys(schema.definitions.CmsConfig.properties);
    expect(Object.keys(config).filter((key) => !rootProps.includes(key))).toEqual([]);
    const backendProps = Object.keys(schema.definitions.GitHubBackend.properties);
    expect(Object.keys(config.backend).filter((key) => !backendProps.includes(key))).toEqual([]);
  });
  it('publishes straight to the branch, with no editorial workflow', () => {
    expect(config.publish_mode).toBe('simple');
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
    expect(settings.files.map((f: any) => f.file).sort()).toEqual(['src/data/alerts.json', 'src/data/home.json', 'src/data/nav.json', 'src/data/site.json']);
  });
  it('the home settings file edits the home page fields', () => {
    const settings = config.collections.find((c: any) => c.name === 'settings');
    const home = settings.files.find((f: any) => f.file === 'src/data/home.json');
    expect(home.fields.map((f: any) => f.name)).toEqual(['fieldStatus', 'carousel', 'programButtons', 'cards']);
  });
  it('ships no local_backend — Sveltia ignores it and warns', () => {
    expect(config.local_backend).toBeUndefined();
  });
});

describe('Sveltia admin page', () => {
  it('loads the editor from our own origin, never a CDN', () => {
    expect(html).toContain('<script src="/admin/sveltia-cms.js"></script>');
    expect(html).not.toContain('//unpkg.com');
    expect(html).not.toContain('//cdn.');
    expect(html).not.toMatch(/<script[^>]+src="https?:/);
  });
  it('pins the editor to an exact version, never a floating range', () => {
    expect(pkg.dependencies['@sveltia/cms']).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('vendors that bundle as part of the build, and keeps the copy out of git', () => {
    expect(pkg.scripts.build).toContain('scripts/copy-sveltia.ts');
    expect(readFileSync('.gitignore', 'utf8')).toContain('public/admin/sveltia-cms.js');
  });
  it('points the editor at the Access-protected proxy on its own origin', () => {
    expect(html).toContain('CMS_MANUAL_INIT = true');
    expect(html).toContain("base_url: window.location.origin");
    expect(html).toContain("api_root: window.location.origin + '/api/cms/gh'");
  });
  it('tells Sveltia where the config file is', () => {
    expect(html).toContain('rel="cms-config-url"');
    expect(html).toContain('/admin/config.yml');
  });
  it('keeps the editor out of search results', () => {
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });
  it('keeps every trace of Decap and of the retired GitHub OAuth flow out of the editor', () => {
    expect(html).not.toContain('decap');
    expect(html).not.toContain('local_backend');
    expect(html).not.toContain('/api/cms/v1');
    expect(html).not.toContain('/api/auth');
    expect(html).not.toContain('/api/callback');
  });
  it('does not load the stylesheet or module attribute Sveltia warns about', () => {
    expect(html).not.toContain('sveltia-cms.css');
    expect(html).not.toMatch(/<script[^>]*type="module"[^>]*sveltia/);
  });
});

describe('public/_headers', () => {
  it('sets the baseline security headers and keeps the CMS API uncached', () => {
    const headers = readFileSync('public/_headers', 'utf8');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toMatch(/\/api\/cms\/\*\n\s+Cache-Control: no-store/);
    expect(headers).not.toContain('/api/callback');
  });
});
