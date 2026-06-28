import type { JsonObject } from '@/types/json';
import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '@/lib/fetch-json';
import { toast } from 'sonner';

export function useCustomerPoList() {
  const [list, setList] = useState<JsonObject[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    return fetchJson<JsonObject[]>('/api/customer-purchase-orders')
      .then((data) => setList(Array.isArray(data) ? data : []))
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { list, loading, reload, setList };
}

export function useCustomerPoProducts() {
  const [products, setProducts] = useState<JsonObject[]>([]);

  const reload = useCallback(() => {
    return fetchJson<{ items?: JsonObject[] } | JsonObject[]>('/api/products?limit=500&withWarehouseStock=1')
      .then((data) => {
        const items = Array.isArray(data) ? data : (data?.items || []);
        setProducts(items);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { products, reloadProducts: reload };
}
