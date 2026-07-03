'use client';

import type { JsonObject } from '@/types/json';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';

/** Grup & satuan produk per tenant — menggantikan raw fetch di halaman produk. */
export function useProdukMeta(
  tenantId: string,
  isMaster: boolean,
  enabled = true,
) {
  const qs = isMaster && tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
  const canLoad = enabled && (!isMaster || Boolean(tenantId));

  const grup = useApiQuery<JsonObject[]>(
    queryKeys.productMeta.grup(tenantId),
    canLoad ? `/api/produk-grup${qs}` : null,
    { enabled: canLoad, staleTime: 120_000 },
  );
  const satuan = useApiQuery<JsonObject[]>(
    queryKeys.productMeta.satuan(tenantId),
    canLoad ? `/api/produk-satuan${qs}` : null,
    { enabled: canLoad, staleTime: 120_000 },
  );

  return {
    grupList: Array.isArray(grup.data) ? grup.data : [],
    satuanList: Array.isArray(satuan.data) ? satuan.data : [],
    isLoading: grup.isLoading || satuan.isLoading,
    refetch: async () => {
      await Promise.all([grup.refetch(), satuan.refetch()]);
    },
  };
}
