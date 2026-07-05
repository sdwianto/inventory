'use client';

import { useEffect, useMemo } from 'react';
import { primeUomsForStokIds } from '@/lib/hooks/use-product-uoms';

/** Batch-prime UOM cache untuk semua baris form — hindari N fetch di LineUomSelect. */
export function usePrimeLineItemUoms(
  enabled: boolean,
  stokIds: Array<string | null | undefined>,
) {
  const key = useMemo(
    () => [...new Set(stokIds.filter(Boolean) as string[])].sort().join(','),
    [stokIds],
  );

  useEffect(() => {
    if (!enabled || !key) return;
    void primeUomsForStokIds(key.split(','));
  }, [enabled, key]);
}
