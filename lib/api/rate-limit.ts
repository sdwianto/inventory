/**
 * Fixed-window rate limiter — Redis (Upstash) in production, in-memory fallback in dev.
 */

import { err } from '@/lib/api/db';
import type { NextResponse } from 'next/server';
import {
  buildRedisKey,
  isRedisConfigured,
  isDistributedRateLimitEnabled,
  redisCommand,
} from '@/lib/api/redis-rest';

export { isDistributedRateLimitEnabled };

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

const DEFAULT_LOGIN_MAX = 20;
const DEFAULT_WINDOW_MS = 60_000;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function checkRateLimitMemory(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  bucket.count += 1;
  return { allowed: true };
}

async function checkRateLimitRedis(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const redisKey = buildRedisKey('rl', key);
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  const countRaw = await redisCommand(['INCR', redisKey]);
  const count = Number(countRaw) || 0;
  if (count === 1) {
    await redisCommand(['EXPIRE', redisKey, windowSec]);
  }
  if (count > limit) {
    const ttlRaw = await redisCommand(['TTL', redisKey]);
    const ttl = Number(ttlRaw);
    const retryAfterSec = Number.isFinite(ttl) && ttl > 0 ? ttl : windowSec;
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

export async function checkRateLimit(
  key: string,
  max?: number,
  windowMs?: number,
): Promise<RateLimitResult> {
  const limit = max ?? parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, DEFAULT_LOGIN_MAX);
  const window = windowMs ?? parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);

  if (isRedisConfigured()) {
    try {
      return await checkRateLimitRedis(key, limit, window);
    } catch {
      /* fallback memory */
    }
  }

  return checkRateLimitMemory(key, limit, window);
}

export function rateLimitResponse(retryAfterSec: number, message = 'Terlalu banyak permintaan. Coba lagi nanti.'): NextResponse {
  const res = err(message, 429);
  res.headers.set('Retry-After', String(retryAfterSec));
  return res;
}

/** Reset in-memory store — unit tests only. */
export function _resetRateLimitStoreForTests(): void {
  buckets.clear();
}
