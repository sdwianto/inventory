// Snapshot nilai SO vendor (sales.app) untuk variance PO vs SO vs invoice.

function lineJumlah(it) {
  const jumlah = parseInt(it.jumlah || 0, 10);
  if (jumlah > 0) return jumlah;
  const qty = parseFloat(it.qty) || 0;
  const harga = parseInt(it.harga || 0, 10);
  return Math.round(qty * harga);
}

/** Hitung subTotal / ppn / total dari snapshot — utamakan jumlah baris jika total header tidak konsisten. */
export function resolveSoTotals(snapshot) {
  if (!snapshot) return { subTotal: 0, ppn: 0, total: 0, itemsSub: 0 };

  const items = snapshot.items || [];
  const itemsSub = items.reduce((s, it) => s + lineJumlah(it), 0);
  const declaredSub = parseInt(snapshot.subTotal || 0, 10);
  const subTotal = Math.max(declaredSub, itemsSub);
  const ppn = parseInt(snapshot.ppn || 0, 10);
  const declaredTotal = parseInt(snapshot.total || 0, 10);
  const computedTotal = subTotal + ppn;

  let total = declaredTotal;
  if (!total) {
    total = computedTotal;
  } else if (itemsSub > 0 && total < itemsSub * 0.9) {
    total = computedTotal;
  } else if (computedTotal > total && itemsSub > declaredSub) {
    total = computedTotal;
  }

  return { subTotal, ppn, total, itemsSub };
}

export function buildVendorSoSnapshot(payload) {
  if (!payload) return null;

  const items = (payload.items || []).map((it) => {
    const qty = parseFloat(it.qty) || 0;
    const harga = parseInt(it.harga || 0, 10);
    const jumlah = lineJumlah(it);
    return { kode: it.kode, qty, harga, jumlah };
  });

  const totals = resolveSoTotals({
    subTotal: payload.subTotal,
    ppn: payload.ppn,
    total: payload.total,
    items,
  });

  if (!totals.total && !items.length) return null;

  return {
    salesOrderId: payload.salesOrderId || payload.id || null,
    noSO: payload.noSO || null,
    subTotal: totals.subTotal,
    ppn: totals.ppn,
    total: totals.total,
    items,
    confirmedAt: payload.confirmedAt ? new Date(payload.confirmedAt) : new Date(),
  };
}

/** Gabung beberapa snapshot SO (multi-vendor) menjadi satu ringkasan. */
export function mergeVendorSoSnapshots(snapshots) {
  const valid = (snapshots || []).filter(Boolean);
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  const items = valid.flatMap((s) => s.items || []);
  const subTotal = valid.reduce((s, snap) => s + (parseInt(snap.subTotal || 0, 10) || 0), 0);
  const ppn = valid.reduce((s, snap) => s + (parseInt(snap.ppn || 0, 10) || 0), 0);
  const total = valid.reduce((s, snap) => s + (parseInt(snap.total || 0, 10) || 0), 0);
  return {
    salesOrderId: valid.map((s) => s.salesOrderId).filter(Boolean).join(', ') || null,
    noSO: valid.map((s) => s.noSO).filter(Boolean).join(', ') || null,
    subTotal,
    ppn,
    total,
    items,
    confirmedAt: valid.reduce((latest, s) => {
      const at = s.confirmedAt ? new Date(s.confirmedAt) : null;
      if (!at || Number.isNaN(at.getTime())) return latest;
      return !latest || at > latest ? at : latest;
    }, null),
  };
}
