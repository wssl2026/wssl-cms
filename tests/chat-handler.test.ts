import { describe, it, expect } from 'vitest';
import { onRequestPost } from '../functions/api/chat';

// NOTE: npm run corpus must have run to generate functions/_lib/corpus.json

describe('POST /api/chat handler', () => {
  function makeFakeContext(
    request: Request,
    env: { ANTHROPIC_API_KEY: string; USAGE: any; DAILY_CAP?: string }
  ) {
    return {
      request,
      env,
      params: {},
      data: {},
      waitUntil() {},
      passThroughOnException() {},
      next: async () => new Response(),
    } as any;
  }

  function makeRequest(
    url: string,
    body: unknown,
    origin?: string
  ): Request {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (origin) headers.set('Origin', origin);
    return new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('POST without an Origin header → 403', async () => {
    const kv = { get: async () => null, put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const request = makeRequest('https://example.com/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    // No Origin header set
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('forbidden');
  });

  it('POST with Origin: https://evil.example → 403', async () => {
    const kv = { get: async () => null, put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const request = makeRequest(
      'https://example.com/api/chat',
      { messages: [{ role: 'user', content: 'hi' }] },
      'https://evil.example'
    );
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('forbidden');
  });

  it('POST with matching Origin but KV down → 503 with "temporarily unavailable"', async () => {
    const kv = {
      get: async () => {
        throw new Error('kv down');
      },
      put: async () => {},
    } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const url = 'https://example.com/api/chat';
    const request = makeRequest(
      url,
      { messages: [{ role: 'user', content: 'hi' }] },
      'https://example.com' // matching origin
    );
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain('temporarily unavailable');
  });

  it('POST with matching Origin but empty messages → 400 (regression guard)', async () => {
    const kv = { get: async () => null, put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const url = 'https://example.com/api/chat';
    const request = makeRequest(
      url,
      { messages: [] },
      'https://example.com' // matching origin
    );
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('messages must be a non-empty array');
  });
});
