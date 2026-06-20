// Snapshot nilai SO vendor (sales.app) untuk variance PO vs SO vs invoice.

export function buildVendorSoSnapshot(payload) {
  if (!payload) return null;

  const items = (payload.items || []).map((it) => {
    const qty = parseFloat(it.qty) || 0;
    const harga = parseInt(it.harga || 0, 10);
    const jumlah = parseInt(it.jumlah || 0, 10) || Math.round(qty * harga);
    return { kode: it.kode, qty, harga, jumlah };
  });

  const subTotal = parseInt(payload.subTotal || 0, 10)
    || items.reduce((s, it) => s + it.jumlah, 0);
  const ppn = parseInt(payload.ppn || 0, 10);
  const total = parseInt(payload.total || 0, 10) || subTotal + ppn;

  if (!total && !items.length) return null;

  return {
    salesOrderId: payload.salesOrderId || payload.id || null,
    noSO: payload.noSO || null,
    subTotal,
    ppn,
    total,
    items,
    confirmedAt: payload.confirmedAt ? new Date(payload.confirmedAt) : new Date(),
  };
}
