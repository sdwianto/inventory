/**
 * Antrian mutasi offline — IndexedDB + replay saat kembali online.
 */

const DB_NAME = 'dawam-erp-offline';
const DB_VERSION = 1;
const STORE = 'mutations';

export type OfflineMutation = {
  id: string;
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
  label?: string;
  createdAt: number;
};

export class OfflineQueuedError extends Error {
  constructor(message = 'Disimpan offline — akan disinkron saat online') {
    super(message);
    this.name = 'OfflineQueuedError';
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB tidak tersedia'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
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

export async function listPendingMutations(): Promise<OfflineMutation[]> {
  if (typeof indexedDB === 'undefined') return [];
  const rows = await withStore<OfflineMutation[]>('readonly', (store) => store.getAll());
  return (rows || []).sort((a, b) => a.createdAt - b.createdAt);
}

export async function countPendingMutations(): Promise<number> {
  const rows = await listPendingMutations();
  return rows.length;
}

export async function enqueueOfflineMutation(
  input: Omit<OfflineMutation, 'id' | 'createdAt'>,
): Promise<string> {
  const row: OfflineMutation = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  await withStore('readwrite', (store) => store.put(row));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('erp-offline-queued'));
  }
  return row.id;
}

export async function removeOfflineMutation(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id));
}

export async function replayOfflineMutations(): Promise<{ ok: number; failed: number }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: 0, failed: 0 };
  }

  const pending = await listPendingMutations();
  let ok = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const res = await fetch(row.url, {
        method: row.method,
        headers: {
          'Content-Type': 'application/json',
          ...(row.headers || {}),
        },
        body: row.body,
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      await removeOfflineMutation(row.id);
      ok += 1;
    } catch {
      failed += 1;
    }
  }

  return { ok, failed };
}

export async function fetchOrQueue(
  url: string,
  init: RequestInit & { offlineLabel?: string } = {},
): Promise<Response> {
  const method = (init.method || 'GET').toUpperCase();
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  if (typeof navigator !== 'undefined' && !navigator.onLine && isMutation) {
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
  return fetch(url, { credentials: 'include', ...fetchInit });
}
