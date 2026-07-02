import type { JsonObject } from '@/types/json';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { useCursorList } from '@/lib/hooks/use-cursor-list';

export const PRODUCT_PAGE_DEFAULT_LIMIT = 100;

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
  const baseUrl = useMemo(() => {
    let url = `/api/products?q=${encodeURIComponent(q)}`;
    url = withActingTenantQuery(url, filterTenantId, isMaster);
    return url;
  }, [q, filterTenantId, isMaster]);

  const enabled = !isMaster || !!filterTenantId;
  const {
    items: products,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    reload,
    error,
  } = useCursorList<JsonObject>(baseUrl, { limit: pageLimit, enabled });

  const [grupList, setGrupList] = useState<JsonObject[]>([]);
  const [satuanList, setSatuanList] = useState<JsonObject[]>([]);

  const loadProducts = useCallback(async () => {
    await reload();
    return products;
  }, [reload, products]);

  const loadMeta = useCallback(async (tenantId?: string) => {
    const tid = tenantId || '';
    if (isMaster && !tid) {
      setGrupList([]);
      setSatuanList([]);
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
      setGrupList(Array.isArray(gData) ? gData : []);
      setSatuanList(Array.isArray(sData) ? sData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setGrupList([]);
      setSatuanList([]);
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
