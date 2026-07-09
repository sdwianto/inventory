// Snapshot nilai SO vendor (sales.app) untuk variance PO vs SO vs invoice.

export interface VendorSoLineSnapshot {
  kode?: string;
  qty?: number;
  harga?: number;
  jumlah?: number;
  uomId?: string;
  qtyBase?: number | string;
  satuan?: string;
}

export interface VendorSoSnapshot {
  salesOrderId?: string | null;
  noSO?: string | null;
  subTotal?: number | string;
  ppn?: number | string;
  total?: number | string;
  items?: VendorSoLineSnapshot[];
  confirmedAt?: Date | string | null;
}

type VendorSoLineInput = {
  jumlah?: number | string;
  qty?: number | string;
  harga?: number | string;
  kode?: string;
  uomId?: string;
  qtyBase?: number | string;
  satuan?: string;
};

function lineJumlah(it: VendorSoLineInput): number {
  const jumlah = parseInt(String(it.jumlah || 0), 10);
  if (jumlah > 0) return jumlah;
  const qty = parseFloat(String(it.qty)) || 0;
  const harga = parseInt(String(it.harga || 0), 10);
  return Math.round(qty * harga);
}

/** Hitung subTotal / ppn / total dari snapshot — utamakan jumlah baris jika total header tidak konsisten. */
export function resolveSoTotals(snapshot: VendorSoSnapshot | null | undefined) {
  if (!snapshot) return { subTotal: 0, ppn: 0, total: 0, itemsSub: 0 };

  const items = snapshot.items || [];
  const itemsSub = items.reduce((s: number, it: VendorSoLineInput) => s + lineJumlah(it), 0);
  const declaredSub = parseInt(String(snapshot.subTotal || 0), 10);
  const subTotal = Math.max(declaredSub, itemsSub);
  const ppn = parseInt(String(snapshot.ppn || 0), 10);
  const declaredTotal = parseInt(String(snapshot.total || 0), 10);
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

export function buildVendorSoSnapshot(payload: Record<string, unknown> | null | undefined): VendorSoSnapshot | null {
  if (!payload) return null;

  const rawItems = Array.isArray(payload.items) ? payload.items as VendorSoLineInput[] : [];
  const items = rawItems.map((it) => {
    const qty = parseFloat(String(it.qty)) || 0;
    const harga = parseInt(String(it.harga || 0), 10);
    const jumlah = lineJumlah(it);
    return { kode: it.kode, qty, harga, jumlah, uomId: it.uomId, qtyBase: it.qtyBase, satuan: it.satuan };
  });

  const totals = resolveSoTotals({
    subTotal: payload.subTotal as number | string | undefined,
    ppn: payload.ppn as number | string | undefined,
    total: payload.total as number | string | undefined,
    items,
  });

  if (!totals.total && !items.length) return null;

  return {
    salesOrderId: (payload.salesOrderId || payload.id || null) as string | null,
    noSO: (payload.noSO || null) as string | null,
    subTotal: totals.subTotal,
    ppn: totals.ppn,
    total: totals.total,
    items,
    confirmedAt: payload.confirmedAt ? new Date(String(payload.confirmedAt)) : new Date(),
  };
}

/** Gabung beberapa snapshot SO (multi-vendor) menjadi satu ringkasan. */
export function mergeVendorSoSnapshots(snapshots: Array<VendorSoSnapshot | null | undefined>) {
  const valid = (snapshots || []).filter(Boolean) as VendorSoSnapshot[];
  if (!valid.length) return null;
  if (valid.length === 1) return valid[0];

  const items = valid.flatMap((s) => s.items || []);
  const subTotal = valid.reduce((s: number, snap) => s + (parseInt(String(snap.subTotal || 0), 10) || 0), 0);
  const ppn = valid.reduce((s: number, snap) => s + (parseInt(String(snap.ppn || 0), 10) || 0), 0);
  const total = valid.reduce((s: number, snap) => s + (parseInt(String(snap.total || 0), 10) || 0), 0);
  return {
    salesOrderId: valid.map((s) => s.salesOrderId).filter(Boolean).join(', ') || null,
    noSO: valid.map((s) => s.noSO).filter(Boolean).join(', ') || null,
    subTotal,
    ppn,
    total,
    items,
    confirmedAt: valid.reduce((latest: Date | null, s) => {
      const at = s.confirmedAt ? new Date(s.confirmedAt) : null;
      if (!at || Number.isNaN(at.getTime())) return latest;
      return !latest || at > latest ? at : latest;
    }, null as Date | null),
  };
}
