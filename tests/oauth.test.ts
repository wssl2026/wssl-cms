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
    expect(res.headers.get('Set-Cookie')).toContain('decap_oauth_state=;');
  });
  it('returns 502 and clears the state cookie when GitHub cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const req = new Request('https://www.wssl.org/api/callback?code=abc&state=one', { headers: { Cookie: 'decap_oauth_state=one' } });
    const res = await callback(ctx(req));
    expect(res.status).toBe(502);
    expect(res.headers.get('Set-Cookie')).toContain('decap_oauth_state=;');
    vi.unstubAllGlobals();
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
  it('only accepts a reply from the popup opener', () => {
    expect(callbackHtml('github', { token: 't', provider: 'github' })).toContain('e.source !== window.opener');
  });
});
