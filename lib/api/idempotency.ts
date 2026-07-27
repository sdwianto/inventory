/**
 * Server-side idempotency untuk online mutations + offline queue (header Idempotency-Key).
 * Thin claim (insertOne pending) mencegah concurrent same-key POST membuat dua dokumen.
 */
import { createHash } from 'crypto';
import type { Collection, Db } from 'mongodb';
import { NextResponse } from 'next/server';
import { cors, err } from '@/lib/api/db';

const TTL_SEC = 72 * 60 * 60;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const PENDING_WAIT_MS = 50;
const PENDING_RETRIES = 20; // ~1s

type IdempotencyPhase = 'pending' | 'completed';

type IdempotencyDoc = {
  _id: string;
  tenantId: string;
  route: string;
  method: string;
  key: string;
  bodyHash?: string;
  phase?: IdempotencyPhase;
  status?: number;
  response?: unknown;
  createdAt: Date;
};

export type ClaimIdempotencyResult =
  | { kind: 'proceed' }
  | { kind: 'replay'; response: NextResponse };

let indexesDone = false;

export function hashIdempotencyBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

export function scopedIdempotencyId(
  tenantId: string,
  method: string,
  route: string,
  key: string,
): string {
  return `${tenantId}:${method}:${route}:${key}`;
}

function hashBody(body: unknown): string {
  return hashIdempotencyBody(body);
}

function scopedId(tenantId: string, method: string, route: string, key: string): string {
  return scopedIdempotencyId(tenantId, method, route, key);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDuplicateKeyError(e: unknown): boolean {
  return Boolean(
    e
    && typeof e === 'object'
    && 'code' in e
    && (e as { code?: number }).code === 11000,
  );
}

function isCompletedRow(row: IdempotencyDoc): boolean {
  if (row.phase === 'completed') return true;
  return row.response != null
    && typeof row.status === 'number'
    && row.status >= 200
    && row.status < 300;
}

function completedReplay(row: IdempotencyDoc): NextResponse {
  return cors(NextResponse.json(row.response, { status: row.status }));
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

async function resolveExistingClaim(
  col: Collection<IdempotencyDoc>,
  _id: string,
  bodyHash: string,
): Promise<ClaimIdempotencyResult> {
  for (let i = 0; i < PENDING_RETRIES; i += 1) {
    const row = await col.findOne({ _id });
    if (!row) {
      // Race: claim released after failure — caller may retry insert via claim again.
      return { kind: 'proceed' };
    }

    if (row.bodyHash && row.bodyHash !== bodyHash) {
      return {
        kind: 'replay',
        response: err('Konflik idempotency — permintaan berbeda dari yang sudah diproses', 409),
      };
    }

    if (isCompletedRow(row)) {
      return { kind: 'replay', response: completedReplay(row) };
    }

    // pending — wait briefly for the in-flight handler to store
    await sleep(PENDING_WAIT_MS);
  }

  return {
    kind: 'replay',
    response: err('Permintaan idempotency sedang diproses', 409),
  };
}

/**
 * Thin claim sebelum handler: insertOne pending dengan _id scoped yang sama
 * seperti store/replay (tenantId:method:route:key). Duplikat → replay / 409 / wait.
 */
export async function claimIdempotency(
  db: Db,
  tenantId: string,
  route: string,
  method: string,
  key: string,
  body: unknown,
): Promise<ClaimIdempotencyResult> {
  await ensureIndexes(db);
  const _id = scopedId(tenantId, method, route, key);
  const bodyHash = hashBody(body);
  const col = db.collection<IdempotencyDoc>('idempotency_keys');
  const pendingDoc: IdempotencyDoc = {
    _id,
    tenantId,
    route,
    method,
    key,
    bodyHash,
    phase: 'pending',
    createdAt: new Date(),
  };

  // Satu retry jika claim pending dilepas (non-2xx) saat kita resolve.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await col.insertOne({ ...pendingDoc, createdAt: new Date() });
      return { kind: 'proceed' };
    } catch (e) {
      if (!isDuplicateKeyError(e)) {
        const existing = await col.findOne({ _id });
        if (!existing) continue;
      }
      const resolved = await resolveExistingClaim(col, _id, bodyHash);
      if (resolved.kind === 'proceed' && attempt === 0) continue;
      return resolved;
    }
  }

  // Soft fallback — lebih baik lanjut daripada blokir kasir.
  return { kind: 'proceed' };
}

/** Lepas claim pending agar retry client tidak stuck (handler non-2xx / parse gagal). */
export async function releaseIdempotencyClaim(
  db: Db,
  tenantId: string,
  route: string,
  method: string,
  key: string,
): Promise<void> {
  const _id = scopedId(tenantId, method, route, key);
  try {
    await db.collection<IdempotencyDoc>('idempotency_keys').deleteOne({
      _id,
      phase: 'pending',
    });
  } catch {
    /* best-effort */
  }
}

/** Kembalikan response tersimpan atau 409 jika body berbeda. */
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

  if (isCompletedRow(row)) {
    return completedReplay(row);
  }

  return null;
}

/** Simpan hasil sukses agar replay mengembalikan response yang sama. */
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
  if (status < 200 || status >= 300) {
    await releaseIdempotencyClaim(db, tenantId, route, method, key);
    return response;
  }

  let parsed: unknown;
  try {
    parsed = await response.clone().json();
  } catch {
    await releaseIdempotencyClaim(db, tenantId, route, method, key);
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
          phase: 'completed' as IdempotencyPhase,
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
    if (existing && isCompletedRow(existing)) {
      return completedReplay(existing);
    }
  }

  return response;
}
