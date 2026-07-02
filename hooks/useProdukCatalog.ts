import type { JsonObject } from '@/types/json';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useCursorQuery, type CursorPage } from '@/lib/hooks/use-cursor-query';
import { buildProdukPageUrl, produkPageQueryKey } from '@/lib/produk-page-scope';

export const PRODUCT_PAGE_DEFAULT_LIMIT = 100;

type ProdukMeta = {
  grup?: JsonObject[];
  satuan?: JsonObject[];
};

type UseProdukCatalogOptions = {
  filterTenantId: string;
  isMaster?: boolean;
  pageLimit?: number;
  q?: string;
};

export function useProdukCatalog({
  filterTenantId,
  isMaster = false,
  pageLimit = PRODUCT_PAGE_DEFAULT_LIMIT,
  q = '',
}: UseProdukCatalogOptions) {
  const baseUrl = useMemo(
    () => buildProdukPageUrl(filterTenantId, q, isMaster),
    [q, filterTenantId, isMaster],
  );

  const queryKey = useMemo(
    () => produkPageQueryKey(filterTenantId, q),
    [filterTenantId, q],
  );

  const enabled = !isMaster || !!filterTenantId;
  const {
    items: products,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    reload,
    error,
    query,
  } = useCursorQuery<JsonObject>(queryKey, baseUrl, { limit: pageLimit, enabled });

  const firstPage = query.data?.pages?.[0] as (CursorPage<JsonObject> & { meta?: ProdukMeta }) | undefined;
  const bundleMeta = firstPage?.meta;

  const [metaOverride, setMetaOverride] = useState<ProdukMeta | null>(null);
  const grupList = metaOverride?.grup ?? bundleMeta?.grup ?? [];
  const satuanList = metaOverride?.satuan ?? bundleMeta?.satuan ?? [];

  const loadProducts = useCallback(async () => {
    await reload();
    return products;
  }, [reload, products]);

  const loadMeta = useCallback(async (tenantId?: string) => {
    const tid = tenantId || '';
    if (isMaster && !tid) {
      setMetaOverride({ grup: [], satuan: [] });
      return;
    }
    const qs = isMaster && tid ? `?tenantId=${encodeURIComponent(tid)}` : '';
    try {
      const [gRes, sRes] = await Promise.all([
        fetch(`/api/produk-grup${qs}`),
        fetch(`/api/produk-satuan${qs}`),
      ]);
      const gData = await gRes.json();
      const sData = await sRes.json();
      if (!gRes.ok) throw new Error(gData.error || 'Gagal memuat grup');
      if (!sRes.ok) throw new Error(sData.error || 'Gagal memuat satuan');
      setMetaOverride({
        grup: Array.isArray(gData) ? gData : [],
        satuan: Array.isArray(sData) ? sData : [],
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setMetaOverride({ grup: [], satuan: [] });
    }
  }, [isMaster]);

  return {
    products,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    error,
    grupList,
    satuanList,
    loadProducts,
    reload,
    loadMeta,
  };
}
