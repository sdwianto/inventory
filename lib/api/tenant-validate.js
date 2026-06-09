// Validasi referensi cross-collection dalam satu tenant.

import { err } from '@/lib/api/db';
import { findMasterDoc, assertMasterDoc, authForMasterActing } from '@/lib/api/tenant-master';
import { findOperationalDoc, assertOperationalDoc } from '@/lib/api/tenant-operational';

function scopeAuth(auth, tenantId) {
  return authForMasterActing(auth, tenantId) || auth;
}

export async function assertProductBelongsToTenant(db, auth, tenantId, stokId) {
  const prod = await findMasterDoc(db, 'products', scopeAuth(auth, tenantId), { id: stokId });
  if (!prod) return { error: err('Produk tidak ditemukan di tenant ini', 404) };
  return { product: prod };
}

export async function assertSupplierBelongsToTenant(db, auth, tenantId, supplierId) {
  const sup = await findMasterDoc(db, 'supplier', scopeAuth(auth, tenantId), { id: supplierId });
  if (!sup) return { error: err('Supplier tidak ditemukan di tenant ini', 404) };
  return { supplier: sup };
}

export async function assertPelangganBelongsToTenant(db, auth, tenantId, pelangganId) {
  const pel = await findMasterDoc(db, 'pelanggan', scopeAuth(auth, tenantId), { id: pelangganId });
  if (!pel) return { error: err('Pelanggan tidak ditemukan di tenant ini', 404) };
  return { pelanggan: pel };
}

export async function assertMemberBelongsToTenant(db, auth, tenantId, memberId) {
  const mem = await findMasterDoc(db, 'members', scopeAuth(auth, tenantId), { id: memberId });
  if (!mem) return { error: err('Member tidak ditemukan di tenant ini', 404) };
  return { member: mem };
}

export async function assertTransactionByNota(db, auth, tenantId, noNota) {
  const scoped = scopeAuth(auth, tenantId);
  const trx = await findOperationalDoc(db, 'transactions', scoped, { noNota });
  if (!trx) return { error: err(`Transaksi ${noNota} tidak ditemukan`, 404) };
  if (!assertOperationalDoc(trx, scoped)) {
    return { error: err('Transaksi tidak termasuk tenant ini', 403) };
  }
  return { transaction: trx, tenantId: trx.tenantId || tenantId || 'default' };
}

export async function assertPembelianByNo(db, auth, tenantId, noPembelian) {
  const scoped = scopeAuth(auth, tenantId);
  const doc = await findOperationalDoc(db, 'pembelian', scoped, { noPembelian });
  if (!doc) return { error: err('Pembelian asal tidak ditemukan', 404) };
  if (!assertOperationalDoc(doc, scoped)) {
    return { error: err('Pembelian tidak termasuk tenant ini', 403) };
  }
  return { pembelian: doc, tenantId: doc.tenantId || tenantId || 'default' };
}

export async function assertOperationalAccess(db, auth, collection, query) {
  const doc = await findOperationalDoc(db, collection, auth, query);
  if (!doc) return { error: err('Tidak ditemukan', 404) };
  if (!assertOperationalDoc(doc, auth)) return { error: err('Forbidden', 403) };
  return { doc };
}

export async function assertMasterAccess(db, auth, collection, query) {
  const doc = await findMasterDoc(db, collection, auth, query);
  if (!doc) return { error: err('Tidak ditemukan', 404) };
  if (!assertMasterDoc(doc, auth)) return { error: err('Forbidden', 403) };
  return { doc };
}
