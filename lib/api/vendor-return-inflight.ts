/** Predicate sibling RTV in-flight untuk serialisasi CN/approval per invoice. */

export type VendorReturnInflightLike = {
  id?: string;
  source?: string | null;
  status?: string;
  vendorDecision?: string | null;
  creditNoteId?: string | null;
  cnSyncStatus?: string | null;
};

/**
 * True jika sibling (bukan self, bukan grn-reject) masih mengunci antrian invoice:
 * - menunggu approval / sedang posting, atau
 * - POSTED dengan CN SYNCING/FAILED, atau
 * - POSTED menunggu keputusan vendor (CN DRAFT di Sales).
 */
export function isVendorReturnInflightSibling(
  p: VendorReturnInflightLike,
  selfId: string,
): boolean {
  if (String(p.id || '') === String(selfId || '')) return false;
  if (String(p.source || '') === 'grn-reject') return false;
  const st = String(p.status || '');
  if (st === 'PENDING_APPROVAL' || st === 'POSTING') return true;
  if (st !== 'POSTED') return false;
  const cn = String(p.cnSyncStatus || '');
  if (cn === 'SYNCING' || cn === 'FAILED') return true;
  return String(p.vendorDecision || '') === 'PENDING';
}

export function findInflightVendorReturnSibling<T extends VendorReturnInflightLike>(
  rows: T[],
  selfId: string,
): T | undefined {
  return rows.find((p) => isVendorReturnInflightSibling(p, selfId));
}
