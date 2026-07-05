'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '@/lib/fetch-json';
import type { ProductUom } from '@/lib/uom/types';

const cache = new Map<string, ProductUom[]>();

function pickDefaultUom(uoms: ProductUom[]): ProductUom | null {
  return uoms.find((u) => u.isBase) || uoms[0] || null;
}

export function useProductUoms(stokId: string | null | undefined) {
  const [uoms, setUoms] = useState<ProductUom[]>(() => (stokId ? cache.get(stokId) || [] : []));
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    if (cache.has(id)) {
      setUoms(cache.get(id)!);
      return cache.get(id)!;
    }
    setLoading(true);
    try {
      const rows = await fetchJson<ProductUom[]>(`/api/products/${encodeURIComponent(id)}/uom`);
      const list = Array.isArray(rows) ? rows : [];
      cache.set(id, list);
      setUoms(list);
      return list;
    } catch {
      setUoms([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!stokId) {
      setUoms([]);
      return;
    }
    void load(stokId);
  }, [stokId, load]);

  return { uoms, loading, reload: () => (stokId ? load(stokId) : Promise.resolve([])), defaultUom: pickDefaultUom(uoms) };
}

export async function fetchDefaultProductUom(productId: string): Promise<ProductUom | null> {
  if (cache.has(productId)) return pickDefaultUom(cache.get(productId)!);
  try {
    const rows = await fetchJson<ProductUom[]>(`/api/products/${encodeURIComponent(productId)}/uom`);
    const list = Array.isArray(rows) ? rows : [];
    cache.set(productId, list);
    return pickDefaultUom(list);
  } catch {
    return null;
  }
}
