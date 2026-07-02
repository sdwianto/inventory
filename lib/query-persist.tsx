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

export function persistBuster(): string {
  const user = getUser();
  const acting = getActingTenantId();
  const tid = user?.role === 'MASTER' ? (acting || 'master-none') : (user?.tenantId || 'anon');
  return `${user?.id || 'anon'}:${tid}`;
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
            query.state.status === 'success' && shouldPersistQuery(query.queryKey),
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
