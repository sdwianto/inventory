import type { JsonObject } from '@/types/json';
import { asArray, asObject, num, str } from '@/types/json';

/** Status PO yang boleh diedit supervisor (sebelum/sesudah pengajuan). */
export const PO_SUPERVISOR_EDIT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED'] as const;

/** Status pasca-approve yang masih boleh diedit in-place (noPO tetap) selama belum ada penerimaan. */
export const PO_POST_APPROVED_EDIT_STATUSES = ['APPROVED', 'SUBMITTED', 'CONFIRMED'] as const;

export function canSupervisorEditPoStatus(status: string): boolean {
  return (PO_SUPERVISOR_EDIT_STATUSES as readonly string[]).includes(status);
}

export function isPostApprovedPoEditStatus(status: string): boolean {
  return (PO_POST_APPROVED_EDIT_STATUSES as readonly string[]).includes(status);
}

/** Status yang boleh diajukan ke admin (DRAFT baru atau ajukan ulang setelah ditolak). */
export function canRequestApprovalPoStatus(status: string): boolean {
  return status === 'DRAFT' || status === 'REJECTED';
}

export function poHasReceivedQty(po: JsonObject | null | undefined): boolean {
  if (!po) return false;
  return asArray(po.items).some((it) => num(asObject(it).qtyReceived) > 0);
}

function canEditPostApprovedRole(role: string | undefined, opts: { isMaster?: boolean }): boolean {
  if (opts.isMaster || role === 'ADMIN' || role === 'MASTER') return true;
  return role === 'SUPERVISOR';
}

export function canEditCustomerPo(
  role: string | undefined,
  po: JsonObject | null | undefined,
  opts: { isMaster?: boolean; userId?: string } = {},
): boolean {
  if (!po) return false;
  const status = str(po.status);

  if (isPostApprovedPoEditStatus(status)) {
    if (poHasReceivedQty(po)) return false;
    return canEditPostApprovedRole(role, opts);
  }

  if (!['DRAFT', 'PENDING_APPROVAL', 'REJECTED'].includes(status)) return false;
  if (opts.isMaster || role === 'ADMIN' || role === 'MASTER') return true;
  if (role === 'SUPERVISOR' && canSupervisorEditPoStatus(status)) return true;
  if (status === 'DRAFT' && role === 'GUDANG') {
    const createdBy = asObject(po.createdBy);
    return str(createdBy.userId) === str(opts.userId);
  }
  return false;
}
