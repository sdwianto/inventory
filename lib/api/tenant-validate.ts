// Validasi referensi cross-collection dalam satu tenant.

import type { Db, Filter } from 'mongodb';
import type { NextResponse } from 'next/server';
import type { AuthContext } from '@/types/auth';
import { err } from '@/lib/api/db';
import { findMasterDoc, assertMasterDoc, authForMasterActing } from '@/lib/api/tenant-master';
import { findOperationalDoc, assertOperationalDoc } from '@/lib/api/tenant-operational';

type AccessError = { error: NextResponse };
type DocResult<T> = { doc: T } | AccessError;

function scopeAuth(auth: AuthContext | null | undefined, tenantId: string | null | undefined) {
  return authForMasterActing(auth, tenantId || undefined) || auth;
}

export async function assertProductBelongsToTenant(
  db: Db,
  auth: AuthContext | null | undefined,
  tenantId: string,
  stokId: string,
) {
  const prod = await findMasterDoc(db, 'products', scopeAuth(auth, tenantId), { id: stokId });
  if (!prod) return { error: err('Produk tidak ditemukan di tenant ini', 404) };
  return { product: prod };
}

export async function assertSupplierBelongsToTenant(
  db: Db,
  auth: AuthContext | null | undefined,
  tenantId: string,
  supplierId: string,
) {
  const sup = await findMasterDoc(db, 'supplier', scopeAuth(auth, tenantId), { id: supplierId });
  if (!sup) return { error: err('Supplier tidak ditemukan di tenant ini', 404) };
  return { supplier: sup };
}

export async function assertPelangganBelongsToTenant(
  db: Db,
  auth: AuthContext | null | undefined,
  tenantId: string,
  pelangganId: string,
) {
  const pel = await findMasterDoc(db, 'pelanggan', scopeAuth(auth, tenantId), { id: pelangganId });
  if (!pel) return { error: err('Pelanggan tidak ditemukan di tenant ini', 404) };
  return { pelanggan: pel };
}

export async function assertMemberBelongsToTenant(
  db: Db,
  auth: AuthContext | null | undefined,
  tenantId: string,
  memberId: string,
) {
  const mem = await findMasterDoc(db, 'members', scopeAuth(auth, tenantId), { id: memberId });
  if (!mem) return { error: err('Member tidak ditemukan di tenant ini', 404) };
  return { member: mem };
}

export async function assertTransactionByNota(
  db: Db,
  auth: AuthContext | null | undefined,
  tenantId: string,
  noNota: string,
) {
  const scoped = scopeAuth(auth, tenantId);
  const trx = await findOperationalDoc(db, 'transactions', scoped, { noNota });
  if (!trx) return { error: err(`Transaksi ${noNota} tidak ditemukan`, 404) };
  if (!assertOperationalDoc(trx, scoped)) {
    return { error: err('Transaksi tidak termasuk tenant ini', 403) };
  }
  const trxDoc = trx as { tenantId?: string };
  return { transaction: trx, tenantId: trxDoc.tenantId || tenantId || 'default' };
}

export async function assertPembelianByNo(
  db: Db,
  auth: AuthContext | null | undefined,
  tenantId: string,
  noPembelian: string,
) {
  const scoped = scopeAuth(auth, tenantId);
  const doc = await findOperationalDoc(db, 'pembelian', scoped, { noPembelian });
  if (!doc) return { error: err('Pembelian asal tidak ditemukan', 404) };
  if (!assertOperationalDoc(doc, scoped)) {
    return { error: err('Pembelian tidak termasuk tenant ini', 403) };
  }
  const pembelianDoc = doc as { tenantId?: string };
  return { pembelian: doc, tenantId: pembelianDoc.tenantId || tenantId || 'default' };
}

export async function assertOperationalAccess(
  db: Db,
  auth: AuthContext | null | undefined,
  collection: string,
  query: Filter<Record<string, unknown>>,
): Promise<DocResult<Record<string, unknown>>> {
  const doc = await findOperationalDoc(db, collection, auth, query);
  if (!doc) return { error: err('Tidak ditemukan', 404) };
  if (!assertOperationalDoc(doc, auth)) return { error: err('Forbidden', 403) };
  return { doc: doc as Record<string, unknown> };
}

export async function assertMasterAccess(
  db: Db,
  auth: AuthContext | null | undefined,
  collection: string,
  query: Filter<Record<string, unknown>>,
): Promise<DocResult<Record<string, unknown>>> {
  const doc = await findMasterDoc(db, collection, auth, query);
  if (!doc) return { error: err('Tidak ditemukan', 404) };
  if (!assertMasterDoc(doc as { tenantId?: string | null }, auth)) return { error: err('Forbidden', 403) };
  return { doc: doc as Record<string, unknown> };
}
