import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { withActingTenantQuery } from '@/lib/tenant-api';

type UseProdukCatalogOptions = {
  filterTenantId: string;
  isMaster?: boolean;
};

export function useProdukCatalog({ filterTenantId, isMaster = false }: UseProdukCatalogOptions) {
  const [products, setProducts] = useState<JsonObject[]>([]);
  const [loading, setLoading] = useState(true);
  const [grupList, setGrupList] = useState<JsonObject[]>([]);
  const [satuanList, setSatuanList] = useState<JsonObject[]>([]);

  const loadProducts = useCallback(async (query = '', tenantId = filterTenantId) => {
    setLoading(true);
    try {
      let url = `/api/products?q=${encodeURIComponent(query)}`;
      url = withActingTenantQuery(url, tenantId, isMaster);
      const res = await fetch(url);
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
      return Array.isArray(data) ? data : [];
    } catch {
      toast.error('Gagal memuat');
      setProducts([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [filterTenantId, isMaster]);

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
    setProducts,
    loading,
    grupList,
    satuanList,
    loadProducts,
    loadMeta,
  };
}
