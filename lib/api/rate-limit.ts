/** In-memory fixed-window rate limiter (per instance). */

import { err } from '@/lib/api/db';
import type { NextResponse } from 'next/server';

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

const DEFAULT_LOGIN_MAX = 20;
const DEFAULT_WINDOW_MS = 60_000;

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

export function checkRateLimit(
  key: string,
  max?: number,
  windowMs?: number,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const limit = max ?? parsePositiveInt(process.env.RATE_LIMIT_LOGIN_MAX, DEFAULT_LOGIN_MAX);
  const window = windowMs ?? parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  const now = Date.now();

  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + window };
    buckets.set(key, bucket);
  }

  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  bucket.count += 1;
  return { allowed: true };
}

export function rateLimitResponse(retryAfterSec: number, message = 'Terlalu banyak permintaan. Coba lagi nanti.'): NextResponse {
  const res = err(message, 429);
  res.headers.set('Retry-After', String(retryAfterSec));
  return res;
}

/** Reset store — hanya untuk unit test. */
export function _resetRateLimitStoreForTests(): void {
  buckets.clear();
}
