/**
 * Antrian mutasi offline — IndexedDB + replay saat kembali online.
 * P4.3: idempotency key, conflict detection, tenant scope isolation.
 */

import { getUser } from '@/lib/auth-client';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { isOfflineQueueEnabled } from '@/lib/feature-flags-client';

const DB_NAME = 'dawam-erp-offline';
const DB_VERSION = 2;
const STORE = 'mutations';

const CONFLICT_STATUSES = new Set([409, 422]);

export type OfflineMutation = {
  id: string;
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
  label?: string;
  createdAt: number;
  tenantScope?: string;
  idempotencyKey?: string;
  lastError?: string;
};

export type ReplayResult = {
  ok: number;
  failed: number;
  conflicts: Array<{ id: string; label?: string; error: string }>;
};

export class OfflineQueuedError extends Error {
  constructor(message = 'Disimpan offline — akan disinkron saat online') {
    super(message);
    this.name = 'OfflineQueuedError';
  }
}

export function getQueueTenantScope(): string {
  const user = getUser();
  if (!user) return 'anon';
  if (user.role === 'MASTER') {
    const acting = getActingTenantId();
    return acting ? `t:${acting}` : 'master:unset';
  }
  return `t:${user.tenantId || 'default'}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB tidak tersedia'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (event.oldVersion < 2) {
        const tx = (event.target as IDBOpenDBRequest).transaction;
        if (tx) tx.objectStore(STORE).clear();
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Gagal buka IndexedDB'));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error || new Error('IndexedDB error'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB tx error'));
  }));
}

function matchesTenantScope(row: OfflineMutation): boolean {
  const scope = getQueueTenantScope();
  if (!row.tenantScope) return scope === 'anon';
  return row.tenantScope === scope;
}

function dispatchQueueEvent(name: string, detail?: unknown) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, detail ? { detail } : undefined));
}

async function parseErrorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error || `HTTP ${res.status}`;
}

async function persistLastError(id: string, error: string): Promise<void> {
  const rows = await withStore<OfflineMutation[]>('readonly', (store) => store.getAll());
  const row = (rows || []).find((r) => r.id === id);
  if (!row) return;
  await withStore('readwrite', (store) => store.put({ ...row, lastError: error }));
}

export async function listPendingMutations(): Promise<OfflineMutation[]> {
  if (typeof indexedDB === 'undefined') return [];
  const rows = await withStore<OfflineMutation[]>('readonly', (store) => store.getAll());
  return (rows || [])
    .filter(matchesTenantScope)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function countPendingMutations(): Promise<number> {
  const rows = await listPendingMutations();
  return rows.length;
}

export async function enqueueOfflineMutation(
  input: Omit<OfflineMutation, 'id' | 'createdAt' | 'tenantScope' | 'idempotencyKey'>,
): Promise<string> {
  const id = crypto.randomUUID();
  const row: OfflineMutation = {
    ...input,
    id,
    idempotencyKey: id,
    tenantScope: getQueueTenantScope(),
    createdAt: Date.now(),
  };
  await withStore('readwrite', (store) => store.put(row));
  dispatchQueueEvent('erp-offline-queued');
  return row.id;
}

export async function removeOfflineMutation(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
  dispatchQueueEvent('erp-offline-queued');
}

export async function discardOfflineMutation(id: string): Promise<void> {
  await removeOfflineMutation(id);
}

type ReplayOutcome =
  | { result: 'ok' }
  | { result: 'conflict' | 'failed'; error: string };

async function replayOne(row: OfflineMutation): Promise<ReplayOutcome> {
  const idempotencyKey = row.idempotencyKey || row.id;
  try {
    const res = await fetch(row.url, {
      method: row.method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        ...(row.headers || {}),
      },
      body: row.body,
      credentials: 'include',
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const message = await parseErrorMessage(res);
      if (CONFLICT_STATUSES.has(res.status)) {
        await persistLastError(row.id, message);
        dispatchQueueEvent('erp-offline-conflict', {
          id: row.id,
          label: row.label,
          error: message,
        });
        return { result: 'conflict', error: message };
      }
      await persistLastError(row.id, message);
      return { result: 'failed', error: message };
    }
    await removeOfflineMutation(row.id);
    return { result: 'ok' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Gagal sinkron';
    await persistLastError(row.id, message);
    return { result: 'failed', error: message };
  }
}

export async function replayOfflineMutation(
  id: string,
): Promise<'ok' | 'conflict' | 'failed' | 'skipped'> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'skipped';
  const pending = await listPendingMutations();
  const row = pending.find((r) => r.id === id);
  if (!row) return 'skipped';
  const outcome = await replayOne(row);
  return outcome.result === 'ok' ? 'ok' : outcome.result;
}

export async function replayOfflineMutations(): Promise<ReplayResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: 0, failed: 0, conflicts: [] };
  }

  const pending = await listPendingMutations();
  let ok = 0;
  let failed = 0;
  const conflicts: ReplayResult['conflicts'] = [];
  const concurrency = 4;

  for (let i = 0; i < pending.length; i += concurrency) {
    const batch = pending.slice(i, i + concurrency);
    const outcomes = await Promise.all(batch.map((row) => replayOne(row)));
    for (let j = 0; j < outcomes.length; j += 1) {
      const outcome = outcomes[j];
      const row = batch[j];
      if (outcome.result === 'ok') ok += 1;
      else if (outcome.result === 'conflict') {
        conflicts.push({
          id: row.id,
          label: row.label,
          error: outcome.error,
        });
      } else failed += 1;
    }
  }

  dispatchQueueEvent('erp-offline-replay-done', { ok, failed, conflicts });
  return { ok, failed, conflicts };
}

/** Fetch biasa; jika offline dan method mutasi, antre ke IndexedDB. */
export async function fetchOrQueue(
  url: string,
  init: RequestInit & { offlineLabel?: string } = {},
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (typeof navigator !== 'undefined' && !navigator.onLine && isMutation) {
    if (!isOfflineQueueEnabled()) {
      throw new Error('Antrian offline dinonaktifkan untuk tenant ini');
    }
    await enqueueOfflineMutation({
      url,
      method,
      body: typeof init.body === 'string' ? init.body : undefined,
      headers: init.headers as Record<string, string> | undefined,
      label: init.offlineLabel,
    });
    throw new OfflineQueuedError();
  }

  const { offlineLabel: _label, ...fetchInit } = init;
  const withSignal = fetchInit.signal
    ? fetchInit
    : { ...fetchInit, signal: AbortSignal.timeout(30_000) };
  return fetch(url, { credentials: 'include', ...withSignal });
}
