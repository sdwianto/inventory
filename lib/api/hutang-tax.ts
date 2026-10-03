// Nilai hutang dari invoice vendor — satu sumber untuk subTotal / diskonNota / DPP / PPN / total / glPostingBase.
// Mesin PPN identik dengan Sales `lib/tax/ppn.ts` (PPN per baris, diskon nota dialokasikan kumulatif) supaya
// koreksi qty dari GRN menghasilkan angka yang sama dengan yang akan dihitung vendor.

import { buildHutangPostingBase, type HutangPostingBase } from '@/lib/api/hutang-vendor-journal';

export type HutangTaxLine = {
  jumlah?: number | string;
  dpp?: number | string;
  ppn?: number | string;
};

export type HutangTaxPayload = {
  subTotal?: number | string;
  diskonNota?: number | string;
  ppn?: number | string;
  total?: number | string;
  dpp?: number | string;
  ppnRate?: number;
  hargaTermasukPajak?: boolean;
  items?: unknown[];
};

export type HutangTaxResult<T extends HutangTaxLine = HutangTaxLine> = {
  subTotal: number;
  diskonNota: number;
  dpp: number;
  ppn: number;
  total: number;
  ppnRate: number | null;
  hargaTermasukPajak: boolean;
  glPostingBase: HutangPostingBase;
  items: T[];
  /** Header invoice vendor konsisten (subTotal − diskon + PPN = total, toleransi Rp1). */
  taxCheck: { ok: boolean; expectedTotal: number; payloadTotal: number };
};

/** Pembulatan rupiah setengah ke atas dengan koreksi galat float — sama dengan Sales `roundRupiah`. */
export function roundRupiah(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const abs = Math.round(Math.abs(n) * 1e6) / 1e6;
  const r = Math.sign(n) * Math.round(abs);
  return Object.is(r, -0) ? 0 : r;
}

function int(v: unknown): number {
  return parseInt(String(v ?? 0), 10) || 0;
}

export function normalizePpnRate(rate: unknown): number {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.round(n * 100) / 100, 100);
}

export function allocateCumulative(amount: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  const a = roundRupiah(amount);
  if (!a || total <= 0) return weights.map(() => 0);
  let before = 0;
  return weights.map((w) => {
    const after = before + Math.max(0, w);
    const share = roundRupiah((a * after) / total) - roundRupiah((a * before) / total);
    before = after;
    return share;
  });
}

export function computeLinesPpn(input: {
  lines: Array<{ amount: number; taxable: boolean }>;
  headerDiscount: number;
  rate: number;
  inclusive: boolean;
}): { subTotal: number; discount: number; dpp: number; ppn: number; total: number; lines: Array<{ dpp: number; ppn: number }> } {
  const rate = normalizePpnRate(input.rate);
  const amounts = input.lines.map((l) => Math.max(0, roundRupiah(l.amount)));
  const subTotal = amounts.reduce((s, a) => s + a, 0);
  const discount = Math.min(Math.max(0, roundRupiah(input.headerDiscount)), subTotal);
  const allocs = allocateCumulative(discount, amounts);
  let dpp = 0;
  let ppn = 0;
  const lines = input.lines.map((l, i) => {
    const net = amounts[i] - allocs[i];
    let lineDpp = net;
    let linePpn = 0;
    if (l.taxable && rate > 0) {
      if (input.inclusive) {
        lineDpp = net > 0 ? roundRupiah((net * 100) / (100 + rate)) : 0;
        linePpn = net - lineDpp;
      } else {
        linePpn = net > 0 ? roundRupiah((net * rate) / 100) : 0;
      }
    }
    dpp += lineDpp;
    ppn += linePpn;
    return { dpp: lineDpp, ppn: linePpn };
  });
  const net = subTotal - discount;
  return { subTotal, discount, dpp, ppn, total: input.inclusive ? net : net + ppn, lines };
}

/** Field nilai yang disimpan di dokumen hutang. */
export function hutangTaxFields(tax: HutangTaxResult<HutangTaxLine>) {
  return {
    subTotal: tax.subTotal,
    diskonNota: tax.diskonNota,
    dpp: tax.dpp,
    ppn: tax.ppn,
    total: tax.total,
    ppnRate: tax.ppnRate,
    hargaTermasukPajak: tax.hargaTermasukPajak,
    glPostingBase: tax.glPostingBase,
  };
}

/** Nilai tagihan sebelum PPN (setelah diskon nota, termasuk debit note) — basis banding ke estimasi PO. */
export function hutangNetBeforePpn(h: { total?: unknown; ppn?: unknown }): number {
  return Math.max(0, int(h.total) - Math.max(0, int(h.ppn)));
}

/** Σ baris invoice sebelum diskon/PPN — basis banding ke nilai terima GRN (qty × harga). */
export function hutangLineSubTotal(h: {
  subTotal?: unknown; items?: unknown; total?: unknown; ppn?: unknown; diskonNota?: unknown;
}): number {
  const items = (Array.isArray(h.items) ? h.items : []) as Array<{ jumlah?: unknown }>;
  const fromItems = items.reduce((s, it) => s + int(it?.jumlah), 0);
  // Dokumen pra-kontrak pajak (tanpa diskonNota): repair lama mengoreksi baris/total tanpa ikut
  // memperbarui subTotal, jadi Σ baris lebih bisa dipercaya daripada subTotal tersimpan.
  if (h.diskonNota == null && fromItems > 0) return fromItems;
  const stored = int(h.subTotal);
  if (stored > 0) return stored;
  return fromItems > 0 ? fromItems : hutangNetBeforePpn(h);
}

export const TAX_TOTAL_MISMATCH = 'TAX_TOTAL_MISMATCH';

