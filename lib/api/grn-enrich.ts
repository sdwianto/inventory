// Enrich GRN dengan nama vendor tenant + no. invoice dari hutang.

import type { Db } from 'mongodb';
import { getVendorTenantNameMap } from '@/lib/api/vendor-tenants';
import { listActiveLinksForCustomer } from '@/lib/api/integration-links';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';

type GrnRow = Record<string, unknown> & {
  vendorTenantId?: string;
  noDO?: string;
  noPO?: string;
  noInvoice?: string | null;
  tenantId?: string;
  tanggal?: unknown;
  shippedAt?: unknown;
  tanggalPermintaanKirim?: unknown;
  tanggalAktualKirim?: unknown;
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

  const link = await db.collection('integration_links').findOne({
    customerTenantId: tid,
    vendorTenantId: vid,
    status: 'ACTIVE',
  });
  if (link?.vendorName) return String(link.vendorName);

  return vid;
}

/** Ambil tanggal permintaan kirim (PO.tanggalKedatangan) per noPO. */
export async function loadPoRequestedShipDatesByNoPo(
  db: Db,
  tenantId: string,
  noPOs: string[],
): Promise<Record<string, Date>> {
  const unique = [...new Set(noPOs.map((n) => String(n || '').trim()).filter(Boolean))];
  if (!unique.length) return {};
  const rows = await db.collection('customer_purchase_orders').find({
    tenantId,
    noPO: { $in: unique },
  }).project({ noPO: 1, tanggalKedatangan: 1, tanggal: 1 }).toArray();

  const out: Record<string, Date> = {};
  for (const row of rows) {
    const noPO = String(row.noPO || '').trim();
    if (!noPO) continue;
    const raw = row.tanggalKedatangan || row.tanggal;
    if (!raw) continue;
    const d = new Date(String(raw));
    if (!Number.isNaN(d.getTime())) out[noPO] = d;
  }
  return out;
}

export async function enrichGrnList(
  db: Db,
  tenantId: string | null | undefined,
  grns: GrnRow[],
): Promise<GrnRow[]> {
  const tid = tenantId || 'default';
  if (!grns?.length) return [];

  const nameMap = await getVendorTenantNameMap(db, tid);
  const links = await listActiveLinksForCustomer(db, tid);
  const linkNameByVid = Object.fromEntries(
    links.map((l) => [l.vendorTenantId, l.vendorName]),
  ) as Record<string, string>;

  const noDOs = [...new Set(grns.map((g) => g.noDO).filter(Boolean))] as string[];
  const hutangRows = noDOs.length
    ? await db.collection('hutang').find({
      ...tenantIdMatchFilter(tid),
      noDO: { $in: noDOs },
      referenceType: 'VENDOR_INVOICE',
    }).project({ noDO: 1, noInvoice: 1, vendorTenantId: 1 }).toArray()
    : [];
  const invoiceByDoVendor = Object.fromEntries(
    hutangRows.map((h) => [
      `${String(h.noDO)}:${String(h.vendorTenantId || '')}`,
      h.noInvoice,
    ]),
  ) as Record<string, string | undefined>;

  const missingPoDateNos = grns
    .filter((g) => !g.tanggalPermintaanKirim && g.noPO)
    .map((g) => String(g.noPO));
  const poDates = await loadPoRequestedShipDatesByNoPo(db, tid, missingPoDateNos);

  return grns.map((grn) => {
    const vid = grn.vendorTenantId;
    let vendorTenantName = vid ? nameMap[vid] : undefined;
    if (!vendorTenantName && vid) vendorTenantName = linkNameByVid[vid];
    if (!vendorTenantName) vendorTenantName = vid || '';
    const doVendorKey = `${String(grn.noDO || '')}:${String(vid || '')}`;
    const noInvoice = grn.noInvoice || invoiceByDoVendor[doVendorKey] || null;

    const noPO = String(grn.noPO || '').trim();
    const tanggalPermintaanKirim = grn.tanggalPermintaanKirim
      || (noPO ? poDates[noPO] : undefined)
      || null;
    const tanggalAktualKirim = grn.tanggalAktualKirim || grn.shippedAt || grn.tanggal || null;

    return {
      ...grn,
      vendorTenantName,
      supplierName: vendorTenantName,
      vendorName: vendorTenantName,
      noInvoice,
      tanggalPermintaanKirim,
      tanggalAktualKirim,
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

type ProductEmbed = {
  id?: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  gudangKode?: string;
};

export async function enrichGrnDocWithProducts(
  db: Db,
  grn: GrnRow | null | undefined,
): Promise<GrnRow | null | undefined> {
  const enriched = await enrichGrnDoc(db, grn);
  if (!enriched) return enriched;

  const items = Array.isArray(enriched.items) ? enriched.items as Record<string, unknown>[] : [];
  const stokIds = [...new Set(
    items.map((it) => String(it.localStokId || '').trim()).filter(Boolean),
  )];
  if (!stokIds.length) return enriched;

  const tid = String(enriched.tenantId || 'default');
  const products = await db.collection('products').find({
    tenantId: tid,
    id: { $in: stokIds },
  }).project({
    id: 1, kode: 1, nama: 1, satuan: 1, gudangKode: 1,
  }).toArray();

  const prodMap = new Map<string, ProductEmbed>(
    products.map((p) => [String(p.id), p as ProductEmbed]),
  );

  const itemsWithProducts = items.map((it) => {
    const localStokId = String(it.localStokId || '').trim();
    const product = localStokId ? prodMap.get(localStokId) || null : null;
    const gudangKode = product?.gudangKode || 'GKERING';
    return {
      ...it,
      product,
      gudangKode,
    };
  });

  return { ...enriched, items: itemsWithProducts };
}
