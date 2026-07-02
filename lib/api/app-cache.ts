/**
 * Cache aplikasi — Redis (Upstash REST) opsional, fallback in-memory per instance.
 * Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN di Vercel untuk cache shared antar lambda.
 */

type MemoryEntry = { value: string; expiresAt: number };

const memory = new Map<string, MemoryEntry>();

function redisConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL?.trim()
    && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

async function redisCommand(command: (string | number)[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL!.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { result?: unknown };
  return data.result ?? null;
}

function prefix(): string {
  return (process.env.APP_CACHE_PREFIX || 'inventory').trim();
}

export function isDistributedCacheEnabled(): boolean {
  return redisConfigured();
}

export function buildCacheKey(...parts: string[]): string {
  return `${prefix()}:${parts.join(':')}`;
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (redisConfigured()) {
    try {
      const raw = await redisCommand(['GET', key]);
      if (raw == null) return null;
      return JSON.parse(String(raw)) as T;
    } catch {
      /* fallback memory */
    }
  }

  const hit = memory.get(key);
  if (!hit || hit.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  try {
    return JSON.parse(hit.value) as T;
  } catch {
    memory.delete(key);
    return null;
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  const serialized = JSON.stringify(value);
  const ttl = Math.max(1, Math.floor(ttlSec));

  if (redisConfigured()) {
    try {
      await redisCommand(['SET', key, serialized, 'EX', ttl]);
      return;
    } catch {
      /* fallback memory */
    }
  }

  memory.set(key, { value: serialized, expiresAt: Date.now() + ttl * 1000 });
}

export async function cacheDel(key: string): Promise<void> {
  if (redisConfigured()) {
    try {
      await redisCommand(['DEL', key]);
    } catch {
      /* ignore */
    }
  }
  memory.delete(key);
}

export async function cacheDelMany(keys: string[]): Promise<void> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return;

  if (redisConfigured()) {
    try {
      await redisCommand(['DEL', ...unique]);
    } catch {
      /* ignore */
    }
  }
  for (const key of unique) memory.delete(key);
}

export function clearLocalMemoryCache(): void {
  memory.clear();
}
