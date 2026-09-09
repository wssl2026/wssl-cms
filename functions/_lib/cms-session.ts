/**
 * The editor session token that Sveltia CMS carries in place of a GitHub token.
 *
 * Sveltia is a browser app: it expects to hold an API credential and to send it as
 * `Authorization: token …` on every call. It must never hold the bot token, so
 * `/api/cms/auth` hands it this instead — an opaque, signed statement of *who the
 * Cloudflare Access session belongs to* and *for how long*. The GitHub proxy checks it
 * against the Access JWT on the same request and swaps it for the bot token upstream.
 *
 * The token is `base64url(JSON{email,exp})` + `.` + `base64url(HMAC-SHA256(payload))`,
 * signed with the `CMS_SESSION_SECRET` Pages secret. It carries no GitHub credential and
 * grants nothing on its own: without an Access JWT for the same email it is refused.
 * WebCrypto keeps it working unchanged on Workers and on Node ≥ 20 under vitest.
 */

/** Eight hours: longer than an editing session, shorter than a working day left unlocked. */
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionIdentity {
  email: string;
}

export interface VerifySessionOptions {
  /** Injected in tests; defaults to now. */
  now?: Date;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns `null` for anything that is not valid base64url, so callers never throw on junk. */
function bytesFromBase64url(value: string): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function sign(payload: string, secret: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return new Uint8Array(signature);
}

/**
 * Compares two signatures without letting the time taken reveal how much of a forged one
 * was right. `crypto.subtle.verify` would do this too, but it needs a second key import
 * with the `verify` usage; this keeps the key handling in one place.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Signs `{ email, exp }` for the given editor. Throws only on a caller mistake. */
export async function mintSession(
  email: string,
  secret: string,
  ttlSeconds: number = DEFAULT_SESSION_TTL_SECONDS,
): Promise<string> {
  if (!email) throw new Error('mintSession: an email is required');
  if (!secret) throw new Error('mintSession: a signing secret is required');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = base64urlFromBytes(encoder.encode(JSON.stringify({ email, exp })));
  return `${payload}.${base64urlFromBytes(await sign(payload, secret))}`;
}

/**
 * Resolves to the editor the token was minted for, or `null`. Every failure — a bad
 * signature, an edited payload, an expired session, a token that is not a token at all —
 * is the same `null`, so callers turn all of them into one 401.
 */
export async function verifySession(
  token: string,
  secret: string,
  { now = new Date() }: VerifySessionOptions = {},
): Promise<SessionIdentity | null> {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;

  const provided = bytesFromBase64url(signature);
  if (!provided) return null;
  if (!equalBytes(provided, await sign(payload, secret))) return null;

  const raw = bytesFromBase64url(payload);
  if (!raw) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;

  const { email, exp } = claims as { email?: unknown; exp?: unknown };
  if (typeof email !== 'string' || !email) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (Math.floor(now.getTime() / 1000) >= exp) return null;

  return { email };
}
