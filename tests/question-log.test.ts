import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { buildQuestionRecord, sendQuestionRecord, questionLogConfigured } from '../functions/_lib/question-log';

function sampleRecord(secret = 'topsecret') {
  return buildQuestionRecord({
    question: 'How do I register?',
    answer: 'Go to inLeague.',
    citations: [{ url: 'https://www.wssl.org/registration/' }],
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    retrieval: 'index',
    status: 'ok' as const,
    ms: 500,
    usage: { prompt_tokens: 100, candidates_tokens: 20 },
    secret,
  });
}

describe('buildQuestionRecord', () => {
  it('builds the record in field order with the given values', () => {
    const record = buildQuestionRecord({
      ts: '2026-09-09T00:00:00.000Z',
      session: 'abc-123',
      question: 'How do I register?',
      answer: 'Go to inLeague. [Registration](https://www.wssl.org/registration/)',
      citations: [{ url: 'https://www.wssl.org/registration/' }],
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      retrieval: 'index',
      status: 'ok',
      ms: 842,
      usage: { prompt_tokens: 1200, candidates_tokens: 80 },
      secret: 's3cr3t',
    });
    expect(record).toEqual({
      ts: '2026-09-09T00:00:00.000Z',
      session_id: 'abc-123',
      question: 'How do I register?',
      answer_excerpt: 'Go to inLeague. [Registration](https://www.wssl.org/registration/)',
      sources: 'https://www.wssl.org/registration/',
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      retrieval: 'index',
      status: 'ok',
      ms: 842,
      prompt_tokens: 1200,
      candidates_tokens: 80,
      secret: 's3cr3t',
    });
    expect(Object.keys(record)).toEqual([
      'ts', 'session_id', 'question', 'answer_excerpt', 'sources', 'provider', 'model', 'retrieval', 'status', 'ms', 'prompt_tokens', 'candidates_tokens', 'secret',
    ]);
  });

  it('defaults session_id to an empty string when no session is given', () => {
    const record = buildQuestionRecord(base({ session: undefined }));
    expect(record.session_id).toBe('');
  });

  it('trims and truncates the question to 2000 chars', () => {
    const record = buildQuestionRecord(base({ question: `  ${'q'.repeat(2100)}  ` }));
    expect(record.question.length).toBe(2000);
    expect(record.question).toBe('q'.repeat(2000));
  });

  it('truncates the answer excerpt to the first 2000 chars of the streamed answer', () => {
    const record = buildQuestionRecord(base({ answer: 'a'.repeat(2100) }));
    expect(record.answer_excerpt.length).toBe(2000);
    expect(record.answer_excerpt).toBe('a'.repeat(2000));
  });

  it('joins distinct cited URLs with "; ", dropping duplicates and empties', () => {
    const record = buildQuestionRecord(base({
      citations: [
        { url: 'https://www.wssl.org/a/' },
        { url: 'https://www.wssl.org/b/' },
        { url: 'https://www.wssl.org/a/' },
        { url: '' },
      ],
    }));
    expect(record.sources).toBe('https://www.wssl.org/a/; https://www.wssl.org/b/');
  });

  it('defaults token counts to 0 when usage is absent', () => {
    const record = buildQuestionRecord(base({ usage: undefined }));
    expect(record.prompt_tokens).toBe(0);
    expect(record.candidates_tokens).toBe(0);
  });

  it('defaults ts to the current time when not given', () => {
    const before = Date.now();
    const record = buildQuestionRecord(base({ ts: undefined }));
    const parsed = Date.parse(record.ts);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(Date.now());
  });

  function base(overrides: Record<string, unknown>) {
    return {
      question: 'hi',
      answer: 'hello',
      citations: [],
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      retrieval: 'index',
      status: 'ok' as const,
      ms: 100,
      usage: { prompt_tokens: 1, candidates_tokens: 1 },
      secret: 's',
      ...overrides,
    };
  }
});

