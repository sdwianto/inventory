/** Scope lookup hutang vendor per vendorTenantId — hindari merge lintas vendor pada noDO/noInvoice sama. */

import type { GrnDoc, HutangDoc } from '@/types/documents';

export function hutangVendorKey(vendorTenantId: string | null | undefined): string {
  return String(vendorTenantId || '').trim().toLowerCase();
}

export function hutangMatchesGrnVendor(
  hutang: HutangDoc,
  grn: Pick<GrnDoc, 'vendorTenantId'>,
): boolean {
  const grnVid = hutangVendorKey(grn.vendorTenantId);
  const hutangVid = hutangVendorKey(hutang.vendorTenantId);
  if (!grnVid || !hutangVid) return true;
  return grnVid === hutangVid;
}

export function vendorScopedKey(
  vendorTenantId: string | null | undefined,
  value: string,
): string {
  const vid = hutangVendorKey(vendorTenantId);
  return vid ? `${vid}:${value}` : value;
}
