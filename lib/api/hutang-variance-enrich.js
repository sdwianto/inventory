// Hitung / lengkapi variance PO → SO → Invoice untuk tagihan vendor.

import { sumPoEstimasi } from '@/lib/api/po-estimasi';

export async function findPoForHutang(db, hutang) {
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

export function poEstimasiFromDoc(po) {
  if (!po) return 0;
  const stored = parseInt(po.estimasiTotal || 0, 10);
  if (stored > 0) return stored;

  const fromLines = sumPoEstimasi(po.items);
  if (fromLines > 0) return fromLines;

  return (po.items || []).reduce((sum, it) => {
    const qty = parseFloat(it.qty) || 0;
    const harga = parseInt(it.estimasiHarga || it.hargaBeliReferensi || it.harga || 0, 10);
    return sum + Math.round(qty * harga);
  }, 0);
}

export function soTotalFromPo(po) {
  return parseInt(po?.vendorSoSnapshot?.total || 0, 10);
}

export async function grnReceivedTotalForHutang(db, hutang) {
  const tid = hutang.tenantId || 'default';
  const filter = { tenantId: tid, status: 'POSTED' };
  if (hutang.noDO) filter.noDO = hutang.noDO;
  else if (hutang.noPO) filter.noPO = hutang.noPO;
  else return 0;

  const grns = await db.collection('goods_receipts').find(filter).toArray();
  return grns.reduce((sum, grn) => sum + (parseInt(grn.receivedTotal || 0, 10) || 0), 0);
}

export function buildVarianceNumbers({ poEstimasiTotal = 0, soTotal = 0, invoiceTotal = 0 }) {
  const po = parseInt(poEstimasiTotal || 0, 10);
  const so = parseInt(soTotal || 0, 10);
  const inv = parseInt(invoiceTotal || 0, 10);
  return {
    poEstimasiTotal: po,
    soTotal: so,
    invoiceTotal: inv,
    variancePoToSo: so - po,
    varianceSoToInvoice: inv - so,
  };
}

export async function resolveHutangVariance(db, hutang, po = null) {
  const invoiceTotal = hutang.total || 0;
  let poEstimasiTotal = parseInt(hutang.poEstimasiTotal || 0, 10);
  let soTotal = parseInt(hutang.soTotal || 0, 10);

  const linkedPo = po || await findPoForHutang(db, hutang);
  if (linkedPo) {
    if (!poEstimasiTotal) poEstimasiTotal = poEstimasiFromDoc(linkedPo);
    if (!soTotal) soTotal = soTotalFromPo(linkedPo);
  }

  if (!soTotal) {
    const grnTotal = await grnReceivedTotalForHutang(db, hutang);
    if (grnTotal > 0) soTotal = grnTotal;
  }

  return {
    ...buildVarianceNumbers({ poEstimasiTotal, soTotal, invoiceTotal }),
    customerPoId: hutang.customerPoId || linkedPo?.id || null,
    soSubTotal: parseInt(linkedPo?.vendorSoSnapshot?.subTotal || hutang.soSubTotal || 0, 10),
  };
}

export async function backfillHutangVarianceFields(db, tenantId) {
  const filter = { referenceType: 'VENDOR_INVOICE' };
  if (tenantId) filter.tenantId = tenantId;

  const rows = await db.collection('hutang').find(filter).limit(5000).toArray();
  const poNos = [...new Set(rows.map((h) => h.noPO).filter(Boolean))];
  const tid = tenantId || rows[0]?.tenantId || 'default';
  const poList = poNos.length
    ? await db.collection('customer_purchase_orders').find({ tenantId: tid, noPO: { $in: poNos } }).toArray()
    : [];
  const poByNo = new Map(poList.map((p) => [p.noPO, p]));

  let updated = 0;
  const now = new Date();

  for (const hutang of rows) {
    const po = hutang.noPO ? poByNo.get(hutang.noPO) : null;
    const variance = await resolveHutangVariance(db, hutang, po);
    const needsUpdate = (hutang.poEstimasiTotal || 0) !== variance.poEstimasiTotal
      || (hutang.soTotal || 0) !== variance.soTotal
      || (hutang.varianceSoToInvoice ?? 0) !== variance.varianceSoToInvoice
      || (hutang.variancePoToSo ?? 0) !== variance.variancePoToSo
      || (!hutang.customerPoId && variance.customerPoId);

    if (!needsUpdate) continue;

    await db.collection('hutang').updateOne(
      { id: hutang.id },
      {
        $set: {
          poEstimasiTotal: variance.poEstimasiTotal,
          soTotal: variance.soTotal,
          soSubTotal: variance.soSubTotal,
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
