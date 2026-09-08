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
