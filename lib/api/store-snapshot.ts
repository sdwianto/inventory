import type { Db } from 'mongodb';
// Snapshot toko untuk struk — dari tenant_settings (bukan placeholder mock).

import { sanitizeStoreSettings } from '@/lib/receipt-doc';

export async function loadStoreSnapshot(db: Db, tenantId, tenantNameFallback = '') {
  const tid = tenantId || 'default';
  const s = await db.collection('tenant_settings').findOne({ tenantId: tid });
  return sanitizeStoreSettings({
    tenantId: tid,
    companyName: s?.companyName || tenantNameFallback || tid,
    companyAddress: s?.companyAddress || '',
    companyPhone: s?.companyPhone || '',
    companyNPWP: s?.companyNPWP || '',
    receiptFooterText: s?.receiptFooterText || 'Terima Kasih',
    showLogoOnReceipt: s?.showLogoOnReceipt !== false,
    showLogoOnInvoice: s?.showLogoOnInvoice !== false,
    logoBase64: s?.logoBase64 || '',
    ppnPercent: s?.ppnPercent ?? 11,
  }) || {
    tenantId: tid,
    companyName: tenantNameFallback || tid,
    companyAddress: '',
    companyPhone: '',
    companyNPWP: '',
    receiptFooterText: 'Terima Kasih',
    showLogoOnReceipt: true,
    logoBase64: '',
  };
}
