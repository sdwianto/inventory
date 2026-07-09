// Resolve kas/bank rekening for hutang payment journals.

import type { Db } from 'mongodb';
import { COA } from '@/lib/api/journal-lines';

export interface RekeningRef {
  kode: string;
  nama: string;
}

export async function resolveKasRekening(
  db: Db,
  tenantId: string,
  kasRekeningKode?: string | null,
  metode?: string,
): Promise<RekeningRef> {
  const metodeUpper = String(metode || 'TUNAI').toUpperCase();
  const fallback = metodeUpper === 'TRANSFER' ? COA.BANK_MANDIRI : COA.KAS;
  const kode = String(kasRekeningKode || '').trim();
  if (!kode) return fallback;

  const rek = await db.collection('rekening').findOne({
    tenantId: tenantId || 'default',
    kode,
    aktif: { $ne: false },
  });
  if (!rek) return fallback;
  return { kode: String(rek.kode), nama: String(rek.nama) };
}
