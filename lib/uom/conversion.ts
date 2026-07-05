import type { NormalizedUomInput, ProductUom, UomInput } from '@/lib/uom/types';

function parseIntPrice(v: unknown): number {
  const n = parseInt(String(v ?? 0), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseFactor(v: unknown): number {
  const n = parseFloat(String(v ?? 0));
  if (!Number.isFinite(n) || n <= 0) return NaN;
  return n;
}

/** Qty transaksi → qty satuan dasar. */
export function toBaseQty(qty: number, factorToBase: number): number {
  const q = parseFloat(String(qty)) || 0;
  const f = parseFactor(factorToBase);
  if (!Number.isFinite(f)) return q;
  return q * f;
}

/** Qty satuan dasar → qty dalam satuan alternatif (tampilan). */
export function fromBaseQty(qtyBase: number, factorToBase: number): number {
  const q = parseFloat(String(qtyBase)) || 0;
  const f = parseFactor(factorToBase);
  if (!Number.isFinite(f) || f === 0) return q;
  return q / f;
}

export function lineQtyToBase(
  qty: number,
  uom: Pick<ProductUom, 'factorToBase'>,
): number {
  return toBaseQty(qty, uom.factorToBase);
}

/** Fallback transaksi lama tanpa uomId. */
export function legacyLineQtyToBase(qty: number): number {
  return parseFloat(String(qty)) || 0;
}

export function validateAndNormalizeUomInputs(
  inputs: UomInput[],
): { ok: true; uoms: NormalizedUomInput[] } | { ok: false; error: string } {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return { ok: false, error: 'Minimal satu satuan produk wajib diisi' };
  }

  const normalized: NormalizedUomInput[] = [];
  const satuanSeen = new Set<string>();
  let baseCount = 0;

  for (let i = 0; i < inputs.length; i++) {
    const raw = inputs[i] || {};
    const satuan = String(raw.satuan || '').trim().toUpperCase();
    if (!satuan) return { ok: false, error: `Satuan baris ${i + 1} wajib diisi` };
    if (satuanSeen.has(satuan)) {
      return { ok: false, error: `Satuan "${satuan}" duplikat dalam satu produk` };
    }
    satuanSeen.add(satuan);

    const factorToBase = parseFactor(raw.factorToBase ?? (raw.isBase ? 1 : undefined));
    if (!Number.isFinite(factorToBase)) {
      return { ok: false, error: `Faktor konversi satuan "${satuan}" tidak valid` };
    }
    if (Math.round(factorToBase) !== factorToBase) {
      return { ok: false, error: `Faktor konversi "${satuan}" harus bilangan bulat (v1)` };
    }

    const isBase = raw.isBase === true;
    if (isBase) {
      baseCount += 1;
      if (factorToBase !== 1) {
        return { ok: false, error: 'Satuan dasar harus memiliki faktor konversi = 1' };
      }
    }

    normalized.push({
      satuan,
      isBase,
      factorToBase,
      barcode: String(raw.barcode || '').trim(),
      sortOrder: parseInt(String(raw.sortOrder ?? i), 10) || i,
      hargaEcer: parseIntPrice(raw.hargaEcer),
      hargaGrosir: parseIntPrice(raw.hargaGrosir),
      hargaSpesial: parseIntPrice(raw.hargaSpesial),
      aktif: raw.aktif !== false,
      vendorUomId: raw.vendorUomId ? String(raw.vendorUomId).trim() : undefined,
    });
  }

  if (baseCount !== 1) {
    return { ok: false, error: 'Tepat satu satuan harus ditandai sebagai satuan dasar' };
  }

  normalized.sort((a, b) => a.sortOrder - b.sortOrder || a.satuan.localeCompare(b.satuan));
  return { ok: true, uoms: normalized };
}

/** Payload legacy (satu satuan) → array UOM. */
export function uomInputsFromLegacyProductBody(body: Record<string, unknown>): UomInput[] {
  const satuan = String(body.satuan || 'PCS').trim().toUpperCase();
  return [{
    satuan,
    isBase: true,
    factorToBase: 1,
    barcode: String(body.barcode || ''),
    hargaEcer: parseIntPrice(body.hargaEcer),
    hargaGrosir: parseIntPrice(body.hargaGrosir),
    hargaSpesial: parseIntPrice(body.hargaSpesial),
    sortOrder: 0,
    aktif: true,
  }];
}

export function resolveUomInputsFromProductBody(body: Record<string, unknown>): UomInput[] {
  if (Array.isArray(body.uoms) && body.uoms.length > 0) {
    return body.uoms as UomInput[];
  }
  return uomInputsFromLegacyProductBody(body);
}

export function pickBaseUom(uoms: ProductUom[]): ProductUom | null {
  return uoms.find((u) => u.isBase) || uoms[0] || null;
}

export function formatDualQtyDisplay(
  qtyBase: number,
  baseSatuan: string,
  altUom?: Pick<ProductUom, 'satuan' | 'factorToBase' | 'isBase'> | null,
): string {
  const base = Math.round((parseFloat(String(qtyBase)) || 0) * 1000) / 1000;
  if (!altUom || altUom.isBase || altUom.factorToBase <= 1) {
    return `${base} ${baseSatuan}`;
  }
  const altRounded = Math.round(fromBaseQty(base, altUom.factorToBase) * 100) / 100;
  return `${base} ${baseSatuan} (≈ ${altRounded} ${altUom.satuan})`;
}
