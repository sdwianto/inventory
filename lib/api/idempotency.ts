/**
 * Server-side idempotency untuk replay offline queue (header Idempotency-Key).
 */
import { createHash } from 'crypto';
import type { Db } from 'mongodb';
import { NextResponse } from 'next/server';
import { cors, err } from '@/lib/api/db';

const TTL_SEC = 72 * 60 * 60;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH']);

type IdempotencyDoc = {
  _id: string;
  tenantId: string;
  route: string;
  method: string;
  key: string;
  bodyHash?: string;
  status?: number;
  response?: unknown;
  createdAt: Date;
};

let indexesDone = false;

function hashBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

function scopedId(tenantId: string, method: string, route: string, key: string): string {
  return `${tenantId}:${method}:${route}:${key}`;
}

async function ensureIndexes(db: Db): Promise<void> {
  if (indexesDone) return;
  try {
    await db.collection('idempotency_keys').createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: TTL_SEC, name: 'ttl_idempotency_keys' },
    );
  } catch {
    /* index may already exist */
  }
  indexesDone = true;
}

export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get('Idempotency-Key') || request.headers.get('idempotency-key');
  const key = (raw || '').trim();
  if (!key || key.length > 128) return null;
  return key;
}

export function isIdempotentMutation(method: string, key: string | null): boolean {
  return Boolean(key && MUTATION_METHODS.has(method));
}

export async function replayIdempotentResponse(
  db: Db,
  tenantId: string,
  route: string,
  method: string,
  key: string,
  body: unknown,
): Promise<NextResponse | null> {
  await ensureIndexes(db);
  const _id = scopedId(tenantId, method, route, key);
  const row = await db.collection<IdempotencyDoc>('idempotency_keys').findOne({ _id });
  if (!row) return null;

  const bodyHash = hashBody(body);
  if (row.bodyHash && row.bodyHash !== bodyHash) {
    return err('Konflik idempotency — permintaan berbeda dari yang sudah diproses', 409);
  }

  if (row.response != null && typeof row.status === 'number' && row.status >= 200 && row.status < 300) {
    return cors(NextResponse.json(row.response, { status: row.status }));
  }

  return null;
}

export async function storeIdempotentResponse(
  db: Db,
  tenantId: string,
  route: string,
  method: string,
  key: string,
  body: unknown,
  response: NextResponse,
): Promise<NextResponse> {
  const status = response.status;
  if (status < 200 || status >= 300) return response;

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    return response;
  }

  await ensureIndexes(db);
  const _id = scopedId(tenantId, method, route, key);
  const bodyHash = hashBody(body);

  try {
    await db.collection<IdempotencyDoc>('idempotency_keys').updateOne(
      { _id },
      {
        $set: {
          tenantId,
          route,
          method,
          key,
          bodyHash,
          status,
          response: parsed,
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch {
    const existing = await db.collection<IdempotencyDoc>('idempotency_keys').findOne({ _id });
    if (existing?.bodyHash && existing.bodyHash !== bodyHash) {
      return err('Konflik idempotency — permintaan berbeda dari yang sudah diproses', 409);
    }
    if (existing?.response != null && typeof existing.status === 'number' && existing.status >= 200 && existing.status < 300) {
      return cors(NextResponse.json(existing.response, { status: existing.status }));
    }
  }

  return response;
}