/** Hasil 3-way match digabung cek konsistensi header pajak; header tidak konsisten → EXCEPTION (review manual). */
export function hutangMatchVerdict(
  match: { ok?: boolean; error?: string | null; code?: string | null },
  tax: Pick<HutangTaxResult, 'taxCheck'>,
): { ok: boolean; error: string | null; code: string | null } {
  if (match.ok !== true) return { ok: false, error: match.error || null, code: match.code || null };
  if (!tax.taxCheck.ok) {
    return {
      ok: false,
      error: `Total invoice vendor tidak konsisten: subTotal − diskon + PPN = ${tax.taxCheck.expectedTotal}, total = ${tax.taxCheck.payloadTotal}`,
      code: TAX_TOTAL_MISMATCH,
    };
  }
  return { ok: true, error: null, code: null };
}

/** Baris bebas PPN hanya bila PPN-nya 0 padahal DPP-nya positif; baris terdiskon penuh (DPP 0) tetap kena PPN. */
function lineIsTaxable(it: HutangTaxLine): boolean {
  if (it.ppn == null || it.ppn === '') return true;
  if (int(it.ppn) > 0) return true;
  const base = it.dpp != null && it.dpp !== '' ? int(it.dpp) : int(it.jumlah);
  return base <= 0;
}

function sumJumlah(items: HutangTaxLine[]): number {
  return items.reduce((s, it) => s + int(it.jumlah), 0);
}

/**
 * `items` = baris yang akan disimpan (sudah dikoreksi ke qty GRN bila `corrected`).
 * Tanpa koreksi: header invoice vendor dipakai apa adanya. Dengan koreksi: invoice ber-basis pajak (`ppnRate`)
 * dihitung ulang per baris; payload lama (tanpa `ppnRate`) diskon & PPN diprorata dari subTotal.
 */
export function computeHutangFromInvoice<T extends HutangTaxLine>(
  payload: HutangTaxPayload,
  items: T[],
  corrected: boolean,
): HutangTaxResult<T> {
  const originalItems = (payload.items || []) as HutangTaxLine[];
  const inclusive = payload.hargaTermasukPajak === true;
  const ppnRate = typeof payload.ppnRate === 'number' ? normalizePpnRate(payload.ppnRate) : null;
  const pSub = int(payload.subTotal) || sumJumlah(originalItems);
  const pDiskon = Math.max(0, int(payload.diskonNota));
  const pPpn = Math.max(0, int(payload.ppn));
  const expectedTotal = inclusive ? pSub - pDiskon : pSub - pDiskon + pPpn;
  const payloadTotal = int(payload.total) || expectedTotal;
  const taxCheck = { ok: Math.abs(expectedTotal - payloadTotal) <= 1, expectedTotal, payloadTotal };

  if (!corrected) {
    const rawDpp = Number(payload.dpp);
    const dpp = payload.dpp != null && payload.dpp !== '' && Number.isFinite(rawDpp) ? Math.round(rawDpp) : payloadTotal - pPpn;
    return {
      subTotal: pSub,
      diskonNota: pDiskon,
      dpp,
      ppn: pPpn,
      total: payloadTotal,
      ppnRate,
      hargaTermasukPajak: inclusive,
      glPostingBase: buildHutangPostingBase(payloadTotal, pPpn),
      items,
      taxCheck,
    };
  }

  const newSub = sumJumlah(items);
  const diskon = pSub > 0 ? Math.min(newSub, roundRupiah((pDiskon * newSub) / pSub)) : 0;

  if (ppnRate != null) {
    const r = computeLinesPpn({
      lines: items.map((it) => ({ amount: int(it.jumlah), taxable: lineIsTaxable(it) })),
      headerDiscount: diskon,
      rate: ppnRate,
      inclusive,
    });
    return {
      subTotal: r.subTotal,
      diskonNota: r.discount,
      dpp: r.dpp,
      ppn: r.ppn,
      total: r.total,
      ppnRate,
      hargaTermasukPajak: inclusive,
      glPostingBase: buildHutangPostingBase(r.total, r.ppn),
      items: items.map((it, i) => ({ ...it, dpp: r.lines[i].dpp, ppn: r.lines[i].ppn }) as T),
      taxCheck,
    };
  }

  const ppn = pSub > 0 ? roundRupiah((pPpn * newSub) / pSub) : 0;
  const total = inclusive ? newSub - diskon : newSub - diskon + ppn;
  return {
    subTotal: newSub,
    diskonNota: diskon,
    dpp: total - ppn,
    ppn,
    total,
    ppnRate,
    hargaTermasukPajak: inclusive,
    glPostingBase: buildHutangPostingBase(total, ppn),
    items,
    taxCheck,
  };
}

/** Field pajak nota dari respons Sales (fallback push) — kosong bila Sales lama tanpa kontrak pajak. */
export function noteTaxPayloadFields(src: Record<string, unknown> | null | undefined): {
  subTotal?: number; ppn?: number; ppnRate?: number; hargaTermasukPajak?: boolean; dpp?: number;
} {
  if (!src) return {};
  const num = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const ppnRate = num(src.ppnRate);
  if (ppnRate === undefined) return {};
  const subTotal = num(src.subTotal);
  const ppn = num(src.ppn);
  const dpp = num(src.dpp);
  return {
    ppnRate,
    ...(subTotal !== undefined ? { subTotal } : {}),
    ...(ppn !== undefined ? { ppn } : {}),
    ...(dpp !== undefined ? { dpp } : {}),
    ...(typeof src.hargaTermasukPajak === 'boolean' ? { hargaTermasukPajak: src.hargaTermasukPajak } : {}),
  };
}
