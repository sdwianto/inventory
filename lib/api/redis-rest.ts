/**
 * Redis for app-cache & rate limit:
 * - Vercel / serverless: Upstash REST (UPSTASH_REDIS_REST_URL + TOKEN)
 * - VPS: REDIS_URL via TCP (ioredis) when Upstash is not set
 */

import { isRedisTcpConfigured, redisTcpCommand } from '@/lib/api/redis-tcp';

function isUpstashConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL?.trim()
    && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

export function isRedisConfigured(): boolean {
  return isUpstashConfigured() || isRedisTcpConfigured();
}

export function isDistributedRateLimitEnabled(): boolean {
  return isRedisConfigured();
}

/** Production wajib Redis untuk cache shared antar lambda / VPS instances (P0.2b). */
export function requiresDistributedCache(): boolean {
  return process.env.NODE_ENV === 'production'
    || process.env.REQUIRE_REDIS_CACHE === '1';
}

export function distributedCacheHealthStatus(): 'ok' | 'fail' | 'skipped' {
  if (!requiresDistributedCache()) {
    return isRedisConfigured() ? 'ok' : 'skipped';
  }
  return isRedisConfigured() ? 'ok' : 'fail';
}

function keyPrefix(): string {
  return (process.env.APP_CACHE_PREFIX || 'inventory').trim();
}

export function buildRedisKey(...parts: string[]): string {
  return `${keyPrefix()}:${parts.join(':')}`;
}

export async function redisCommand(command: (string | number)[]): Promise<unknown> {
  if (isUpstashConfigured()) {
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
  return redisTcpCommand(command);
}
