/** Bulkhead — pool terpisah agar hang Catalog tidak menelan Invoice/PO. */

export type BulkheadPool = 'invoice' | 'catalog' | 'notification' | 'po';

const LIMITS: Record<BulkheadPool, number> = {
  invoice: 8,
  catalog: 4,
  notification: 4,
  po: 6,
};

const inFlight: Record<BulkheadPool, number> = {
  invoice: 0,
  catalog: 0,
  notification: 0,
  po: 0,
};

/** Test-only reset. */
export function resetBulkheads(): void {
  inFlight.invoice = 0;
  inFlight.catalog = 0;
  inFlight.notification = 0;
  inFlight.po = 0;
}

export function bulkheadInFlight(pool: BulkheadPool): number {
  return inFlight[pool];
}

export async function withBulkhead<T>(pool: BulkheadPool, fn: () => Promise<T>): Promise<T> {
  const limit = LIMITS[pool];
  if (inFlight[pool] >= limit) {
    const err = new Error(`Bulkhead saturated (${pool})`);
    (err as Error & { code: string }).code = 'BULKHEAD_SATURATED';
    throw err;
  }
  inFlight[pool] += 1;
  try {
    return await fn();
  } finally {
    inFlight[pool] = Math.max(0, inFlight[pool] - 1);
  }
}
