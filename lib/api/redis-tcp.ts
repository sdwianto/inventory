/**
 * Redis TCP (ioredis) for VPS — used when Upstash REST is not configured.
 */

import Redis from 'ioredis';

let client: Redis | null = null;

export function isRedisTcpConfigured(): boolean {
  return !!process.env.REDIS_URL?.trim();
}

export function getRedisTcpClient(): Redis | null {
  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;
  if (!client) {
    client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      retryStrategy(times) {
        return Math.min(times * 200, 5_000);
      },
    });
    client.on('error', (err) => {
      console.warn('[redis-tcp] error', err?.message || err);
    });
  }
  return client;
}

/** Run a small subset of Redis commands used by app-cache / rate-limit. */
export async function redisTcpCommand(command: (string | number)[]): Promise<unknown> {
  const redis = getRedisTcpClient();
  if (!redis) return null;
  const [rawCmd, ...args] = command;
  const cmd = String(rawCmd || '').toUpperCase();
  try {
    if (cmd === 'GET') return redis.get(String(args[0]));
    if (cmd === 'DEL') return redis.del(...args.map(String));
    if (cmd === 'SET') {
      const key = String(args[0]);
      const value = String(args[1]);
      if (String(args[2]).toUpperCase() === 'EX' && args[3] != null) {
        return redis.set(key, value, 'EX', Number(args[3]));
      }
      return redis.set(key, value);
    }
    if (cmd === 'SCAN') {
      const cursor = String(args[0] ?? '0');
      const matchIdx = args.findIndex((a) => String(a).toUpperCase() === 'MATCH');
      const countIdx = args.findIndex((a) => String(a).toUpperCase() === 'COUNT');
      const match = matchIdx >= 0 ? String(args[matchIdx + 1]) : undefined;
      const count = countIdx >= 0 ? Number(args[countIdx + 1]) : 100;
      const [next, keys] = await redis.scan(cursor, 'MATCH', match || '*', 'COUNT', count);
      return [next, keys];
    }
    return null;
  } catch (err) {
    console.warn('[redis-tcp] command failed', cmd, err instanceof Error ? err.message : err);
    return null;
  }
}
