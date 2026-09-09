import { describe, it, expect } from 'vitest';
import { mintSession, verifySession, DEFAULT_SESSION_TTL_SECONDS } from '../functions/_lib/cms-session';

const SECRET = 'a-long-random-cms-session-secret';
const EMAIL = 'editor@wssl.org';

describe('cms session tokens', () => {
  it('mints a token the same secret verifies back to the email', async () => {
    const token = await mintSession(EMAIL, SECRET);
    await expect(verifySession(token, SECRET)).resolves.toEqual({ email: EMAIL });
  });

  it('is two base64url segments and carries no readable secret', async () => {
    const token = await mintSession(EMAIL, SECRET);
    const [payload, signature, ...rest] = token.split('.');
    expect(rest).toHaveLength(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      email: EMAIL,
      exp: expect.any(Number),
    });
    expect(signature.length).toBeGreaterThan(20);
    expect(token).not.toContain(SECRET);
  });

  it('defaults to an eight-hour lifetime', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await mintSession(EMAIL, SECRET);
    const { exp } = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
    expect(DEFAULT_SESSION_TTL_SECONDS).toBe(8 * 60 * 60);
    expect(exp).toBeGreaterThanOrEqual(before + DEFAULT_SESSION_TTL_SECONDS);
    expect(exp).toBeLessThanOrEqual(before + DEFAULT_SESSION_TTL_SECONDS + 5);
  });

  it('rejects a token signed with another secret', async () => {
    const token = await mintSession(EMAIL, SECRET);
    await expect(verifySession(token, 'some-other-secret')).resolves.toBeNull();
  });

  it('rejects a token whose payload was edited to another email', async () => {
    const token = await mintSession(EMAIL, SECRET);
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ email: 'attacker@example.com', exp: 2_000_000_000 }), 'utf8')
      .toString('base64url');
    await expect(verifySession(`${forged}.${signature}`, SECRET)).resolves.toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await mintSession(EMAIL, SECRET, 60);
    const now = new Date(Date.now() + 61_000);
    await expect(verifySession(token, SECRET, { now })).resolves.toBeNull();
  });

  it('accepts a token that has not expired yet', async () => {
    const token = await mintSession(EMAIL, SECRET, 60);
    const now = new Date(Date.now() + 30_000);
    await expect(verifySession(token, SECRET, { now })).resolves.toEqual({ email: EMAIL });
  });

  it('rejects malformed, empty and truncated tokens instead of throwing', async () => {
    for (const bad of ['', '.', 'not-a-token', 'a.b', 'a.b.c', '%%%.%%%']) {
      await expect(verifySession(bad, SECRET)).resolves.toBeNull();
    }
    const token = await mintSession(EMAIL, SECRET);
    await expect(verifySession(token.slice(0, -2), SECRET)).resolves.toBeNull();
    await expect(verifySession(token.split('.')[0], SECRET)).resolves.toBeNull();
  });

  it('rejects a payload that is JSON but not a session', async () => {
    // Signed with the right secret, so only the payload shape can refuse it.
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 }), 'utf8').toString('base64url');
    const signed = await mintSession(EMAIL, SECRET);
    await expect(verifySession(`${payload}.${signed.split('.')[1]}`, SECRET)).resolves.toBeNull();
  });

  it('refuses to mint without an email or a secret', async () => {
    await expect(mintSession('', SECRET)).rejects.toThrow();
    await expect(mintSession(EMAIL, '')).rejects.toThrow();
  });

  it('verifies to null when the secret is empty rather than trusting anything', async () => {
    const token = await mintSession(EMAIL, SECRET);
    await expect(verifySession(token, '')).resolves.toBeNull();
  });

  it('gives two editors different tokens', async () => {
    const a = await mintSession('a@wssl.org', SECRET);
    const b = await mintSession('b@wssl.org', SECRET);
    expect(a).not.toBe(b);
    await expect(verifySession(a, SECRET)).resolves.toEqual({ email: 'a@wssl.org' });
    await expect(verifySession(b, SECRET)).resolves.toEqual({ email: 'b@wssl.org' });
  });
});
