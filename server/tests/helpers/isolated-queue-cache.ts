import { randomUUID } from "node:crypto";
import { createCache, type Cache } from "../../src/db";

/** Prefix-scoped disposable keys; never flushes an existing Redis database. */
export async function createIsolatedQueueCache() {
  const url = process.env.QUEUE_TEST_REDIS_URL;
  if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("QUEUE_TEST_REDIS_URL must name an isolated loopback Redis fixture");
  }
  const client = await createCache(url);
  const prefix = `queue-fixture:${randomUUID()}:`;
  const touched = new Set<string>();
  const key = (value: string) => { const full = prefix + value; touched.add(full); return full; };
  const cache: Cache = {
    get: value => client.get(key(value)),
    set: (value, content, options) => client.set(key(value), content, options),
    del: value => client.del(key(value)),
    ping: () => client.ping(),
    quit: () => client.quit(),
    zAdd: (value, content) => client.zAdd(key(value), content),
    zRem: (value, content) => client.zRem(key(value), content),
    zPopMin: value => client.zPopMin(key(value)),
    incr: value => client.incr(key(value)),
    decr: value => client.decr(key(value)),
    expire: (value, seconds) => client.expire(key(value), seconds),
    eval: (script, options) => client.eval(script, { ...options, keys: options.keys.map(key) }),
  };
  const clear = async () => { if (touched.size) await client.del([...touched]); };
  return { cache, clear, zCard: (name: string) => client.zCard(key(name)), close: async () => { await clear(); client.destroy(); } };
}
