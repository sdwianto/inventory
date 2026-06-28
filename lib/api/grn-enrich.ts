// Enrich GRN dengan nama vendor tenant + no. invoice dari hutang.

import type { Db } from 'mongodb';
import { getVendorTenantNameMap } from '@/lib/api/vendor-tenants';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';

type GrnRow = Record<string, unknown> & {
  vendorTenantId?: string;
  noDO?: string;
  noInvoice?: string | null;
  tenantId?: string;
};

export async function resolveVendorTenantName(
  db: Db,
  tenantId: string,
  vendorTenantId: string | null | undefined,
): Promise<string> {
  const tid = tenantId || 'default';
  const vid = String(vendorTenantId || '').trim();
  if (!vid) return '';

  const row = await db.collection('vendor_tenants').findOne({ tenantId: tid, vendorTenantId: vid });
  if (row?.vendorTenantName) return String(row.vendorTenantName);

  const integ = await db.collection('integration_settings').findOne({ tenantId: tid });
  if (integ?.vendorTenantId === vid && integ?.vendorName) return String(integ.vendorName);

  return vid;
}

export async function enrichGrnList(
  db: Db,
  tenantId: string | null | undefined,
  grns: GrnRow[],
): Promise<GrnRow[]> {
  const tid = tenantId || 'default';
  if (!grns?.length) return [];

  const nameMap = await getVendorTenantNameMap(db, tid);
  const integ = await db.collection('integration_settings').findOne({ tenantId: tid });

  const noDOs = [...new Set(grns.map((g) => g.noDO).filter(Boolean))] as string[];
  const hutangRows = noDOs.length
    ? await db.collection('hutang').find({
      ...tenantIdMatchFilter(tid),
      noDO: { $in: noDOs },
      referenceType: 'VENDOR_INVOICE',
    }).project({ noDO: 1, noInvoice: 1 }).toArray()
    : [];
  const invoiceByDo = Object.fromEntries(
    hutangRows.map((h) => [String(h.noDO), h.noInvoice]),
  ) as Record<string, string | undefined>;

  return grns.map((grn) => {
    const vid = grn.vendorTenantId;
    let vendorTenantName = vid ? nameMap[vid] : undefined;
    if (!vendorTenantName && integ && integ.vendorTenantId === vid) vendorTenantName = String(integ.vendorName || '');
    if (!vendorTenantName) vendorTenantName = vid || '';
    const noInvoice = grn.noInvoice || invoiceByDo[String(grn.noDO || '')] || null;

    return {
      ...grn,
      vendorTenantName,
      supplierName: vendorTenantName,
      vendorName: vendorTenantName,
      noInvoice,
    };
  });
}

export async function enrichGrnDoc(
  db: Db,
  grn: GrnRow | null | undefined,
): Promise<GrnRow | null | undefined> {
  if (!grn) return grn;
  const [enriched] = await enrichGrnList(db, grn.tenantId, [grn]);
  return enriched;
}
