// Hitung / lengkapi variance PO → SO → Invoice untuk tagihan vendor.

import type { Db } from 'mongodb';

import { computeLineEstimasi, sumPoEstimasi } from '@/lib/api/po-estimasi';
import { hutangVendorKey } from '@/lib/api/hutang-vendor-match';
import {
  buildVendorSoSnapshot,
  mergeVendorSoSnapshots,
  normalizeVendorSoSnapshotLines,
  resolveSoTotals,
  type VendorSoSnapshot,
} from '@/lib/api/vendor-so-snapshot';

import type { HutangDoc } from '@/types/documents';
import { asArray, asObject, type JsonObject } from '@/types/json';

export async function findPoForHutang(db: Db, hutang: HutangDoc) {
  const tid = hutang.tenantId || 'default';
  if (hutang.customerPoId) {
    const byId = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, id: hutang.customerPoId });
    if (byId) return byId;
  }
  if (hutang.noPO) {
    const byNo = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO: hutang.noPO });
    if (byNo) return byNo;
  }
  if (hutang.noSO) {
    const bySo = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, vendorNoSO: hutang.noSO });
    if (bySo) return bySo;
  }
  return null;
}

export function poEstimasiFromDoc(po: JsonObject | null | undefined) {
  if (!po) return 0;
  const stored = parseInt(String(po.estimasiTotal || 0), 10);
  if (stored > 0) return stored;

  const items = asArray(po.items) as JsonObject[];
  const fromLines = sumPoEstimasi(items);
  if (fromLines > 0) return fromLines;

  return items.reduce((sum, it) => {
    const qty = parseFloat(String(it.qty)) || 0;
    const harga = parseInt(String(it.estimasiHarga || it.hargaBeliReferensi || it.harga || 0), 10);
    return sum + Math.round(qty * harga);
  }, 0);
}

function isMultiVendorPo(po: JsonObject): boolean {
  const subs = asArray(po.vendorSubmissions) as JsonObject[];
  if (subs.length > 1) return true;
  return String(po.vendorTenantId || '') === 'multi';
}

function resolveVendorTenantForHutang(po: JsonObject, hutang: HutangDoc | null): string {
  const vid = hutangVendorKey(hutang?.vendorTenantId);
  if (vid) return vid;

  const subs = asArray(po.vendorSubmissions) as JsonObject[];
  if (!subs.length) return '';

  const soId = hutang?.salesOrderId;
  const noSO = hutang?.noSO;
  if (soId) {
    const sub = subs.find((s) => s.vendorSoId === soId);
    if (sub?.vendorTenantId) return hutangVendorKey(String(sub.vendorTenantId));
  }
  if (noSO) {
    const sub = subs.find((s) => s.vendorNoSO === noSO);
    if (sub?.vendorTenantId) return hutangVendorKey(String(sub.vendorTenantId));
  }
  if (subs.length === 1 && subs[0].vendorTenantId) {
    return hutangVendorKey(String(subs[0].vendorTenantId));
  }
  return '';
}

function poEstimasiFromItems(items: JsonObject[]) {
  const enriched = items.map((it) => computeLineEstimasi(it));
  const fromLines = sumPoEstimasi(enriched);
  if (fromLines > 0) return fromLines;
  return enriched.reduce((sum, it) => sum + (parseInt(String(it.estimasiJumlah || 0), 10) || 0), 0);
}

/** Estimasi PO per supplier — untuk PO multi-vendor jangan pakai total seluruh PO. */
export function poEstimasiForHutang(po: JsonObject | null | undefined, hutang: HutangDoc | null = null) {
  if (!po) return 0;
  if (!isMultiVendorPo(po)) return poEstimasiFromDoc(po);

  const targetVid = resolveVendorTenantForHutang(po, hutang);
  if (!targetVid) return 0;

  const items = asArray(po.items) as JsonObject[];
  let vendorItems = items.filter((it) => hutangVendorKey(String(it.vendorTenantId ?? '')) === targetVid);

  if (!vendorItems.length) {
    const snap = resolveSoSnapshotForPo(po, hutang);
    const snapKodes = new Set(
      asArray(snap?.items).map((it) => String((it as JsonObject).kode || '').trim()).filter(Boolean),
    );
    if (snapKodes.size) {
      vendorItems = items.filter((it) => {
        const k = String(it.kode || it.vendorKode || '').trim();
        return k && snapKodes.has(k);
      });
    }
  }

  if (vendorItems.length) {
    return poEstimasiFromItems(vendorItems);
  }
  return 0;
}

