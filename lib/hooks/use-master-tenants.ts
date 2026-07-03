'use client';

import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';

export type MasterTenantRow = {
  tenantId: string;
  tenantName?: string;
  companyName?: string;
};

/** Daftar tenant minimal untuk MASTER — cached via React Query. */
export function useMasterTenants(isMaster: boolean | undefined) {
  const query = useApiQuery<MasterTenantRow[]>(
    queryKeys.tenants.list,
    isMaster ? '/api/tenants?minimal=1' : null,
    { enabled: Boolean(isMaster), staleTime: 120_000 },
  );
  return {
    tenants: Array.isArray(query.data) ? query.data : [],
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}
