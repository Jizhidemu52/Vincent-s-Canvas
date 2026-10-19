import type { Cache } from "./db";

export const READY_QUEUE = "tasks:queue";
export const DELAYED_QUEUE = "tasks:delayed";
const DELAYED_PRIORITY = "tasks:delayed:priority";

// Atomic scheduling prevents a task from being present in both queues. The
// delayed score is a real wall-clock deadline, never a priority-weighted value.
const scheduleScript = `
local id, due, now, score = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
redis.call('ZREM', KEYS[1], id)
redis.call('ZREM', KEYS[2], id)
redis.call('HDEL', KEYS[3], id)
if due > now then
  redis.call('ZADD', KEYS[2], due, id)
  redis.call('HSET', KEYS[3], id, score)
else
  redis.call('ZADD', KEYS[1], score, id)
end
return 1`;

const popScript = `
local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 128)
for _, id in ipairs(due) do
  local score = redis.call('HGET', KEYS[3], id)
  redis.call('ZREM', KEYS[2], id)
  redis.call('HDEL', KEYS[3], id)
  if score then redis.call('ZADD', KEYS[1], score, id) end
end
local item = redis.call('ZPOPMIN', KEYS[1], 1)
return item[1] or false`;

const removeScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
return 1`;

const keys = [READY_QUEUE, DELAYED_QUEUE, DELAYED_PRIORITY];

export async function scheduleQueuedTask(cache: Cache, id: string, readyScore: number, availableAt = Date.now(), now = Date.now()) {
  await cache.eval(scheduleScript, { keys, arguments: [id, String(availableAt), String(now), String(readyScore)] });
}

export async function popReadyTask(cache: Cache, now = Date.now()): Promise<string | null> {
  const result = await cache.eval(popScript, { keys, arguments: [String(now)] });
  return typeof result === "string" ? result : null;
}

export async function removeQueuedTask(cache: Cache, id: string) {
  await cache.eval(removeScript, { keys, arguments: [id] });
}
