/**
 * Cache aplikasi — Redis (Upstash REST) opsional, fallback in-memory per instance.
 */

import {
  buildRedisKey,
  isRedisConfigured,
  redisCommand,
} from '@/lib/api/redis-rest';

type MemoryEntry = { value: string; expiresAt: number };

const memory = new Map<string, MemoryEntry>();

export function isDistributedCacheEnabled(): boolean {
  return isRedisConfigured();
}

export function buildCacheKey(...parts: string[]): string {
  return buildRedisKey(...parts);
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  if (isRedisConfigured()) {
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

  if (isRedisConfigured()) {
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
  if (isRedisConfigured()) {
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

  if (isRedisConfigured()) {
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

export async function cacheDelByPattern(pattern: string): Promise<void> {
  const match = pattern.includes(':') ? pattern : buildCacheKey(pattern);
  if (isRedisConfigured()) {
    try {
      let cursor = '0';
      do {
        const result = await redisCommand(['SCAN', cursor, 'MATCH', match, 'COUNT', 100]);
        if (!Array.isArray(result) || result.length < 2) break;
        cursor = String(result[0]);
        const keys = Array.isArray(result[1]) ? result[1].map(String) : [];
        if (keys.length) await cacheDelMany(keys);
      } while (cursor !== '0');
    } catch {
      /* ignore */
    }
  }
  for (const key of [...memory.keys()]) {
    const glob = match.replace(/\*/g, '.*');
    if (new RegExp(`^${glob}$`).test(key)) memory.delete(key);
  }
}
