// Faktur pajak keluaran vendor (Sales `faktur_pajak.updated` / `invoice.posted.fakturPajak`):
// disimpan per faktur, lalu diringkas ke hutang invoice-nya (nomor faktur untuk PPN masukan pembeli).

import type { Db } from 'mongodb';
import { tenantIdMatchFilter, normalizeTenantId } from '@/lib/api/tenant-scope';
import { hutangVendorKey } from '@/lib/api/hutang-vendor-match';
import { logger } from '@/lib/api/logger';

export const VENDOR_FAKTUR_PAJAK_COLLECTION = 'vendor_faktur_pajak';

export const VENDOR_FAKTUR_STATUSES = ['DRAFT', 'DIUNGGAH', 'DISETUJUI', 'DIGANTI', 'BATAL'] as const;
export type VendorFakturStatus = typeof VENDOR_FAKTUR_STATUSES[number];

export type VendorFakturPajak = {
  fakturId: string;
  invoiceId: string;
  noInvoice: string;
  status: VendorFakturStatus;
  aktif: boolean;
  nomorFaktur: string | null;
  pengganti: boolean;
  replacesId: string | null;
  nomorDiganti: string | null;
  tanggal: Date | null;
  masa: string | null;
  trxCode: string | null;
  ppnRate: number | null;
  dpp: number;
  dppLain: number;
  ppn: number;
  /** NPWP pembeli di faktur (digit; '' = tanpa NPWP). Tidak ada = event versi lama (belum dikirim vendor). */
  buyerNpwp?: string;
  updatedAt: Date;
};

/** Ringkasan yang disalin ke `hutang.fakturPajak`. */
export type HutangFakturPajak = Omit<VendorFakturPajak, 'invoiceId' | 'noInvoice'>;

function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function date(v: unknown): Date | null {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Validasi payload faktur dari vendor; null = tidak valid (tidak disimpan). */
export function parseVendorFakturPajak(raw: unknown): VendorFakturPajak | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const fakturId = str(r.fakturId);
  const invoiceId = str(r.invoiceId);
  const status = str(r.status).toUpperCase() as VendorFakturStatus;
  const updatedAt = date(r.updatedAt);
  if (!fakturId || !invoiceId || !updatedAt || !VENDOR_FAKTUR_STATUSES.includes(status)) return null;
  const nomorDigits = str(r.nomorFaktur).replace(/[\s.-]/g, '');
  const nomorFaktur = /^\d{16,17}$/.test(nomorDigits) ? nomorDigits : null;
  if (status === 'DISETUJUI' && !nomorFaktur) return null;
  const masa = str(r.masa);
  const rate = Number(r.ppnRate);
  return {
    fakturId,
    invoiceId,
    noInvoice: str(r.noInvoice),
    status,
    aktif: r.aktif === true && (status === 'DRAFT' || status === 'DIUNGGAH' || status === 'DISETUJUI'),
    nomorFaktur,
    pengganti: r.pengganti === true,
    replacesId: str(r.replacesId) || null,
    nomorDiganti: str(r.nomorDiganti) || null,
    tanggal: date(r.tanggal),
    masa: /^\d{4}-\d{2}$/.test(masa) ? masa : null,
    trxCode: str(r.trxCode) || null,
    ppnRate: Number.isFinite(rate) ? rate : null,
    dpp: num(r.dpp),
    dppLain: num(r.dppLain),
    ppn: num(r.ppn),
    ...(typeof r.buyerNpwp === 'string' ? { buyerNpwp: r.buyerNpwp.replace(/\D/g, '') } : {}),
    updatedAt,
  };
}

/** Faktur yang mewakili invoice: faktur aktif terbaru; tanpa faktur aktif → faktur terbaru (BATAL/DIGANTI). */
export function pickInvoiceFaktur<T extends Pick<VendorFakturPajak, 'aktif' | 'updatedAt'>>(rows: T[]): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!best) { best = r; continue; }
    if (r.aktif !== best.aktif) {
      if (r.aktif) best = r;
      continue;
    }
    if (new Date(r.updatedAt).getTime() > new Date(best.updatedAt).getTime()) best = r;
  }
  return best;
}

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number } | null)?.code === 11000;
}

/**
 * Simpan faktur bila lebih baru dari yang tersimpan (event bisa datang tidak berurutan / diulang).
 * Upsert dengan guard `updatedAt`. E11000 berarti dokumen sudah ada (lebih baru, ATAU baru saja di-insert
 * event paralel yang bisa lebih lama) — ulangi tanpa upsert agar guard `updatedAt` yang memutuskan.
 */
export async function upsertVendorFakturPajak(
  db: Db,
  tenantId: string,
  vendorTenantId: string,
  f: VendorFakturPajak,
): Promise<{ applied: boolean }> {
  const tid = normalizeTenantId(tenantId);
  const vid = hutangVendorKey(vendorTenantId);
  const now = new Date();
  const coll = db.collection(VENDOR_FAKTUR_PAJAK_COLLECTION);
  const filter = { tenantId: tid, vendorTenantId: vid, fakturId: f.fakturId, updatedAt: { $lt: f.updatedAt } };
  const set = { ...f, tenantId: tid, vendorTenantId: vid, receivedAt: now };
  try {
    const r = await coll.updateOne(filter, { $set: set, $setOnInsert: { createdAt: now } }, { upsert: true });
    return { applied: r.modifiedCount > 0 || r.upsertedCount > 0 };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    const r = await coll.updateOne(filter, { $set: set });
    return { applied: r.modifiedCount > 0 };
  }
}

