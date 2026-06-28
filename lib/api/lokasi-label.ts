// Resolve label lokasi gudang dari master lokasi (bukan snapshot dokumen lama).

import type { Db } from 'mongodb';
import { parseLokasiKode } from '@/lib/api/stok-lokasi';
import { withTenantFilter } from '@/lib/api/tenant-master';
import type { AuthContext } from '@/types/auth';

export function formatLokasiLabelFromParts(kode: string | null | undefined, nama: string | null | undefined): string {
  if (!kode) return '-';
  return nama ? `${kode} - ${nama}` : kode;
}

export async function lokasiLabelMap(db: Db, auth: AuthContext | null): Promise<Map<string, string>> {
  const list = await db.collection('lokasi')
    .find(withTenantFilter(auth, {}))
    .project({ tenantId: 1, kode: 1, nama: 1 })
    .toArray();
  const map = new Map<string, string>();
  for (const l of list) {
    map.set(`${l.tenantId || 'default'}:${l.kode}`, formatLokasiLabelFromParts(String(l.kode || ''), String(l.nama || '')));
  }
  return map;
}

/** Sinkronkan label lokasi dengan master berdasarkan kode (L001, dll.). */
export function resolveLokasiDisplay(lokMap: Map<string, string>, tenantId: string | null | undefined, lokasiStr: string | null | undefined): string {
  if (!lokasiStr) return '-';
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiStr);
  return lokMap.get(`${tid}:${kode}`) || lokasiStr;
}

/** Saat simpan transaksi/pembelian — selalu pakai nama terbaru dari master lokasi. */
export async function resolveLokasiLabelForWrite(
  db: Db,
  tenantId: string | null | undefined,
  lokasiInput: string | null | undefined,
): Promise<string> {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiInput);
  const lok = await db.collection('lokasi').findOne({ tenantId: tid, kode });
  if (lok) return formatLokasiLabelFromParts(String(lok.kode || ''), String(lok.nama || ''));
  if (lokasiInput?.trim()) return lokasiInput.trim();
  const fallback = await db.collection('lokasi').findOne({ tenantId: tid });
  if (fallback) return formatLokasiLabelFromParts(String(fallback.kode || ''), String(fallback.nama || ''));
  return kode;
}
