'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '@/lib/fetch-json';
import type { ProductUom } from '@/lib/uom/types';

const cache = new Map<string, ProductUom[]>();

export const PRODUCT_UOMS_INVALIDATE_EVENT = 'product-uoms-invalidate';
export const PRODUCT_UOMS_PRIMED_EVENT = 'product-uoms-primed';

function pickDefaultUom(uoms: ProductUom[]): ProductUom | null {
  return uoms.find((u) => u.isBase) || uoms[0] || null;
}

export function invalidateProductUomsCache(productId?: string) {
  if (productId) cache.delete(productId);
  else cache.clear();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PRODUCT_UOMS_INVALIDATE_EVENT, { detail: { productId } }));
  }
}

async function fetchProductUomsBatch(ids: string[]): Promise<Map<string, ProductUom[]>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const missing = unique.filter((id) => !cache.has(id));
  if (missing.length) {
    const data = await fetchJson<Record<string, ProductUom[]>>(
      `/api/products/uom?ids=${missing.map(encodeURIComponent).join(',')}`,
    );
    for (const id of missing) {
      cache.set(id, Array.isArray(data[id]) ? data[id] : []);
    }
  }
  return new Map(unique.map((id) => [id, cache.get(id) || []]));
}

export function primeProductUomsCache(stokId: string, uoms: ProductUom[]) {
  cache.set(stokId, uoms);
}

export function primeProductUomsCacheFromProducts(
  products: Array<{ id?: string; uoms?: ProductUom[] }>,
) {
  for (const p of products) {
    if (p.id && Array.isArray(p.uoms) && p.uoms.length) {
      cache.set(String(p.id), p.uoms);
    }
  }
}

export function useProductUoms(stokId: string | null | undefined) {
  const [uoms, setUoms] = useState<ProductUom[]>(() => (stokId ? cache.get(stokId) || [] : []));
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string, fresh = false) => {
    if (!fresh && cache.has(id)) {
      setUoms(cache.get(id)!);
      return cache.get(id)!;
    }
    setLoading(true);
    try {
      const map = await fetchProductUomsBatch([id]);
      const list = map.get(id) || [];
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

  useEffect(() => {
    const onPrimed = () => {
      if (!stokId) return;
      if (cache.has(stokId)) setUoms(cache.get(stokId)!);
    };
    const onInvalidate = (ev: Event) => {
      const detail = (ev as CustomEvent<{ productId?: string }>).detail;
      if (!stokId) return;
      if (!detail?.productId || detail.productId === stokId) {
        void load(stokId, true);
      }
    };
    window.addEventListener(PRODUCT_UOMS_PRIMED_EVENT, onPrimed);
    window.addEventListener(PRODUCT_UOMS_INVALIDATE_EVENT, onInvalidate);
    return () => {
      window.removeEventListener(PRODUCT_UOMS_PRIMED_EVENT, onPrimed);
      window.removeEventListener(PRODUCT_UOMS_INVALIDATE_EVENT, onInvalidate);
    };
  }, [stokId, load]);

  return {
    uoms,
    loading,
    reload: () => (stokId ? load(stokId, true) : Promise.resolve([])),
    defaultUom: pickDefaultUom(uoms),
  };
}

export async function fetchDefaultProductUom(
  productId: string,
  options?: { fresh?: boolean },
): Promise<ProductUom | null> {
  if (options?.fresh) cache.delete(productId);
  if (!options?.fresh && cache.has(productId)) return pickDefaultUom(cache.get(productId)!);
  try {
    const map = await fetchProductUomsBatch([productId]);
    return pickDefaultUom(map.get(productId) || []);
  } catch {
    return null;
  }
}

export async function fetchProductUomsForIds(ids: string[]): Promise<Map<string, ProductUom[]>> {
  return fetchProductUomsBatch(ids);
}

/** Pre-fetch UOM batch untuk banyak produk — dipakai saat buka form PO/stok. */
export async function primeUomsForStokIds(stokIds: string[]): Promise<void> {
  const ids = [...new Set(stokIds.filter(Boolean))];
  if (!ids.length) return;
  await fetchProductUomsBatch(ids);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PRODUCT_UOMS_PRIMED_EVENT));
  }
}
