/**
 * Upstash Redis REST — shared oleh app-cache & rate limit (distributed antar lambda).
 * Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN di Vercel production.
 */

export function isRedisConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL?.trim()
    && process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  );
}

export function isDistributedRateLimitEnabled(): boolean {
  return isRedisConfigured();
}

/** Production wajib Redis untuk cache shared antar lambda (P0.2b). */
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