/** Hutang invoice milik vendor ini; hutang lama dengan vendorTenantId kosong/beda huruf ikut (sama dengan findExistingVendorHutang). */
async function findVendorInvoiceHutang(db: Db, tid: string, vid: string, invoiceId: string) {
  const tenantFilter = tenantIdMatchFilter(tid);
  const projection = { _id: 1, fakturPajakRev: 1 };
  const scoped = await db.collection('hutang').findOne({ ...tenantFilter, vendorInvoiceId: invoiceId, vendorTenantId: vid }, { projection });
  if (scoped) return scoped;
  return db.collection('hutang').findOne({
    vendorInvoiceId: invoiceId,
    $and: [
      tenantFilter,
      {
        $or: [
          { vendorTenantId: { $exists: false } },
          { vendorTenantId: null },
          { vendorTenantId: '' },
          { vendorTenantId: { $regex: `^${vid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
        ],
      },
    ],
  }, { projection });
}

const HUTANG_FAKTUR_SYNC_ATTEMPTS = 5;

/**
 * Salin ringkasan faktur terkini ke hutang invoice (bila hutang sudah ada).
 * Event bisa diproses paralel: hutang dibaca SEBELUM daftar faktur, lalu ditulis dengan CAS `fakturPajakRev`
 * — penulis yang membaca daftar faktur lama pasti kalah CAS dan mengulang dengan daftar terbaru.
 */
export async function syncHutangFakturPajak(
  db: Db,
  tenantId: string,
  vendorTenantId: string,
  invoiceId: string,
): Promise<{ hutangUpdated: boolean; faktur: HutangFakturPajak | null }> {
  const tid = normalizeTenantId(tenantId);
  const vid = hutangVendorKey(vendorTenantId);
  for (let attempt = 0; attempt < HUTANG_FAKTUR_SYNC_ATTEMPTS; attempt++) {
    const hutang = await findVendorInvoiceHutang(db, tid, vid, invoiceId);
    const rows = await db.collection<VendorFakturPajak & { tenantId: string; vendorTenantId: string }>(VENDOR_FAKTUR_PAJAK_COLLECTION)
      .find({ tenantId: tid, vendorTenantId: vid, invoiceId }, { projection: { _id: 0, tenantId: 0, vendorTenantId: 0, receivedAt: 0, createdAt: 0 } })
      .toArray();
    const best = pickInvoiceFaktur(rows);
    if (!best) return { hutangUpdated: false, faktur: null };
    const { invoiceId: _invoiceId, noInvoice: _noInvoice, ...faktur } = best;
    if (!hutang) return { hutangUpdated: false, faktur };
    const rev = typeof hutang.fakturPajakRev === 'number' ? hutang.fakturPajakRev : null;
    const r = await db.collection('hutang').updateOne(
      { _id: hutang._id, fakturPajakRev: rev },
      { $set: { fakturPajak: faktur, fakturPajakRev: (rev ?? 0) + 1, updatedAt: new Date() } },
    );
    if (r.matchedCount > 0) return { hutangUpdated: true, faktur };
  }
  throw new Error('Faktur pajak hutang berubah bersamaan — sinkron ulang');
}

/** Handler event `faktur_pajak.updated` (vendor sudah diverifikasi lewat secret link). */
export async function applyVendorFakturPajakEvent(
  db: Db,
  customerTenantId: string,
  payload: Record<string, unknown>,
  vendorTenantId: string | null | undefined,
): Promise<Record<string, unknown>> {
  const vid = hutangVendorKey(vendorTenantId);
  if (!vid) throw new Error('vendorTenantId wajib untuk faktur pajak');
  const f = parseVendorFakturPajak(payload);
  if (!f) throw new Error('payload faktur pajak tidak valid');
  const { applied } = await upsertVendorFakturPajak(db, customerTenantId, vid, f);
  const sync = await syncHutangFakturPajak(db, customerTenantId, vid, f.invoiceId);
  return {
    message: applied ? 'faktur_pajak_applied' : 'faktur_pajak_stale',
    fakturId: f.fakturId,
    invoiceId: f.invoiceId,
    status: f.status,
    hutangUpdated: sync.hutangUpdated,
    activeStatus: sync.faktur?.status ?? null,
  };
}

/**
 * Faktur yang ikut di payload invoice (`fakturPajak`) — dipanggil setelah hutang dibuat/disinkron.
 * Tidak boleh menggagalkan pembuatan hutang.
 */
export async function ingestInvoiceFakturPajak(
  db: Db,
  customerTenantId: string,
  vendorTenantId: string | null | undefined,
  invoiceId: string,
  raw: unknown,
): Promise<void> {
  const vid = hutangVendorKey(vendorTenantId);
  if (!vid || !invoiceId) return;
  try {
    const f = raw ? parseVendorFakturPajak(raw) : null;
    if (f && f.invoiceId === invoiceId) await upsertVendorFakturPajak(db, customerTenantId, vid, f);
    await syncHutangFakturPajak(db, customerTenantId, vid, invoiceId);
  } catch (e) {
    logger.warn('vendor_faktur_ingest_failed', {
      tenantId: customerTenantId, invoiceId, error: e instanceof Error ? e.message : String(e),
    });
  }
}
