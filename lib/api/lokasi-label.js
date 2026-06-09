// Resolve label lokasi gudang dari master lokasi (bukan snapshot dokumen lama).

import { parseLokasiKode } from '@/lib/api/stok-lokasi';
import { withTenantFilter } from '@/lib/api/tenant-master';

export function formatLokasiLabelFromParts(kode, nama) {
  if (!kode) return '-';
  return nama ? `${kode} - ${nama}` : kode;
}

export async function lokasiLabelMap(db, auth) {
  const list = await db.collection('lokasi')
    .find(withTenantFilter(auth, {}))
    .project({ tenantId: 1, kode: 1, nama: 1 })
    .toArray();
  const map = new Map();
  for (const l of list) {
    map.set(`${l.tenantId || 'default'}:${l.kode}`, formatLokasiLabelFromParts(l.kode, l.nama));
  }
  return map;
}

/** Sinkronkan label lokasi dengan master berdasarkan kode (L001, dll.). */
export function resolveLokasiDisplay(lokMap, tenantId, lokasiStr) {
  if (!lokasiStr) return '-';
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiStr);
  return lokMap.get(`${tid}:${kode}`) || lokasiStr;
}

/** Saat simpan transaksi/pembelian — selalu pakai nama terbaru dari master lokasi. */
export async function resolveLokasiLabelForWrite(db, tenantId, lokasiInput) {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiInput);
  const lok = await db.collection('lokasi').findOne({ tenantId: tid, kode });
  if (lok) return formatLokasiLabelFromParts(lok.kode, lok.nama);
  if (lokasiInput?.trim()) return lokasiInput.trim();
  const fallback = await db.collection('lokasi').findOne({ tenantId: tid });
  if (fallback) return formatLokasiLabelFromParts(fallback.kode, fallback.nama);
  return kode;
}
