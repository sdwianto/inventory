'use client';

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { get, set, del } from 'idb-keyval';
import type { Query, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';

const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const idbStorage = {
  getItem: async (key: string) => (await get(key)) ?? null,
  setItem: async (key: string, value: string) => { await set(key, value); },
  removeItem: async (key: string) => { await del(key); },
};

export function createQueryPersister() {
  return createAsyncStoragePersister({
    storage: idbStorage,
    key: 'inventory-rq-cache',
  });
}

/** Naikkan saat bentuk cache berubah atau cache lama perlu dibuang di semua browser. */
export const PERSIST_CACHE_VERSION = 'v2';

export function persistBuster(): string {
  const user = getUser();
  const acting = getActingTenantId();
  const tid = user?.role === 'MASTER' ? (acting || 'master-none') : (user?.tenantId || 'anon');
  return `${PERSIST_CACHE_VERSION}:${user?.id || 'anon'}:${tid}`;
}

/** Infinite query hanya dipersist bila semua halamannya objek (bukan null/terputus). */
export function isPersistableData(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (typeof data !== 'object' || !('pages' in (data as object))) return true;
  const pages = (data as { pages?: unknown }).pages;
  return Array.isArray(pages) && pages.every((p) => p !== null && typeof p === 'object');
}

const PERSISTED_PREFIXES = new Set([
  'workspace',
  'pages',
  'produk-grup',
  'produk-satuan',
  'dashboard',
  'nav-badges',
]);

export function shouldPersistQuery(queryKey: readonly unknown[]): boolean {
  const root = String(queryKey[0] || '');
  return PERSISTED_PREFIXES.has(root);
}

interface PersistProviderProps {
  client: QueryClient;
  children: ReactNode;
}

export function PersistQueryProvider({ client, children }: PersistProviderProps) {
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister: createQueryPersister(),
        maxAge: PERSIST_MAX_AGE_MS,
        buster: persistBuster(),
        dehydrateOptions: {
          shouldDehydrateQuery: (query: Query) =>
            query.state.status === 'success'
            && shouldPersistQuery(query.queryKey)
            && isPersistableData(query.state.data),
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
