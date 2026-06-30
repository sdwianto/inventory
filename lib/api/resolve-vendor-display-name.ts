import type { Db } from 'mongodb';
import { getIntegrationConfig } from '@/lib/api/integration-config';
import { getVendorTenantNameMap } from '@/lib/api/vendor-tenants';
import { vendorBillingFromPayload } from '@/lib/api/hutang-detail-enrich';
import { normalizeTenantId } from '@/lib/api/tenant-scope';
import type { VendorInvoicePayload } from '@/types/integration';

const PLACEHOLDER_VENDOR_NAMES = new Set(['sales.app vendor', 'vendor']);

function isPlaceholderVendorName(name: string | null | undefined): boolean {
  const n = String(name || '').trim();
  if (!n) return true;
  return PLACEHOLDER_VENDOR_NAMES.has(n.toLowerCase());
}

/** Nama toko pengirim untuk tagihan vendor — payload → integrasi → registry vendor_tenants. */
export async function resolveVendorDisplayName(
  db: Db,
  customerTenantId: string,
  vendorTenantId: string | null | undefined,
  payload: VendorInvoicePayload,
): Promise<string> {
  const billing = vendorBillingFromPayload(payload, vendorTenantId);
  if (billing?.companyName?.trim()) return billing.companyName.trim();
  if (payload.vendorName?.trim() && !isPlaceholderVendorName(payload.vendorName)) {
    return String(payload.vendorName).trim();
  }

  const tid = normalizeTenantId(customerTenantId);
  const vid = String(vendorTenantId || payload.vendorTenantId || '').trim();

  const config = await getIntegrationConfig(db, tid);
  if (config.vendorName?.trim() && !isPlaceholderVendorName(config.vendorName)) {
    if (!vid || config.vendorTenantId === vid) return config.vendorName.trim();
  }

  if (vid) {
    const nameMap = await getVendorTenantNameMap(db, tid);
    const fromRegistry = nameMap[vid]?.trim();
    if (fromRegistry && !isPlaceholderVendorName(fromRegistry) && fromRegistry !== vid) {
      return fromRegistry;
    }
    return vid;
  }

  return config.vendorName?.trim() || 'Vendor';
}
