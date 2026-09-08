import { describe, it, expect } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { verifyAccessJwt } from '../functions/_lib/access-jwt';

const TEAM_DOMAIN = 'wssl.cloudflareaccess.com';
const AUD = 'aud-tag-0123456789abcdef';
const CERTS_URL = `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`;

async function makeIdentity() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'kid-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const calls: string[] = [];
  // Serves the JWKS the way Cloudflare Access does, and records every fetch so the
  // tests can prove no verification path escapes the injected fetch.
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  async function sign(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string | number } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
      .setIssuedAt()
      .setIssuer(opts.iss ?? `https://${TEAM_DOMAIN}`)
      .setAudience(opts.aud ?? AUD)
      .setExpirationTime(opts.exp ?? '1h')
      .sign(privateKey);
  }

  return { sign, fetchImpl, calls };
}

describe('verifyAccessJwt', () => {
  it('returns the email claim for a token signed by the team JWKS', async () => {
    const { sign, fetchImpl, calls } = await makeIdentity();
    const token = await sign({ email: 'editor@wssl.org' });

    const result = await verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl });

    expect(result).toEqual({ email: 'editor@wssl.org' });
    expect(calls).toEqual([CERTS_URL]);
  });

  it('accepts a team domain written with a scheme', async () => {
    const { sign, fetchImpl, calls } = await makeIdentity();
    const token = await sign({ email: 'editor@wssl.org' });

    const result = await verifyAccessJwt(token, { teamDomain: `https://${TEAM_DOMAIN}/`, aud: AUD, fetchImpl });

    expect(result.email).toBe('editor@wssl.org');
    expect(calls).toEqual([CERTS_URL]);
  });

  it('rejects a token minted for a different Access application (aud)', async () => {
    const { sign, fetchImpl } = await makeIdentity();
    const token = await sign({ email: 'editor@wssl.org' }, { aud: 'some-other-application' });

    await expect(verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl })).rejects.toThrow();
  });

  it('rejects a token from a different team domain (issuer)', async () => {
    const { sign, fetchImpl } = await makeIdentity();
    const token = await sign({ email: 'editor@wssl.org' }, { iss: 'https://attacker.cloudflareaccess.com' });

    await expect(verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl })).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { sign, fetchImpl } = await makeIdentity();
    const token = await sign({ email: 'editor@wssl.org' }, { exp: Math.floor(Date.now() / 1000) - 60 });

    await expect(verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl })).rejects.toThrow();
  });

  it('rejects a token that is not yet valid at the supplied time', async () => {
    const { sign, fetchImpl } = await makeIdentity();
    const token = await sign({ email: 'editor@wssl.org' });
    const wayLater = new Date(Date.now() + 3 * 60 * 60 * 1000);

    await expect(
      verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl, now: wayLater }),
    ).rejects.toThrow();
  });

  it('rejects a token with no email claim', async () => {
    const { sign, fetchImpl } = await makeIdentity();
    const token = await sign({ sub: 'no-email-here' });

    await expect(verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl })).rejects.toThrow(/email/i);
  });

  it('rejects a token signed by a key the team JWKS does not publish', async () => {
    const { fetchImpl } = await makeIdentity();
    const stranger = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({ email: 'editor@wssl.org' })
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-1' })
      .setIssuedAt()
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setExpirationTime('1h')
      .sign(stranger.privateKey);

    await expect(verifyAccessJwt(token, { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl })).rejects.toThrow();
  });

  it('rejects garbage that is not a JWT at all', async () => {
    const { fetchImpl } = await makeIdentity();
    await expect(
      verifyAccessJwt('not-a-token', { teamDomain: TEAM_DOMAIN, aud: AUD, fetchImpl }),
    ).rejects.toThrow();
  });
});
