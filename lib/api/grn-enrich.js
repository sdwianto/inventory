// Enrich GRN dengan nama vendor tenant + no. invoice dari hutang.

import { getVendorTenantNameMap } from '@/lib/api/vendor-tenants';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';

export async function resolveVendorTenantName(db, tenantId, vendorTenantId) {
  const tid = tenantId || 'default';
  const vid = String(vendorTenantId || '').trim();
  if (!vid) return '';

  const row = await db.collection('vendor_tenants').findOne({ tenantId: tid, vendorTenantId: vid });
  if (row?.vendorTenantName) return row.vendorTenantName;

  const integ = await db.collection('integration_settings').findOne({ tenantId: tid });
  if (integ?.vendorTenantId === vid && integ?.vendorName) return integ.vendorName;

  return vid;
}

export async function enrichGrnList(db, tenantId, grns) {
  const tid = tenantId || 'default';
  if (!grns?.length) return [];

  const nameMap = await getVendorTenantNameMap(db, tid);
  const integ = await db.collection('integration_settings').findOne({ tenantId: tid });

  const noDOs = [...new Set(grns.map((g) => g.noDO).filter(Boolean))];
  const hutangRows = noDOs.length
    ? await db.collection('hutang').find({
      ...tenantIdMatchFilter(tid),
      noDO: { $in: noDOs },
      referenceType: 'VENDOR_INVOICE',
    }).project({ noDO: 1, noInvoice: 1 }).toArray()
    : [];
  const invoiceByDo = Object.fromEntries(hutangRows.map((h) => [h.noDO, h.noInvoice]));

  return grns.map((grn) => {
    const vid = grn.vendorTenantId;
    let vendorTenantName = nameMap[vid];
    if (!vendorTenantName && integ?.vendorTenantId === vid) vendorTenantName = integ.vendorName;
    if (!vendorTenantName) vendorTenantName = vid || '';
    const noInvoice = grn.noInvoice || invoiceByDo[grn.noDO] || null;

    return {
      ...grn,
      vendorTenantName,
      supplierName: vendorTenantName,
      vendorName: vendorTenantName,
      noInvoice,
    };
  });
}

export async function enrichGrnDoc(db, grn) {
  if (!grn) return grn;
  const [enriched] = await enrichGrnList(db, grn.tenantId, [grn]);
  return enriched;
}
