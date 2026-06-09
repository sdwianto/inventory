// 3-way match sederhana: Invoice vendor vs GRN yang sudah POSTED.

const DEFAULT_QTY_TOLERANCE_PCT = 0;
const DEFAULT_PRICE_TOLERANCE_PCT = 2;

export async function validateInvoiceAgainstGrn(db, tenantId, payload, opts = {}) {
  const qtyTol = opts.qtyTolerancePct ?? DEFAULT_QTY_TOLERANCE_PCT;
  const priceTol = opts.priceTolerancePct ?? DEFAULT_PRICE_TOLERANCE_PCT;
  const noDO = payload.noDO;

  if (!noDO) {
    return { ok: false, error: '3-way match: noDO wajib pada invoice vendor' };
  }

  const grns = await db.collection('goods_receipts').find({
    tenantId,
    noDO,
    status: 'POSTED',
  }).toArray();

  if (!grns.length) {
    return {
      ok: false,
      error: `3-way match gagal: belum ada GRN POSTED untuk DO ${noDO}. Post penerimaan barang dulu sebelum hutang dibuat.`,
      code: 'GRN_NOT_POSTED',
    };
  }

  const receivedByKode = new Map();
  let grnValue = 0;
  for (const grn of grns) {
    for (const it of grn.items || []) {
      const kode = it.vendorKode || it.localKode;
      const qty = parseFloat(it.qtyReceived) || 0;
      const harga = parseInt(it.harga || it.hargaBeliBaru || 0, 10);
      receivedByKode.set(kode, (receivedByKode.get(kode) || 0) + qty);
      grnValue += qty * harga;
    }
  }

  for (const invLine of payload.items || []) {
    const kode = invLine.kode;
    const invQty = parseFloat(invLine.qty) || 0;
    const recQty = receivedByKode.get(kode) || 0;
    const maxQty = recQty * (1 + qtyTol / 100);
    if (invQty > maxQty + 0.0001) {
      return {
        ok: false,
        error: `3-way match qty: ${kode} invoice ${invQty} > GRN posted ${recQty}`,
        code: 'QTY_MISMATCH',
      };
    }
  }

  const invTotal = parseInt(payload.total || 0, 10);
  const maxTotal = grnValue * (1 + priceTol / 100);
  if (invTotal > maxTotal + 1 && grnValue > 0) {
    return {
      ok: false,
      error: `3-way match harga: invoice Rp ${invTotal.toLocaleString('id-ID')} melebihi nilai GRN Rp ${grnValue.toLocaleString('id-ID')} (+${priceTol}% toleransi)`,
      code: 'PRICE_MISMATCH',
    };
  }

  return { ok: true, grnCount: grns.length, grnValue, invoiceTotal: invTotal };
}
