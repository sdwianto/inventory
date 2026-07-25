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
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { isValidWarehouseKode, warehouseLabel, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';
import type { HandlerContext } from '@/types/api/handler';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOrFallback } from '@/lib/api/transaction';
import type { AuthContext } from '@/types/auth';
import { applyWrResolutionLink, assertWrResolvable, loadWrById } from '@/lib/api/maintenance-resolve';
import { tryAutoCompleteWrFromRelease } from '@/lib/api/maintenance-wr-loop';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';

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
  maintenanceRequestId?: string;
  assetId?: string;
}

interface ReleaseLineItem {
  stokId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  qty: number;
  qtyBase?: number;
  qtyEntered?: number;
  uomId?: string;
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
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);

    const lineItems: ReleaseLineItem[] = [];
    const uomsCacheCreate = new Map<string, import('@/lib/uom/types').ProductUom[]>();
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
      const resolved = await resolveLineQtyBase(db, tenantId, prodRow.id, {
        qty: it.qty,
        uomId: (it as { uomId?: string }).uomId,
        satuan: (it as { satuan?: string }).satuan,
      }, uomsCacheCreate);
      if ('error' in resolved) return err(resolved.error, 400);
      const qtyBase = resolved.qtyBase;
      if (qtyBase <= 0) return err(`Qty tidak valid: ${prodRow.nama}`, 400);
      const avail = parseFloat(String(await getQtyStokLokasi(db, tenantId, prodRow.id, lokasiKode))) || 0;
      if (avail < qtyBase) {
        return err(`Stok ${prodRow.nama} di ${warehouseLabel(lokasiKode)} tidak cukup (sisa: ${avail} satuan dasar)`, 400);
      }
      lineItems.push({
        stokId: prodRow.id,
        kode: String(prodRow.kode || ''),
        nama: String(prodRow.nama || ''),
        satuan: resolved.satuan || String(prodRow.satuan || ''),
        qty: resolved.qty,
        qtyBase,
        qtyEntered: resolved.qty,
        uomId: resolved.uomId,
        hargaBeli: parseInt(String(prodRow.hargaBeli || 0), 10),
      });
    }

    const now = new Date();
    const submitNow = releaseBody.submit === true;
    const noRelease = await nextDocNumber(db, tenantId, 'RL', 'RL');
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noRelease,
      status: submitNow ? 'PENDING_APPROVAL' : 'DRAFT',
      tanggal: now,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      keperluan: String(releaseBody.keperluan).trim(),
      keterangan: releaseBody.keterangan || '',
      maintenanceRequestId: releaseBody.maintenanceRequestId || null,
      assetId: releaseBody.assetId || null,
      items: lineItems,
      createdBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
      submittedAt: submitNow ? now : null,
      createdAt: now,
    });
    await db.collection('inventory_releases').insertOne(doc);

    if (releaseBody.maintenanceRequestId) {
      const wr = await loadWrById(db, scopeAuth, String(releaseBody.maintenanceRequestId));
      const block = assertWrResolvable(wr, 'INTERNAL');
      if (!block && wr && !wr.linkedReleaseId) {
        await applyWrResolutionLink(db, wr, {
          resolutionType: 'INTERNAL',
          linkedReleaseId: doc.id,
          linkedReleaseNo: doc.noRelease,
        });
      }
    }

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
    const locked = await guardPosting(db, scopeAuth, releaseBody, String(doc.tanggal || doc.createdAt || ''));
    if (locked) return locked;
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

    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    const releaseLines: Array<ReleaseLineItem & { qtyBase: number }> = [];
    for (const it of doc.items || []) {
      if (it.qtyBase != null && it.qtyBase > 0) {
        releaseLines.push({ ...it, qtyBase: it.qtyBase });
        continue;
      }
      const resolved = await resolveLineQtyBase(db, tenantId, String(it.stokId), {
        qty: it.qty,
        uomId: (it as { uomId?: string }).uomId,
        satuan: (it as { satuan?: string }).satuan,
      }, uomsCache);
      if ('error' in resolved) return err(resolved.error, 400);
      releaseLines.push({ ...it, qtyBase: resolved.qtyBase, qty: resolved.qty, uomId: resolved.uomId, satuan: resolved.satuan });
    }
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        const claim = await txDb.collection('inventory_releases').updateOne(
          { id: doc.id, status: 'PENDING_APPROVAL' },
          {
            $set: {
              status: 'POSTED',
              approvedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
              approvedAt: now,
              postedAt: now,
              approveNote: releaseBody.note || '',
            },
          },
          session ? { session } : {},
        );
        if (claim.modifiedCount === 0) throw new Error('Release sudah diproses oleh approver lain');

        const fefoLines: Array<{
          stokId: string;
          allocated: number;
          shortfall: number;
          skippedNoBatches: boolean;
          allocations: FefoAllocation[];
        }> = [];

        for (const it of releaseLines) {
          await ensureStokLokasiRow(txDb, tenantId, it.stokId, lokasiKode, session);
          const adj = await adjustStokLokasi(txDb, tenantId, it.stokId, lokasiKode, -it.qtyBase, session);
          if ('error' in adj && adj.error) throw new Error(`${it.nama}: ${adj.error}`);
          await syncProductStokFromLokasi(txDb, tenantId, it.stokId, session);

          // W2-1: FEFO consume production batches when present for this FG+warehouse.
          const fefo = await consumeBatchesFefo(
            txDb,
            {
              tenantId,
              stokId: it.stokId,
              warehouseKode: lokasiKode,
              needQty: it.qtyBase,
              asOf: now,
              releaseId: doc.id,
              noRelease: doc.noRelease,
            },
            session,
          );
          fefoLines.push({
            stokId: it.stokId,
            allocated: fefo.allocated,
            shortfall: fefo.shortfall,
            skippedNoBatches: fefo.skippedNoBatches,
            allocations: fefo.allocations,
          });

          await txDb.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
            id: uuidv4(),
            stokId: it.stokId,
            lokasi: `${lokasiKode} - ${doc.lokasiNama}`,
            tanggal: now,
            noTransaksi: doc.noRelease,
            keterangan: `Release operasional: ${doc.keperluan}`,
            sourceType: 'RELEASE',
            masuk: 0,
            keluar: it.qtyBase,
            qtyEntered: it.qty,
            uomId: it.uomId,
            satuan: it.satuan,
            hargaSatuan: it.hargaBeli || 0,
            fefoAllocations: fefo.allocations,
          }), session ? { session } : {});
        }

        await txDb.collection('inventory_releases').updateOne(
          { id: doc.id },
          { $set: { fefoConsume: fefoLines, updatedAt: now } },
          session ? { session } : {},
        );
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal approve release';
      return err(msg, 400);
    }
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
    const posted = await loadRelease(db, scopeAuth, doc.id);
    const wrLoop = await tryAutoCompleteWrFromRelease(db, posted || doc);
    return ok(clean({ ...(posted || doc), wrLoop }));
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
