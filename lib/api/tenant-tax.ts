// Status pajak tenant sebagai PEMBELI (Inventory). Tarif PPN ditentukan vendor (ppnRate di invoice),
// tenant hanya menentukan apakah PPN masukan bisa dikreditkan (PKP) atau ikut jadi nilai barang (non-PKP).

import type { ClientSession, Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';

export interface TenantTaxSettings {
  pkp: boolean;
  /** Tanggal pengukuhan PKP; dokumen sebelum tanggal ini tidak dikreditkan. null = tanpa batas awal. */
  pkpSejak: Date | null;
}

export const DEFAULT_TENANT_TAX: TenantTaxSettings = { pkp: false, pkpSejak: null };

export function normalizeNpwpDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** Sama dengan Sales `isValidNpwp`: NPWP lama 15 digit atau NPWP/NIK 16 digit. */
export function isValidNpwp(v: unknown): boolean {
  const d = normalizeNpwpDigits(v);
  return d.length === 15 || d.length === 16;
}

function parseDateOnly(v: unknown): Date | null | undefined {
  if (v == null || v === '') return null;
  const s = String(v);
  // Tanggal tanpa jam dari form = awal hari WIB.
  const d = v instanceof Date ? v : new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00+07:00` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function normalizeTenantTax(raw: unknown): TenantTaxSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_TENANT_TAX };
  const r = raw as Record<string, unknown>;
  return { pkp: r.pkp === true, pkpSejak: parseDateOnly(r.pkpSejak) ?? null };
}

/** Validasi input pengaturan pajak; `npwp` = NPWP perusahaan setelah update. */
export function validateTenantTaxInput(
  input: unknown,
  prev: TenantTaxSettings,
  npwp: unknown,
): { ok: true; tax: TenantTaxSettings } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Pengaturan pajak tidak valid' };
  const r = input as Record<string, unknown>;
  if (r.pkp !== undefined && typeof r.pkp !== 'boolean') return { ok: false, error: 'Status PKP harus ya/tidak' };
  const sejak = r.pkpSejak !== undefined ? parseDateOnly(r.pkpSejak) : prev.pkpSejak;
  if (sejak === undefined) return { ok: false, error: 'Tanggal PKP sejak tidak valid' };
  const tax: TenantTaxSettings = { pkp: r.pkp !== undefined ? r.pkp === true : prev.pkp, pkpSejak: sejak };
  if (tax.pkp && !isValidNpwp(npwp)) return { ok: false, error: 'Tenant PKP wajib punya NPWP perusahaan 15/16 digit' };
  if (!tax.pkp) tax.pkpSejak = null;
  return { ok: true, tax };
}

export async function loadTenantTax(db: Db, tenantId: string, session?: ClientSession): Promise<TenantTaxSettings> {
  const row = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: { tax: 1 }, ...txOpts(session) },
  );
  return normalizeTenantTax(row?.tax);
}

/** PPN masukan dokumen bertanggal `tanggal` boleh dikreditkan (snapshot ke hutang saat dibuat). */
export function isPpnDikreditkan(tax: TenantTaxSettings, tanggal: Date): boolean {
  if (!tax.pkp) return false;
  if (!tax.pkpSejak) return true;
  return tanggal.getTime() >= tax.pkpSejak.getTime();
}