function submissionToSnapshot(sub: JsonObject | null | undefined) {
  const vendorSo = asObject(sub?.vendorSo);
  if (!Object.keys(vendorSo).length) return null;
  return buildVendorSoSnapshot({
    ...vendorSo,
    salesOrderId: sub?.vendorSoId || vendorSo.id,
    noSO: sub?.vendorNoSO || vendorSo.noSO,
    confirmedAt: vendorSo.confirmedAt || vendorSo.updatedAt,
  });
}

function rootSnapshotForHutang(
  po: JsonObject,
  hutang: HutangDoc | null,
): VendorSoSnapshot | null {
  const root = po.vendorSoSnapshot as VendorSoSnapshot | undefined;
  if (!root) return null;
  const soId = hutang?.salesOrderId || po.vendorSoId;
  const noSO = hutang?.noSO || po.vendorNoSO;
  if (soId && root.salesOrderId && String(root.salesOrderId) !== String(soId)) return null;
  if (noSO && root.noSO && String(root.noSO) !== String(noSO)) return null;
  return root;
}

/** Utamakan snapshot dengan lebih banyak baris (biasanya hasil sales_order.confirmed). */
function preferSnapshot(
  fromSubmission: VendorSoSnapshot | null,
  fromRoot: VendorSoSnapshot | null,
): VendorSoSnapshot | null {
  if (!fromSubmission) return fromRoot;
  if (!fromRoot) return fromSubmission;
  const subItems = fromSubmission.items?.length || 0;
  const rootItems = fromRoot.items?.length || 0;
  if (rootItems > subItems) return fromRoot;
  if (rootItems === subItems && rootItems > 0) {
    const subAt = fromSubmission.confirmedAt ? new Date(fromSubmission.confirmedAt).getTime() : 0;
    const rootAt = fromRoot.confirmedAt ? new Date(fromRoot.confirmedAt).getTime() : 0;
    if (rootAt > subAt) return fromRoot;
  }
  return fromSubmission;
}

/** Pilih snapshot SO yang cocok dengan tagihan (multi-vendor / multi-SO). */
export function resolveSoSnapshotForPo(
  po: JsonObject | null | undefined,
  hutang: HutangDoc | null = null,
): VendorSoSnapshot | null {
  if (!po) return null;

  const subs = (Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions : []) as JsonObject[];
  const vTenant = hutang?.vendorTenantId;
  const soId = hutang?.salesOrderId;
  const noSO = hutang?.noSO;

  const rootSnap = rootSnapshotForHutang(po, hutang);

  if (vTenant && subs.length) {
    const byTenant = subs.find((s) => s.vendorTenantId === vTenant);
    const snap = preferSnapshot(submissionToSnapshot(byTenant), rootSnap);
    if (snap) return normalizeVendorSoSnapshotLines(snap);
  }
  if (soId && subs.length) {
    const byId = subs.find((s) => s.vendorSoId === soId);
    const snap = preferSnapshot(submissionToSnapshot(byId), rootSnap);
    if (snap) return normalizeVendorSoSnapshotLines(snap);
  }
  if (noSO && subs.length) {
    const byNo = subs.find((s) => s.vendorNoSO === noSO);
    const snap = preferSnapshot(submissionToSnapshot(byNo), rootSnap);
    if (snap) return normalizeVendorSoSnapshotLines(snap);
  }

  if (rootSnap) return normalizeVendorSoSnapshotLines(rootSnap);

  if (subs.length) {
    const snaps = subs.map(submissionToSnapshot).filter(Boolean);
    return normalizeVendorSoSnapshotLines(mergeVendorSoSnapshots(snaps));
  }

  return null;
}

export function soTotalFromPo(po: JsonObject | null | undefined, hutang: HutangDoc | null = null) {
  const snap = resolveSoSnapshotForPo(po, hutang);
  return resolveSoTotals(snap).total;
}

export async function grnReceivedTotalForHutang(db: Db, hutang: HutangDoc) {
  const tid = hutang.tenantId || 'default';
  const filter: Record<string, unknown> = { tenantId: tid, status: 'POSTED' };
  if (hutang.noDO) {
    filter.noDO = hutang.noDO;
  } else if (hutang.noPO) {
    filter.noPO = hutang.noPO;
    const vid = hutangVendorKey(hutang.vendorTenantId);
    if (vid) filter.vendorTenantId = hutang.vendorTenantId;
  } else {
    return 0;
  }

  const grns = await db.collection('goods_receipts').find(filter).toArray();
  return grns.reduce((sum, grn) => sum + (parseInt(String(grn.receivedTotal || 0), 10) || 0), 0);
}

