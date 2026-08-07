/** Cocokkan baris CPO/GRN lokal ke baris webhook vendor (sales.app). */

export type LocalPoLineLike = {
  lineId?: string;
  localStokId?: string;
  vendorStokId?: string;
  vendorKode?: string;
  kode?: string;
  uomId?: string;
  vendorUomId?: string;
  satuan?: string;
};

function normalizeKode(kode?: string | null): string {
  return String(kode || '').trim().toUpperCase();
}

function normalizeSatuan(satuan?: string | null): string {
  return String(satuan || '').trim().toUpperCase();
}

export type VendorWebhookLineLike = {
  lineId?: string;
  stokId?: string;
  kode?: string;
  uomId?: string;
  qty?: number | string;
};

export type GrnLineLike = {
  lineId?: string;
  localStokId?: string;
  localKode?: string;
  vendorKode?: string;
  uomId?: string;
  satuan?: string;
  qtyReceived?: number | string;
};

export function findMatchingVendorWebhookLine<T extends VendorWebhookLineLike>(
  localLine: LocalPoLineLike,
  webhookItems: T[],
  usedIndices?: Set<number>,
): T | undefined {
  const used = usedIndices ?? new Set<number>();
  const vendorStokId = String(localLine.vendorStokId || '');

  if (localLine.lineId) {
    const idx = webhookItems.findIndex(
      (s, i) => !used.has(i) && s.lineId && String(s.lineId) === String(localLine.lineId),
    );
    if (idx >= 0) {
      used.add(idx);
      return webhookItems[idx];
    }
  }

  const vendorUomId = String(localLine.vendorUomId || localLine.uomId || '');
  if (vendorStokId && vendorUomId) {
    const idx = webhookItems.findIndex(
      (s, i) => !used.has(i)
        && String(s.stokId || '') === vendorStokId
        && String(s.uomId || '') === vendorUomId,
    );
    if (idx >= 0) {
      used.add(idx);
      return webhookItems[idx];
    }
  }

  const kode = String(localLine.vendorKode || localLine.kode || '').trim().toUpperCase();
  if (kode) {
    const matches = webhookItems
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => !used.has(i) && String(s.kode || '').trim().toUpperCase() === kode);
    if (matches.length === 1) {
      used.add(matches[0].i);
      return matches[0].s;
    }
  }

  if (vendorStokId) {
    const matches = webhookItems
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => !used.has(i) && String(s.stokId || '') === vendorStokId);
    if (matches.length === 1) {
      used.add(matches[0].i);
      return matches[0].s;
    }
  }

  return undefined;
}

export type LocalGrnLineLike = {
  lineId?: string;
  localStokId?: string;
  localKode?: string;
  vendorKode?: string;
  uomId?: string;
};

export function findMatchingGrnLine<T extends GrnLineLike>(
  poLine: LocalPoLineLike,
  grnItems: T[],
  usedIndices?: Set<number>,
): T | undefined {
  const used = usedIndices ?? new Set<number>();
  const localStokId = String(poLine.localStokId || '');

  if (poLine.lineId) {
    const idx = grnItems.findIndex(
      (g, i) => !used.has(i) && g.lineId && String(g.lineId) === String(poLine.lineId),
    );
    if (idx >= 0) {
      used.add(idx);
      return grnItems[idx];
    }
  }

  if (localStokId && poLine.uomId) {
    const idx = grnItems.findIndex(
      (g, i) => !used.has(i)
        && String(g.localStokId || '') === localStokId
        && String(g.uomId || '') === String(poLine.uomId),
    );
    if (idx >= 0) {
      used.add(idx);
      return grnItems[idx];
    }
  }

  // Fallback toleran: kode + satuan dinormalisasi (trim + uppercase). uomId
  // PO dan GRN bisa berasal dari sumber/webhook berbeda dan tidak selalu
  // sama persis walau produk & satuannya sama secara teks — tanpa fallback
  // ini, baris yang sebenarnya sudah diterima bisa nyangkut qtyReceived=0
  // dan bikin status PO salah PARTIAL_RECEIVED (lihat P0 hutang-approval).
  const kode = normalizeKode(poLine.vendorKode || poLine.kode);
  const satuan = normalizeSatuan(poLine.satuan);
  if (kode && satuan) {
    const matches = grnItems
      .map((g, i) => ({ g, i }))
      .filter(({ g, i }) => !used.has(i)
        && normalizeKode(g.vendorKode || g.localKode) === kode
        && normalizeSatuan(g.satuan) === satuan);
    if (matches.length === 1) {
      used.add(matches[0].i);
      return matches[0].g;
    }
  }

  if (kode) {
    const matches = grnItems
      .map((g, i) => ({ g, i }))
      .filter(({ g, i }) => !used.has(i) && (
        normalizeKode(g.vendorKode) === kode || normalizeKode(g.localKode) === kode
      ));
    if (matches.length === 1) {
      used.add(matches[0].i);
      return matches[0].g;
    }
  }

  return undefined;
}
