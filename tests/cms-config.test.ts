import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { PAGE_FIELD_NAMES } from '../src/lib/page-schema';

const config = parse(readFileSync('public/admin/config.yml', 'utf8'));

describe('Decap config', () => {
  it('declares the github backend as a fallback, with no OAuth endpoint of its own', () => {
    expect(config.backend.name).toBe('github');
    expect(config.backend.branch).toBe('main');
    // Editors sign in through Cloudflare Access, not GitHub OAuth.
    expect(config.backend.auth_endpoint).toBeUndefined();
    expect(config.backend.base_url).toBeUndefined();
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
  it('does not ship local_backend in the production config', () => {
    expect(config.local_backend).toBeUndefined();
  });
});

describe('Decap admin page', () => {
  it('manually initializes CMS and keeps decap-server as the localhost backend', () => {
    const html = readFileSync('public/admin/index.html', 'utf8');
    expect(html).toContain('CMS_MANUAL_INIT = true');
    expect(html).toContain('local_backend: true');
  });
  it('points the deployed editor at the Access-protected proxy on its own origin', () => {
    const html = readFileSync('public/admin/index.html', 'utf8');
    expect(html).toContain("window.location.origin + '/api/cms/v1'");
    expect(html).toContain('allowed_hosts: [window.location.hostname]');
  });
  it('keeps every trace of the retired GitHub OAuth flow out of the editor', () => {
    const html = readFileSync('public/admin/index.html', 'utf8');
    expect(html).not.toContain('/api/auth');
    expect(html).not.toContain('/api/callback');
  });
  it('loads Decap from an exact pinned version, never a floating range', () => {
    const html = readFileSync('public/admin/index.html', 'utf8');
    expect(html).toMatch(/decap-cms@\d+\.\d+\.\d+\/dist\/decap-cms\.js/);
    expect(html).not.toContain('decap-cms@^');
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
