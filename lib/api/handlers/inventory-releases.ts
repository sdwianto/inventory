import type { Db } from 'mongodb';
// Release inventory — pengeluaran barang operasional (creator → approver).

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole, RELEASE_CREATE_ROLES, RELEASE_APPROVE_ROLES } from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter, findMasterDoc, resolveOperationalScope } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import {
  adjustStokLokasi,
  ensureStokLokasiRow,
  getQtyStokLokasi,
  syncProductStokFromLokasi,
} from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';
import type { HandlerContext } from '@/types/api/handler';
import { writeAuditLog } from '@/lib/api/audit-log';
import type { AuthContext } from '@/types/auth';

interface ReleaseItemInput {
  stokId?: string;
  kode?: string;
  qty?: number | string;
}

interface ReleaseBody extends Record<string, unknown> {
  items?: ReleaseItemInput[];
  keperluan?: string;
  lokasiKode?: string;
  lokasi?: string;
  keterangan?: string;
  submit?: boolean;
  note?: string;
  reason?: string;
}

interface ReleaseLineItem {
  stokId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  qty: number;
  hargaBeli: number;
}

interface ReleaseUserRef {
  userId?: string;
  userName?: string;
  role?: string;
}

interface InventoryReleaseDoc extends Record<string, unknown> {
  id: string;
  tenantId?: string;
  status?: string;
  noRelease?: string;
  lokasiKode?: string;
  lokasiNama?: string;
  keperluan?: string;
  items?: ReleaseLineItem[];
  createdBy?: ReleaseUserRef;
}

function genNoRelease(): string {
  const now = new Date();
  return `RL${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
}

async function loadRelease(
  db: HandlerContext['db'],
  scopeAuth: AuthContext | null,
  id: string,
): Promise<InventoryReleaseDoc | null> {
  return db.collection('inventory_releases').findOne(
    withTenantFilter(scopeAuth, { id }),
  ) as Promise<InventoryReleaseDoc | null>;
}

export async function handleInventoryReleases({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const releaseBody = (body || {}) as ReleaseBody;

  if (route === '/inventory-releases' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('inventory_releases')
      .find(withTenantFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(list.map(clean));
  }

  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    return ok(clean(doc));
  }

  if (route === '/inventory-releases' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth) return err('Unauthorized', 401);
    const items = releaseBody.items || [];
    if (!items.length) return err('Minimal 1 item');
    if (!releaseBody.keperluan?.trim()) return err('Keperluan operasional wajib diisi');
    const tenantId = tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = normalizeWarehouseKode(releaseBody.lokasiKode || releaseBody.lokasi);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING atau GBASAH', 400);

    const lineItems: ReleaseLineItem[] = [];
    for (const it of items) {
      const prod = await findMasterDoc(db, 'products', scopeAuth, { id: it.stokId });
      if (!prod) return err(`Produk tidak ditemukan: ${it.kode || it.stokId}`, 404);
      const prodRow = prod as {
        id?: string;
        kode?: string;
        nama?: string;
        satuan?: string;
        hargaBeli?: number | string;
        gudangKode?: string | null;
      };
      if (!prodRow.id) return err(`Produk tidak ditemukan: ${it.kode || it.stokId}`, 404);
      const whErr = assertProductWarehouse(prodRow, lokasiKode);
      if (whErr) return err(whErr.error, 400);
      const qty = parseFloat(String(it.qty)) || 0;
      if (qty <= 0) return err(`Qty tidak valid: ${prodRow.nama}`, 400);
      const avail = parseFloat(String(await getQtyStokLokasi(db, tenantId, prodRow.id, lokasiKode))) || 0;
      if (avail < qty) {
        return err(`Stok ${prodRow.nama} di ${warehouseLabel(lokasiKode)} tidak cukup (sisa: ${avail})`, 400);
      }
      lineItems.push({
        stokId: prodRow.id,
        kode: String(prodRow.kode || ''),
        nama: String(prodRow.nama || ''),
        satuan: String(prodRow.satuan || ''),
        qty,
        hargaBeli: parseInt(String(prodRow.hargaBeli || 0), 10),
      });
    }

    const now = new Date();
    const submitNow = releaseBody.submit === true;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noRelease: genNoRelease(),
      status: submitNow ? 'PENDING_APPROVAL' : 'DRAFT',
      tanggal: now,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      keperluan: String(releaseBody.keperluan).trim(),
      keterangan: releaseBody.keterangan || '',
      items: lineItems,
      createdBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
      submittedAt: submitNow ? now : null,
      createdAt: now,
    });
    await db.collection('inventory_releases').insertOne(doc);
    return ok(clean(doc));
  }

  if (path[0] === 'inventory-releases' && path[2] === 'submit' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth) return err('Unauthorized', 401);
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa diajukan', 400);
    if (doc.createdBy?.userId !== auth.userId && !auth.isMaster && auth.role !== 'ADMIN') {
      return err('Hanya pembuat yang bisa mengajukan', 403);
    }
    const now = new Date();
    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      { $set: { status: 'PENDING_APPROVAL', submittedAt: now } },
    );
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth) return err('Unauthorized', 401);
    const locked = await guardPosting(db, scopeAuth, releaseBody);
    if (locked) return locked;

    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);
    if (doc.createdBy?.userId === auth.userId && !auth.isMaster && auth.role !== 'ADMIN') {
      return err('Tidak bisa menyetujui permintaan sendiri', 403);
    }

    const tenantId = doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = doc.lokasiKode;
    if (!lokasiKode) return err('Gudang tidak valid', 400);
    const now = new Date();

    for (const it of doc.items || []) {
      await ensureStokLokasiRow(db, tenantId, it.stokId, lokasiKode);
      const adj = await adjustStokLokasi(db, tenantId, it.stokId, lokasiKode, -it.qty);
      if ('error' in adj && adj.error) return err(`${it.nama}: ${adj.error}`, 400);
      await syncProductStokFromLokasi(db, tenantId, it.stokId);
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(),
        stokId: it.stokId,
        lokasi: `${lokasiKode} - ${doc.lokasiNama}`,
        tanggal: now,
        noTransaksi: doc.noRelease,
        keterangan: `Release operasional: ${doc.keperluan}`,
        sourceType: 'RELEASE',
        masuk: 0,
        keluar: it.qty,
        hargaSatuan: it.hargaBeli || 0,
      }));
    }

    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      {
        $set: {
          status: 'POSTED',
          approvedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
          approvedAt: now,
          postedAt: now,
          approveNote: releaseBody.note || '',
        },
      },
    );
    await writeAuditLog(db, {
      tenantId,
      action: 'INVENTORY_RELEASE',
      entityType: 'inventory_release',
      entityId: String(doc.id),
      summary: `Release ${doc.noRelease} disetujui`,
      userId: auth.userId,
      userName: auth.name || auth.email || 'System',
      metadata: { noRelease: doc.noRelease, lokasiKode, itemCount: (doc.items || []).length },
    });
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth) return err('Unauthorized', 401);
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);
    const now = new Date();
    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      {
        $set: {
          status: 'REJECTED',
          rejectedBy: { userId: auth.userId, userName: auth.name || auth.email },
          rejectedAt: now,
          rejectReason: releaseBody.reason || 'Ditolak',
        },
      },
    );
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa dibatalkan', 400);
    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      { $set: { status: 'CANCELLED', cancelledAt: new Date() } },
    );
    return ok({ message: 'cancelled' });
  }

  return null;
}
