// @deprecated Warisan sales.app (piutang/kasir) — tidak dipakai inventory customer.
// Validasi limit kredit pelanggan & limit hutang supplier.

import { findMasterDoc } from '@/lib/api/tenant-master';
import { withOperationalFilter } from '@/lib/api/tenant-operational';

export async function sumOpenPiutang(db, auth, pelangganId) {
  const rows = await db.collection('piutang')
    .find(withOperationalFilter(auth, { pelangganId, status: { $ne: 'LUNAS' } }))
    .project({ sisa: 1 })
    .toArray();
  return rows.reduce((s, r) => s + (r.sisa || 0), 0);
}

export async function assertPelangganCredit(db, auth, pelangganId, additionalAmount) {
  const pel = await findMasterDoc(db, 'pelanggan', auth, { id: pelangganId });
  if (!pel) return { ok: false, error: 'Pelanggan tidak ditemukan' };
  const limit = parseInt(pel.limitKredit || 0, 10);
  if (!limit) return { ok: true, pelanggan: pel };
  const open = await sumOpenPiutang(db, auth, pelangganId);
  const next = open + (parseInt(additionalAmount, 10) || 0);
  if (next > limit) {
    return {
      ok: false,
      error: `Limit kredit terlampaui (limit: Rp ${limit.toLocaleString('id-ID')}, outstanding: Rp ${open.toLocaleString('id-ID')}, transaksi: Rp ${(additionalAmount || 0).toLocaleString('id-ID')})`,
    };
  }
  return { ok: true, pelanggan: pel, openPiutang: open };
}

export async function sumOpenHutang(db, auth, supplierId) {
  const rows = await db.collection('hutang')
    .find(withOperationalFilter(auth, { supplierId, status: { $ne: 'LUNAS' } }))
    .project({ sisa: 1 })
    .toArray();
  return rows.reduce((s, r) => s + (r.sisa || 0), 0);
}

export async function assertSupplierCredit(db, auth, supplierId, additionalAmount) {
  const sup = await findMasterDoc(db, 'supplier', auth, { id: supplierId });
  if (!sup) return { ok: false, error: 'Supplier tidak ditemukan' };
  const limit = parseInt(sup.limitHutang || 0, 10);
  if (!limit) return { ok: true, supplier: sup };
  const open = await sumOpenHutang(db, auth, supplierId);
  const next = open + (parseInt(additionalAmount, 10) || 0);
  if (next > limit) {
    return {
      ok: false,
      error: `Limit hutang supplier terlampaui (limit: Rp ${limit.toLocaleString('id-ID')}, outstanding: Rp ${open.toLocaleString('id-ID')})`,
    };
  }
  return { ok: true, supplier: sup, openHutang: open };
}