/** Baca variance dari field tersimpan di dokumen hutang — tanpa query tambahan. */
export function readHutangVarianceFromDoc(hutang: HutangDoc) {
  const invoiceTotal = parseInt(String(hutang.total || 0), 10);
  const poEstimasiTotal = parseInt(String(hutang.poEstimasiTotal || 0), 10);
  const soTotal = parseInt(String(hutang.soTotal || 0), 10);
  const grnReceivedTotal = parseInt(String(hutang.grnReceivedTotal || 0), 10);
  const nums = buildVarianceNumbers({ poEstimasiTotal, soTotal, invoiceTotal });
  return {
    ...nums,
    grnReceivedTotal,
    customerPoId: hutang.customerPoId || null,
    soSubTotal: parseInt(String(hutang.soSubTotal || 0), 10) || soTotal,
    varianceGrnToInvoice: invoiceTotal - grnReceivedTotal,
  };
}

export function buildVarianceNumbers({ poEstimasiTotal = 0, soTotal = 0, invoiceTotal = 0 }) {
  const po = parseInt(String(poEstimasiTotal || 0), 10);
  const so = parseInt(String(soTotal || 0), 10);
  const inv = parseInt(String(invoiceTotal || 0), 10);
  return {
    poEstimasiTotal: po,
    soTotal: so,
    invoiceTotal: inv,
    variancePoToSo: so - po,
    varianceSoToInvoice: inv - so,
  };
}

/**
 * Hitung variance dari PO + hutang — selalu utamakan data PO/SO terbaru, bukan field stale di hutang.
 * GRN dikembalikan terpisah (bukan pengganti nilai SO).
 */
export async function resolveHutangVariance(
  db: Db,
  hutang: HutangDoc,
  po: JsonObject | null = null,
) {
  const invoiceTotal = parseInt(String(hutang.total || 0), 10);
  const linkedPo = (po || await findPoForHutang(db, hutang)) as JsonObject | null;

  const poEstimasiTotal = linkedPo
    ? poEstimasiForHutang(linkedPo, hutang)
    : parseInt(String(hutang.poEstimasiTotal || 0), 10);

  const snap = linkedPo ? resolveSoSnapshotForPo(linkedPo, hutang) : null;
  let { subTotal: soSubTotal, total: soTotal } = resolveSoTotals(snap);

  const salesOrderTotal = parseInt(String(hutang.salesOrderTotal || 0), 10);
  if (salesOrderTotal > soTotal) {
    soTotal = salesOrderTotal;
    if (!soSubTotal) soSubTotal = parseInt(String(hutang.salesOrderSubTotal || 0), 10) || salesOrderTotal;
  }

  const grnReceivedTotal = await grnReceivedTotalForHutang(db, hutang);

  return {
    ...buildVarianceNumbers({ poEstimasiTotal, soTotal, invoiceTotal }),
    grnReceivedTotal,
    customerPoId: hutang.customerPoId || linkedPo?.id || null,
    soSubTotal,
    varianceGrnToInvoice: invoiceTotal - grnReceivedTotal,
  };
}

type LineQtyRow = { kode: string; uomId?: string; satuan?: string; qty: number };

function normalizeKode(kode: string): string {
  return String(kode || '').trim().toUpperCase();
}

function normalizeSatuan(satuan?: string): string {
  return String(satuan || '').trim().toUpperCase();
}

function lineBucketKey(kode: string, uomId?: string, satuan?: string): string {
  const k = normalizeKode(kode);
  if (!k) return '';
  // Prioritas satuan agar baris PO (uomId lokal) dan invoice (satuan vendor) tetap satu bucket.
  const sat = normalizeSatuan(satuan);
  if (sat) return `${k}::${sat}`;
  const uom = String(uomId || '').trim();
  if (uom) return `${k}::${uom}`;
  return `${k}::_default`;
}

function collectLineQty(items: JsonObject[], qtyField: string): Map<string, LineQtyRow> {
  const map = new Map<string, LineQtyRow>();
  for (const it of items) {
    const kode = String(it.kode || it.vendorKode || it.localKode || '').trim();
    if (!kode) continue;
    const key = lineBucketKey(kode, String(it.uomId || ''), String(it.satuan || ''));
    const qty = parseFloat(String(
      qtyField === 'qty'
        ? (it.qty ?? it.qtyOrdered ?? 0)
        : (it[qtyField] ?? it.qty ?? it.qtyOrdered ?? 0),
    )) || 0;
    const prev = map.get(key);
    if (prev) prev.qty += qty;
    else {
      map.set(key, {
        kode,
        uomId: it.uomId ? String(it.uomId) : undefined,
        satuan: it.satuan ? String(it.satuan) : undefined,
        qty,
      });
    }
  }
  return map;
}

