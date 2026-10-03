// Laporan PPN Masukan per masa — tagihan vendor ber-PPN beserta status faktur pajak keluaran vendor.
// Masa = masa faktur bila faktur sudah diterima; tanpa faktur memakai tanggal invoice (WIB).

import type { Db } from 'mongodb';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { vendorHutangPostingBase } from '@/lib/api/hutang-vendor-journal';
import type { HutangDoc } from '@/types/documents';

export type PpnMasukanStatus = 'SIAP_DIKREDITKAN' | 'MENUNGGU_FAKTUR' | 'FAKTUR_BATAL' | 'TIDAK_DIKREDITKAN';

export const PPN_MASUKAN_STATUS_LABEL: Record<PpnMasukanStatus, string> = {
  SIAP_DIKREDITKAN: 'Siap dikreditkan',
  MENUNGGU_FAKTUR: 'Menunggu faktur',
  FAKTUR_BATAL: 'Faktur batal/diganti',
  TIDAK_DIKREDITKAN: 'Tidak dikreditkan (non-PKP)',
};

export type PpnMasukanRow = {
  hutangId: string;
  noHutang: string;
  noInvoice: string;
  tanggal: string | null;
  supplierName: string;
  vendorNPWP: string;
  approvalStatus: string;
  dpp: number;
  ppn: number;
  ppnRate: number | null;
  status: PpnMasukanStatus;
  nomorFaktur: string | null;
  fakturStatus: string | null;
  fakturMasa: string | null;
  fakturDpp: number | null;
  fakturPpn: number | null;
  /** PPN faktur − PPN tagihan; ≠ 0 perlu dicek sebelum dikreditkan. */
  selisihPpn: number | null;
};

export type PpnMasukanSummary = Record<PpnMasukanStatus, { count: number; dpp: number; ppn: number }> & {
  total: { count: number; dpp: number; ppn: number };
  selisihCount: number;
};

const MASA_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Rentang masa YYYY-MM dalam WIB (UTC+7), `to` eksklusif. */
export function masaRangeWib(masa: string): { from: Date; to: Date } | null {
  const m = MASA_RE.exec(String(masa || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const from = new Date(`${m[1]}-${m[2]}-01T00:00:00+07:00`);
  const nextY = mo === 12 ? y + 1 : y;
  const nextM = mo === 12 ? 1 : mo + 1;
  const to = new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00+07:00`);
  return { from, to };
}

function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

type FakturSnap = {
  nomorFaktur?: string | null;
  status?: string | null;
  aktif?: boolean;
  masa?: string | null;
  dpp?: number;
  ppn?: number;
};

export function classifyPpnMasukan(hutang: HutangDoc): PpnMasukanStatus {
  if (hutang.ppnDikreditkan === false) return 'TIDAK_DIKREDITKAN';
  const f = (hutang.fakturPajak || null) as FakturSnap | null;
  if (!f) return 'MENUNGGU_FAKTUR';
  const status = String(f.status || '').toUpperCase();
  if (status === 'BATAL' || status === 'DIGANTI' || f.aktif === false) return 'FAKTUR_BATAL';
  if (status === 'DISETUJUI' && f.nomorFaktur) return 'SIAP_DIKREDITKAN';
  return 'MENUNGGU_FAKTUR';
}

export function buildPpnMasukanRow(hutang: HutangDoc): PpnMasukanRow | null {
  const base = vendorHutangPostingBase(hutang);
  if (base.ppn <= 0) return null;
  const f = (hutang.fakturPajak || null) as FakturSnap | null;
  const billing = (hutang.vendorBillingSnapshot || {}) as { companyNPWP?: string };
  const tanggal = hutang.tanggal ? new Date(hutang.tanggal as string | Date) : null;
  const fakturPpn = f && f.ppn != null ? int(f.ppn) : null;
  return {
    hutangId: String(hutang.id || ''),
    noHutang: String(hutang.noHutang || ''),
    noInvoice: String(hutang.noInvoice || ''),
    tanggal: tanggal && !Number.isNaN(tanggal.getTime()) ? tanggal.toISOString() : null,
    supplierName: String(hutang.supplierName || ''),
    vendorNPWP: String(billing.companyNPWP || ''),
    approvalStatus: String(hutang.approvalStatus || hutang.status || ''),
    dpp: hutang.dpp != null ? int(hutang.dpp) : base.subTotal,
    ppn: base.ppn,
    ppnRate: typeof hutang.ppnRate === 'number' ? hutang.ppnRate : null,
    status: classifyPpnMasukan(hutang),
    nomorFaktur: f?.nomorFaktur || null,
    fakturStatus: f?.status || null,
    fakturMasa: f?.masa || null,
    fakturDpp: f && f.dpp != null ? int(f.dpp) : null,
    fakturPpn,
    selisihPpn: fakturPpn == null ? null : fakturPpn - base.ppn,
  };
}

export function summarizePpnMasukan(rows: PpnMasukanRow[]): PpnMasukanSummary {
  const empty = () => ({ count: 0, dpp: 0, ppn: 0 });
  const summary: PpnMasukanSummary = {
    SIAP_DIKREDITKAN: empty(),
    MENUNGGU_FAKTUR: empty(),
    FAKTUR_BATAL: empty(),
    TIDAK_DIKREDITKAN: empty(),
    total: empty(),
    selisihCount: 0,
  };
  for (const r of rows) {
    for (const bucket of [summary[r.status], summary.total]) {
      bucket.count += 1;
      bucket.dpp += r.dpp;
      bucket.ppn += r.ppn;
    }
    if (r.selisihPpn != null && Math.abs(r.selisihPpn) > 1) summary.selisihCount += 1;
  }
  return summary;
}

export const PPN_MASUKAN_LIMIT = 5000;

export async function loadPpnMasukan(db: Db, tenantId: string, masa: string) {
  const range = masaRangeWib(masa);
  if (!range) return null;
  const docs = await db.collection('hutang').find({
    ...tenantIdMatchFilter(tenantId),
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: { $ne: 'REJECTED' },
    $or: [
      { 'fakturPajak.masa': masa },
      { 'fakturPajak.masa': { $in: [null] }, tanggal: { $gte: range.from, $lt: range.to } },
      // Dokumen legacy menyimpan tanggal sebagai string ISO (UTC) — urutan leksikografis = kronologis.
      {
        'fakturPajak.masa': { $in: [null] },
        tanggal: { $gte: range.from.toISOString(), $lt: range.to.toISOString() },
      },
    ],
  }, {
    projection: {
      _id: 0, id: 1, noHutang: 1, noInvoice: 1, tanggal: 1, supplierName: 1, vendorBillingSnapshot: 1,
      approvalStatus: 1, status: 1, total: 1, ppn: 1, dpp: 1, ppnRate: 1, glPostingBase: 1, debitNotes: 1,
      ppnDikreditkan: 1, fakturPajak: 1,
    },
  }).sort({ tanggal: 1 }).limit(PPN_MASUKAN_LIMIT + 1).toArray();
  const truncated = docs.length > PPN_MASUKAN_LIMIT;
  const rows = (truncated ? docs.slice(0, PPN_MASUKAN_LIMIT) : docs)
    .map((d) => buildPpnMasukanRow(d as HutangDoc))
    .filter((r): r is PpnMasukanRow => r != null);
  return { rows, summary: summarizePpnMasukan(rows), truncated };
}