describe('questionLogConfigured / sendQuestionRecord — disabled path', () => {
  it('is not configured, and logs question_log_disabled, when QUESTION_LOG_URL is unset', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(questionLogConfigured({ QUESTION_LOG_SECRET: 'x' })).toBe(false);
    expect(spy.mock.calls.some((c) => JSON.parse(c[0] as string).event === 'question_log_disabled')).toBe(true);
    spy.mockRestore();
  });

  it('is not configured when QUESTION_LOG_SECRET is unset', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(questionLogConfigured({ QUESTION_LOG_URL: 'https://script.google.com/x' })).toBe(false);
    spy.mockRestore();
  });

  it('sendQuestionRecord never calls fetch when not configured', async () => {
    const fetchImpl = vi.fn();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sendQuestionRecord({}, sampleRecord(), fetchImpl as any);
    expect(fetchImpl).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is configured when both QUESTION_LOG_URL and QUESTION_LOG_SECRET are set', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(questionLogConfigured({ QUESTION_LOG_URL: 'https://script.google.com/x', QUESTION_LOG_SECRET: 'x' })).toBe(true);
    spy.mockRestore();
  });
});

describe('sendQuestionRecord — fake fetch', () => {
  const env = { QUESTION_LOG_URL: 'https://script.google.com/macros/s/xyz/exec', QUESTION_LOG_SECRET: 'topsecret' };

  it('POSTs the record as JSON to QUESTION_LOG_URL, following redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    const record = sampleRecord();
    await sendQuestionRecord(env, record, fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(env.QUESTION_LOG_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('follow');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(record);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not log an error on a 2xx response (e.g. after following a redirect)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
    await sendQuestionRecord(env, sampleRecord(), fetchImpl as any);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('logs question_log_error when a 2xx response body is "forbidden" (wrong secret, silently accepted by Apps Script)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 200 }));
    await expect(sendQuestionRecord(env, sampleRecord(), fetchImpl as any)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.event).toBe('question_log_error');
    expect(logged.status).toBe(200);
    expect(logged.body).toBe('forbidden');
    spy.mockRestore();
  });

  it('truncates a long 2xx error body to 40 chars in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const longBody = 'x'.repeat(100);
    const fetchImpl = vi.fn(async () => new Response(longBody, { status: 200 }));
    await sendQuestionRecord(env, sampleRecord(), fetchImpl as any);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.body).toBe('x'.repeat(40));
    spy.mockRestore();
  });

  it('logs question_log_error with the status on a non-2xx response, and does not throw', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(sendQuestionRecord(env, sampleRecord(), fetchImpl as any)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.event).toBe('question_log_error');
    expect(logged.status).toBe(403);
    spy.mockRestore();
  });

  it('logs question_log_error and does not throw when fetch rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    await expect(sendQuestionRecord(env, sampleRecord(), fetchImpl as any)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged.event).toBe('question_log_error');
    spy.mockRestore();
  });

  it('never rejects even when fetch hangs past the timeout (AbortSignal.timeout fires)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(sendQuestionRecord(env, sampleRecord(), fetchImpl as any)).resolves.toBeUndefined();
    spy.mockRestore();
  }, 15_000);

});

describe('sendQuestionRecord — real ephemeral HTTP server (Apps Script 302 shape)', () => {
  it('follows a 302 redirect and delivers the exact JSON body', async () => {
    let received: any = null;
    const server = http.createServer((req, res) => {
      if (req.url === '/exec') {
        // Real Apps Script already reads e.postData.contents (doPost runs) before it answers —
        // the 302 to script.googleusercontent.com only hands back the *response*, so the
        // follow-up hop is a bodyless GET (per the fetch spec, 302 turns a POST into a GET).
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          received = JSON.parse(body);
          res.writeHead(302, { Location: '/redirected' });
          res.end();
        });
        return;
      }
      if (req.url === '/redirected') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const env = { QUESTION_LOG_URL: `http://127.0.0.1:${port}/exec`, QUESTION_LOG_SECRET: 'realsecret' };
      const record = buildQuestionRecord({
        question: 'Where are the fields?',
        answer: 'Riverside Park. [Fields](https://www.wssl.org/fields/)',
        citations: [{ url: 'https://www.wssl.org/fields/' }],
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        retrieval: 'anthropic',
        status: 'ok' as const,
        ms: 321,
        usage: { prompt_tokens: 5000, candidates_tokens: 60 },
        secret: env.QUESTION_LOG_SECRET,
      });
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await sendQuestionRecord(env, record); // real global fetch, no fetchImpl override
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(received).toEqual(record);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
