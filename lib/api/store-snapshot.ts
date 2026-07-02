import type { Db } from 'mongodb';
// Snapshot toko untuk struk — dari tenant_settings (bukan placeholder mock).

import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { logoUrlFromSettings } from '@/lib/api/media-storage';

export async function loadStoreSnapshot(db: Db, tenantId, tenantNameFallback = '') {
  const tid = tenantId || 'default';
  const s = await db.collection('tenant_settings').findOne({ tenantId: tid });
  const raw = {
    tenantId: tid,
    companyName: s?.companyName || tenantNameFallback || tid,
    companyAddress: s?.companyAddress || '',
    companyPhone: s?.companyPhone || '',
    companyNPWP: s?.companyNPWP || '',
    receiptFooterText: s?.receiptFooterText || 'Terima Kasih',
    showLogoOnReceipt: s?.showLogoOnReceipt !== false,
    showLogoOnInvoice: s?.showLogoOnInvoice !== false,
    logoBase64: s?.logoBase64 || '',
    logoUrl: s?.logoUrl || '',
    ppnPercent: s?.ppnPercent ?? 11,
  };
  const normalized = sanitizeStoreSettings(raw) || raw;
  return {
    ...normalized,
    logoBase64: logoUrlFromSettings(raw),
  };
}
