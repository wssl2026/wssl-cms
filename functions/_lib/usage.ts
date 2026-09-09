/** Increments today's counter (UTC) and reports whether the request is within the cap. */
export async function checkDailyCap(kv: KVNamespace, cap: number, now = new Date()): Promise<{ ok: boolean; count: number }> {
  const key = `chat:${now.toISOString().slice(0, 10)}`;
  const count = Number((await kv.get(key)) ?? '0') + 1;
  if (count > cap) return { ok: false, count };
  await kv.put(key, String(count), { expirationTtl: 60 * 60 * 48 });
  return { ok: true, count };
}
