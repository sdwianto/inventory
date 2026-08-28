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
import { consumeIngredientLotsFefo } from '@/lib/food-production/ingredient-lot-consume';
import { isFoodSafetyHoldEnforced } from '@/lib/api/feature-flags';
import { assertFefoExitNotBlockedByHold, assertConsumeShortfallNotDueToHold } from '@/lib/food-production/food-safety-exit-gate';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';
import { softConsumeBinOnWarehouseOut } from '@/lib/api/stok-bin-consume';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import { looksLikeProductionKeperluan } from '@/lib/food-production/material-issue-reconcile';

interface ReleaseItemInput {
  stokId?: string;
  kode?: string;
  qty?: number | string;
  uomId?: string;
  satuan?: string;
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
  productionPlanId?: string;
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
  productionPlanId?: string;
  productionPlanNo?: string;
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

function canEditReleaseDoc(auth: AuthContext, doc: InventoryReleaseDoc): boolean {
  if (doc.status !== 'REJECTED' && doc.status !== 'DRAFT') return false;
  if (auth.isMaster || auth.role === 'ADMIN') return true;
  return doc.createdBy?.userId === auth.userId;
}

async function buildReleaseLineItems(
  db: Db,
  scopeAuth: AuthContext,
  tenantId: string,
  lokasiKode: string,
  items: ReleaseItemInput[],
  uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>(),
): Promise<{ lineItems: ReleaseLineItem[] } | { error: string; status?: number }> {
  if (!items.length) return { error: 'Minimal 1 item', status: 400 };
  const lineItems: ReleaseLineItem[] = [];
  for (const it of items) {
    const prod = await findMasterDoc(db, 'products', scopeAuth, { id: it.stokId });
    if (!prod) return { error: `Produk tidak ditemukan: ${it.kode || it.stokId}`, status: 404 };
    const prodRow = prod as {
      id?: string;
      kode?: string;
      nama?: string;
      satuan?: string;
      hargaBeli?: number | string;
      gudangKode?: string | null;
    };
    if (!prodRow.id) return { error: `Produk tidak ditemukan: ${it.kode || it.stokId}`, status: 404 };
    const whErr = assertProductWarehouse(prodRow, lokasiKode);
    if (whErr) return { error: whErr.error, status: 400 };
    const resolved = await resolveLineQtyBase(db, tenantId, prodRow.id, {
      qty: it.qty,
      uomId: it.uomId,
      satuan: it.satuan,
    }, uomsCache);
    if ('error' in resolved) return { error: resolved.error, status: 400 };
    const qtyBase = resolved.qtyBase;
    if (qtyBase <= 0) return { error: `Qty tidak valid: ${prodRow.nama}`, status: 400 };
    const avail = parseFloat(String(await getQtyStokLokasi(db, tenantId, prodRow.id, lokasiKode))) || 0;
    if (avail < qtyBase) {
      return {
        error: `Stok ${prodRow.nama} di ${warehouseLabel(lokasiKode)} tidak cukup (sisa: ${avail} satuan dasar)`,
        status: 400,
      };
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
  return { lineItems };
}

async function resolveProductionPlanLink(
  db: Db,
  scopeAuth: AuthContext,
  productionPlanId?: string,
): Promise<{ productionPlanId?: string; productionPlanNo?: string } | { error: string }> {
  const planId = String(productionPlanId || '').trim();
  if (!planId) return {};
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: planId }),
    { projection: { id: 1, noDokumen: 1, status: 1 } },
  ) as { id?: string; noDokumen?: string; status?: string } | null;
  if (!plan) return { error: 'Rencana produksi tidak ditemukan' };
  if (!ISSUE_ELIGIBLE_PLAN_STATUSES.has(String(plan.status || ''))) {
    return { error: `Rencana ${plan.noDokumen || planId} belum siap (wajib Disetujui/Diproses)` };
  }
  return {
    productionPlanId: String(plan.id),
    productionPlanNo: String(plan.noDokumen || ''),
  };
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
    if (!auth || !scopeAuth) return err('Unauthorized', 401);
    const items = releaseBody.items || [];
    if (!items.length) return err('Minimal 1 item');
    if (!releaseBody.keperluan?.trim()) return err('Keperluan operasional wajib diisi');
    const keperluan = String(releaseBody.keperluan).trim();
    const planIdRaw = String(releaseBody.productionPlanId || '').trim();
    if (looksLikeProductionKeperluan(keperluan) && !planIdRaw) {
      return err(
        'Keperluan terlihat untuk produksi — pilih Rencana Produksi atau gunakan Mode Produksi (PBL)',
        400,
      );
    }
    const tenantId = tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = normalizeWarehouseKode(releaseBody.lokasiKode || releaseBody.lokasi);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);

    const built = await buildReleaseLineItems(db, scopeAuth, tenantId, lokasiKode, items);
    if ('error' in built) return err(built.error, built.status || 400);
    const lineItems = built.lineItems;

    const planLink = await resolveProductionPlanLink(db, scopeAuth, releaseBody.productionPlanId);
    if ('error' in planLink) return err(planLink.error, 400);

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
      ...(planLink.productionPlanId ? {
        productionPlanId: planLink.productionPlanId,
        productionPlanNo: planLink.productionPlanNo,
      } : {}),
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

  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'PATCH') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth || !scopeAuth) return err('Unauthorized', 401);

    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (!canEditReleaseDoc(auth, doc)) {
      return err('Release tidak bisa diedit pada status ini', 403);
    }

    const items = releaseBody.items || [];
    if (!items.length) return err('Minimal 1 item');
    if (!releaseBody.keperluan?.trim()) return err('Keperluan operasional wajib diisi');
    const keperluan = String(releaseBody.keperluan).trim();
    const planIdRaw = releaseBody.productionPlanId !== undefined
      ? String(releaseBody.productionPlanId || '').trim()
      : String(doc.productionPlanId || '').trim();
    if (looksLikeProductionKeperluan(keperluan) && !planIdRaw) {
      return err(
        'Keperluan terlihat untuk produksi — pilih Rencana Produksi atau gunakan Mode Produksi (PBL)',
        400,
      );
    }

    const tenantId = doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = normalizeWarehouseKode(releaseBody.lokasiKode || releaseBody.lokasi || doc.lokasiKode);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);

    const built = await buildReleaseLineItems(db, scopeAuth, tenantId, lokasiKode, items);
    if ('error' in built) return err(built.error, built.status || 400);

    const planLink = releaseBody.productionPlanId !== undefined
      ? await resolveProductionPlanLink(db, scopeAuth, releaseBody.productionPlanId)
      : {};
    if ('error' in planLink) return err(planLink.error, 400);

    const submitNow = releaseBody.submit === true;
    if (submitNow) {
      const locked = await guardPosting(db, scopeAuth, releaseBody, String(doc.tanggal || doc.createdAt || ''));
      if (locked) return locked;
    }

    const now = new Date();
    const nextStatus = submitNow ? 'PENDING_APPROVAL' : 'DRAFT';
    const wrId = String(releaseBody.maintenanceRequestId || '').trim() || doc.maintenanceRequestId || null;
    const assetId = String(releaseBody.assetId || '').trim() || doc.assetId || null;
    const patch: Record<string, unknown> = {
      status: nextStatus,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      keperluan: String(releaseBody.keperluan).trim(),
      keterangan: releaseBody.keterangan || '',
      maintenanceRequestId: wrId,
      assetId,
      items: built.lineItems,
      submittedAt: submitNow ? now : null,
      updatedAt: now,
    };

    if (releaseBody.productionPlanId !== undefined) {
      if (planLink.productionPlanId) {
        patch.productionPlanId = planLink.productionPlanId;
        patch.productionPlanNo = planLink.productionPlanNo;
      } else {
        patch.productionPlanId = null;
        patch.productionPlanNo = null;
      }
    }

    const unset: Record<string, string> = {};
    if (doc.status === 'REJECTED') {
      unset.rejectedBy = '';
      unset.rejectedAt = '';
      unset.rejectReason = '';
    }

    await db.collection('inventory_releases').updateOne(
      { id: doc.id },
      {
        $set: patch,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
    );
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
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
    // ADR-004 — resolve sekali per dokumen, bukan per baris FEFO.
    const enforceFoodSafetyHold = await isFoodSafetyHoldEnforced(db, tenantId);
    const holdGate = await assertFefoExitNotBlockedByHold(db, {
      tenantId,
      enforce: enforceFoodSafetyHold,
      asOf: now,
      context: 'release',
      lines: releaseLines.map((it) => ({
        stokId: String(it.stokId),
        stokNama: it.nama,
        warehouseKode: lokasiKode,
        needQty: it.qtyBase,
      })),
    });
    if (!holdGate.ok) return err(holdGate.error, 400);
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
        const ingredientLotLines: Array<{
          stokId: string;
          warehouseKode: string;
          needQty: number;
          allocated: number;
          shortfall: number;
          skippedNoLots: boolean;
          allocations: FefoAllocation[];
        }> = [];

        for (const it of releaseLines) {
          await ensureStokLokasiRow(txDb, tenantId, it.stokId, lokasiKode, session);
          const adj = await adjustStokLokasi(txDb, tenantId, it.stokId, lokasiKode, -it.qtyBase, session);
          if ('error' in adj && adj.error) throw new Error(`${it.nama}: ${adj.error}`);
          // W2-20: soft bin OUT after warehouse OUT — never fail release on bin shortfall.
          await softConsumeBinOnWarehouseOut(
            txDb,
            tenantId,
            it.stokId,
            lokasiKode,
            it.qtyBase,
            session,
          );
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
              enforceFoodSafetyHold,
            },
            session,
          );
          if (enforceFoodSafetyHold) {
            const post = await assertConsumeShortfallNotDueToHold(
              txDb,
              {
                tenantId,
                enforce: true,
                shortfall: fefo.shortfall,
                skippedNoBatches: fefo.skippedNoBatches,
                asOf: now,
                context: 'release',
                line: {
                  stokId: String(it.stokId),
                  stokNama: it.nama,
                  warehouseKode: lokasiKode,
                  needQty: it.qtyBase,
                },
              },
              session,
            );
            if (!post.ok) throw new Error(post.error);
          }
          fefoLines.push({
            stokId: it.stokId,
            allocated: fefo.allocated,
            shortfall: fefo.shortfall,
            skippedNoBatches: fefo.skippedNoBatches,
            allocations: fefo.allocations,
          });

          // W2-6: FEFO consume ingredient lots (raw/ops stock) so Panduan Release SOH stays in sync.
          const lotFefo = await consumeIngredientLotsFefo(
            txDb,
            {
              tenantId,
              stokId: it.stokId,
              warehouseKode: lokasiKode,
              needQty: it.qtyBase,
              asOf: now,
              issueId: doc.id,
              noDokumen: doc.noRelease,
            },
            session,
          );
          ingredientLotLines.push({
            stokId: it.stokId,
            warehouseKode: lokasiKode,
            needQty: lotFefo.needQty,
            allocated: lotFefo.allocated,
            shortfall: lotFefo.shortfall,
            skippedNoLots: lotFefo.skippedNoLots,
            allocations: lotFefo.allocations,
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
            ingredientLotAllocations: lotFefo.allocations,
          }), session ? { session } : {});
        }

        await txDb.collection('inventory_releases').updateOne(
          { id: doc.id },
          {
            $set: {
              fefoConsume: fefoLines,
              ingredientLotConsume: ingredientLotLines,
              updatedAt: now,
            },
          },
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
