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
  it('does not ship local_backend in the production config', () => {
    expect(config.local_backend).toBeUndefined();
  });
});

describe('Decap admin page', () => {
  it('manually initializes CMS and gates local_backend to localhost', () => {
    const html = readFileSync('public/admin/index.html', 'utf8');
    expect(html).toContain('CMS_MANUAL_INIT = true');
    expect(html).toContain('local_backend: true');
  });
  it('loads Decap from an exact pinned version, never a floating range', () => {
    const html = readFileSync('public/admin/index.html', 'utf8');
    expect(html).toMatch(/decap-cms@\d+\.\d+\.\d+\/dist\/decap-cms\.js/);
    expect(html).not.toContain('decap-cms@^');
  });
});

describe('public/_headers', () => {
  it('sets the baseline security headers and keeps the OAuth callback uncached', () => {
    const headers = readFileSync('public/_headers', 'utf8');
    expect(headers).toContain('X-Content-Type-Options: nosniff');
    expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
    expect(headers).toContain('X-Frame-Options: DENY');
    expect(headers).toMatch(/\/api\/callback\n\s+Cache-Control: no-store/);
  });
});
