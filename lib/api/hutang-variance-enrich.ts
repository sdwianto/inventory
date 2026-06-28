// Hitung / lengkapi variance PO → SO → Invoice untuk tagihan vendor.

import type { Db } from 'mongodb';

import { sumPoEstimasi } from '@/lib/api/po-estimasi';
import {
  buildVendorSoSnapshot,
  mergeVendorSoSnapshots,
  resolveSoTotals,
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

/** Pilih snapshot SO yang cocok dengan tagihan (multi-vendor / multi-SO). */
export function resolveSoSnapshotForPo(po: JsonObject | null | undefined, hutang: HutangDoc | null = null) {
  if (!po) return null;

  const subs = (Array.isArray(po.vendorSubmissions) ? po.vendorSubmissions : []) as JsonObject[];
  const vTenant = hutang?.vendorTenantId;
  const soId = hutang?.salesOrderId;
  const noSO = hutang?.noSO;

  if (vTenant && subs.length) {
    const byTenant = subs.find((s) => s.vendorTenantId === vTenant);
    const snap = submissionToSnapshot(byTenant);
    if (snap) return snap;
  }
  if (soId && subs.length) {
    const byId = subs.find((s) => s.vendorSoId === soId);
    const snap = submissionToSnapshot(byId);
    if (snap) return snap;
  }
  if (noSO && subs.length) {
    const byNo = subs.find((s) => s.vendorNoSO === noSO);
    const snap = submissionToSnapshot(byNo);
    if (snap) return snap;
  }

  if (po.vendorSoSnapshot) return po.vendorSoSnapshot;

  if (subs.length) {
    const snaps = subs.map(submissionToSnapshot).filter(Boolean);
    return mergeVendorSoSnapshots(snaps);
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
  if (hutang.noDO) filter.noDO = hutang.noDO;
  else if (hutang.noPO) filter.noPO = hutang.noPO;
  else return 0;

  const grns = await db.collection('goods_receipts').find(filter).toArray();
  return grns.reduce((sum, grn) => sum + (parseInt(String(grn.receivedTotal || 0), 10) || 0), 0);
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
    ? poEstimasiFromDoc(linkedPo)
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

    await db.collection('hutang').updateOne(
      { id: hutang.id },
      {
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
    );
    updated += 1;
  }

  return { updated, scanned: rows.length };
}
