/**
 * W2-1 — pure FEFO allocator (no I/O).
 * Earliest expiry first; skip expired unless allowExpired.
 */

export type FefoBatchCandidate = {
  id: string;
  batchNo?: string;
  expiryDate: string;
  qtyRemaining: number;
  status?: string;
};

export type FefoAllocation = {
  batchId: string;
  batchNo?: string;
  expiryDate: string;
  qty: number;
};

export type FefoAllocateResult = {
  allocations: FefoAllocation[];
  allocated: number;
  shortfall: number;
};

function remainingOf(b: FefoBatchCandidate): number {
  const n = Number(b.qtyRemaining);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Sort copy: expiryDate ASC, then id for stability. */
export function sortFefo(batches: FefoBatchCandidate[]): FefoBatchCandidate[] {
  return [...batches].sort((a, b) => {
    const ea = String(a.expiryDate || '').slice(0, 10);
    const eb = String(b.expiryDate || '').slice(0, 10);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

export function allocateFefo(
  needQty: number,
  batches: FefoBatchCandidate[],
  opts?: { asOf?: Date; allowExpired?: boolean },
): FefoAllocateResult {
  const need = Number(needQty);
  if (!(need > 0)) {
    return { allocations: [], allocated: 0, shortfall: 0 };
  }

  const asOfIso = (opts?.asOf ?? new Date()).toISOString().slice(0, 10);
  const allowExpired = opts?.allowExpired === true;
  const ordered = sortFefo(batches);

  const allocations: FefoAllocation[] = [];
  let left = need;

  for (const b of ordered) {
    if (left <= 0) break;
    const rem = remainingOf(b);
    if (rem <= 0) continue;
    const exp = String(b.expiryDate || '').slice(0, 10);
    if (!allowExpired && /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < asOfIso) continue;

    const take = Math.min(rem, left);
    allocations.push({
      batchId: b.id,
      batchNo: b.batchNo,
      expiryDate: exp,
      qty: take,
    });
    left -= take;
  }

  return {
    allocations,
    allocated: need - left,
    shortfall: left,
  };
}