/** Variance per baris kode+UOM — PO vs SO snapshot vs invoice (P1.3b). */
export function buildLineVarianceByUom(params: {
  poItems?: JsonObject[];
  soItems?: JsonObject[];
  invoiceItems?: JsonObject[];
}) {
  const poMap = collectLineQty(params.poItems || [], 'qty');
  const soMap = collectLineQty(params.soItems || [], 'qty');
  const invMap = collectLineQty(params.invoiceItems || [], 'qty');
  const keys = new Set([...poMap.keys(), ...soMap.keys(), ...invMap.keys()]);
  const rows: Array<{
    kode: string;
    uomId?: string;
    satuan: string;
    poQty: number;
    soQty: number;
    invoiceQty: number;
    variancePoToSo: number;
    varianceSoToInvoice: number;
  }> = [];

  for (const key of keys) {
    const po = poMap.get(key);
    const so = soMap.get(key);
    const inv = invMap.get(key);
    const poQty = po?.qty || 0;
    const soQty = so?.qty || 0;
    const invoiceQty = inv?.qty || 0;
    rows.push({
      kode: po?.kode || so?.kode || inv?.kode || key.split('::')[0],
      uomId: po?.uomId || so?.uomId || inv?.uomId,
      satuan: po?.satuan || so?.satuan || inv?.satuan || (key.split('::')[1] === '_default' ? '—' : key.split('::')[1]) || '—',
      poQty,
      soQty,
      invoiceQty,
      variancePoToSo: soQty - poQty,
      varianceSoToInvoice: invoiceQty - soQty,
    });
  }

  return rows
    .filter((row) => row.poQty !== 0 || row.soQty !== 0 || row.invoiceQty !== 0)
    .sort((a, b) => a.kode.localeCompare(b.kode) || a.satuan.localeCompare(b.satuan));
}

export async function backfillHutangVarianceFields(db: Db, tenantId: string | null | undefined) {
  const filter: Record<string, unknown> = { referenceType: 'VENDOR_INVOICE' };
  if (tenantId) filter.tenantId = tenantId;

  const rows = await db.collection('hutang').find(filter).limit(5000).toArray();
  const poNos = [...new Set(rows.map((h) => h.noPO).filter(Boolean))];
  const tid = tenantId || rows[0]?.tenantId || 'default';
  const poList = poNos.length
    ? await db.collection('customer_purchase_orders').find({ tenantId: tid, noPO: { $in: poNos } }).toArray()
    : [];
  const poByNo = new Map(poList.map((p) => [String(p.noPO), p as JsonObject]));

  let updated = 0;
  const now = new Date();
  const bulkOps: { updateOne: { filter: { id: string }; update: { $set: Record<string, unknown> } } }[] = [];

  for (const hutang of rows) {
    const po = hutang.noPO ? poByNo.get(String(hutang.noPO)) : null;
    const variance = await resolveHutangVariance(db, hutang as HutangDoc, po || null);
    const needsUpdate = (hutang.poEstimasiTotal || 0) !== variance.poEstimasiTotal
      || (hutang.soTotal || 0) !== variance.soTotal
      || (hutang.varianceSoToInvoice ?? 0) !== variance.varianceSoToInvoice
      || (hutang.variancePoToSo ?? 0) !== variance.variancePoToSo
      || (hutang.grnReceivedTotal || 0) !== variance.grnReceivedTotal
      || (!hutang.customerPoId && variance.customerPoId);

    if (!needsUpdate) continue;

    bulkOps.push({
      updateOne: {
        filter: { id: hutang.id },
        update: {
          $set: {
            poEstimasiTotal: variance.poEstimasiTotal,
            soTotal: variance.soTotal,
            soSubTotal: variance.soSubTotal,
            grnReceivedTotal: variance.grnReceivedTotal,
            variancePoToSo: variance.variancePoToSo,
            varianceSoToInvoice: variance.varianceSoToInvoice,
            customerPoId: variance.customerPoId,
            updatedAt: now,
          },
        },
      },
    });
  }

  const BATCH = 200;
  for (let i = 0; i < bulkOps.length; i += BATCH) {
    const chunk = bulkOps.slice(i, i + BATCH);
    const result = await db.collection('hutang').bulkWrite(chunk);
    updated += result.modifiedCount || 0;
  }

  return { updated, scanned: rows.length };
}
