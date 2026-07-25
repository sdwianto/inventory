import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import type { ClientSession } from 'mongodb';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { guardPosting } from '@/lib/api/period-lock';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import { relocateBatchesFefo } from '@/lib/food-production/transfer-fefo';
import { relocateLotsFefo } from '@/lib/food-production/transfer-lot-fefo';
import {
  KITCHEN_TRANSFERS_COLLECTION,
  XFER_STATUS_TRANSITIONS,
  isXferEditable,
  normalizeXferLines,
  summarizeXferLines,
  assertKitchenTransferPair,
  type KitchenTransferDoc,
  type KitchenTransferStatus,
} from '@/lib/food-production/kitchen-transfer';
import { KITCHENS_COLLECTION, type KitchenDoc } from '@/lib/food-production/kitchen';
import { postingDateFromIso } from '@/lib/food-production/material-issue';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface XferBody extends Record<string, unknown> {
  fromKitchenId?: string;
  toKitchenId?: string;
  tanggal?: string;
  productionPlanId?: string;
  lines?: unknown;
  catatan?: string;
  status?: string;
  note?: string;
}

async function assertXferProductsActive(
  db: HandlerContext['db'],
  tenantId: string,
  lines: KitchenTransferDoc['lines'],
): Promise<string | null> {
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  if (!ids.length) return 'Tidak ada baris produk';
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: ids } })
    .project({ id: 1, nama: 1, kode: 1, aktif: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) return `Produk ${id} tidak ditemukan`;
    if (p.aktif === false) {
      return `Produk "${String(p.nama || p.kode || id)}" tidak aktif`;
    }
  }
  return null;
}

async function postXferStock(
  db: HandlerContext['db'],
  doc: KitchenTransferDoc,
  session: ClientSession,
): Promise<{ error: string } | { ok: true }> {
  for (const line of doc.lines) {
    const qty = Number(line.qty);
    if (!(qty > 0)) continue;
    const out = await postStockMutation(db, {
      tenantId: doc.tenantId,
      productId: line.productId,
      warehouseKode: doc.fromWarehouseKode,
      deltaQtyBase: -qty,
      sourceType: 'FP_XFER',
      noTransaksi: doc.noDokumen,
      keterangan: `XFR keluar ${doc.noDokumen} → ${doc.toKitchenNama || doc.toKitchenId}`,
      satuan: line.satuan,
      qtyEntered: qty,
      session,
    });
    if (!out.ok) return { error: out.error || `Gagal stok keluar ${line.productId}` };
    const inn = await postStockMutation(db, {
      tenantId: doc.tenantId,
      productId: line.productId,
      warehouseKode: doc.toWarehouseKode,
      deltaQtyBase: qty,
      sourceType: 'FP_XFER',
      noTransaksi: doc.noDokumen,
      keterangan: `XFR masuk ${doc.noDokumen} ← ${doc.fromKitchenNama || doc.fromKitchenId}`,
      satuan: line.satuan,
      qtyEntered: qty,
      session,
    });
    if (!inn.ok) return { error: inn.error || `Gagal stok masuk ${line.productId}` };
  }
  return { ok: true };
}

export async function handleKitchenTransfers(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const xferBody = (body || {}) as XferBody;

  if (route === '/kitchen-transfers' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    if (kitchenId) {
      filter.$or = [{ fromKitchenId: kitchenId }, { toKitchenId: kitchenId }];
    }
    const list = await db.collection(KITCHEN_TRANSFERS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/kitchen-transfers' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: xferBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const fromKitchenId = String(xferBody.fromKitchenId || '').trim();
    const toKitchenId = String(xferBody.toKitchenId || '').trim();
    const lines = normalizeXferLines(xferBody.lines);
    if ('error' in lines) return err(lines.error, 400);

    const [fromK, toK] = await Promise.all([
      db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: fromKitchenId, aktif: true }),
      ) as Promise<KitchenDoc | null>,
      db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: toKitchenId, aktif: true }),
      ) as Promise<KitchenDoc | null>,
    ]);
    if (!fromK) return err('Dapur asal tidak ditemukan', 404);
    if (!toK) return err('Dapur tujuan tidak ditemukan', 404);

    const pair = assertKitchenTransferPair({
      fromKitchenId,
      toKitchenId,
      fromWarehouseKode: fromK.defaultWarehouseKode,
      toWarehouseKode: toK.defaultWarehouseKode,
    });
    if ('error' in pair) return err(pair.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, xferBody);
    const productErr = await assertXferProductsActive(db, tenantId, lines);
    if (productErr) return err(productErr, 400);
    const actor = auditActor(auth);
    const now = new Date();
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.KITCHEN_TRANSFER);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: pair.allocationOnly ? 'Alokasi (gudang sama — tanpa mutasi stok)' : 'Transfer antar dapur',
    });

    const doc: KitchenTransferDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      tanggal: String(xferBody.tanggal || '').trim() || new Date().toISOString().slice(0, 10),
      fromKitchenId: fromK.id,
      fromKitchenNama: fromK.nama,
      fromWarehouseKode: fromK.defaultWarehouseKode,
      toKitchenId: toK.id,
      toKitchenNama: toK.nama,
      toWarehouseKode: toK.defaultWarehouseKode,
      allocationOnly: pair.allocationOnly,
      productionPlanId: String(xferBody.productionPlanId || '').trim() || undefined,
      lines,
      status: 'DRAFT',
      history,
      summary: summarizeXferLines(lines),
      catatan: String(xferBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(KITCHEN_TRANSFERS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'XFER_CREATE',
      entityType: 'kitchen_transfer',
      entityId: doc.id,
      summary: `XFR ${doc.noDokumen}: ${fromK.nama} → ${toK.nama}`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'kitchen-transfers' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(KITCHEN_TRANSFERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Transfer tidak ditemukan', 404);
    return ok(clean(existing as Record<string, unknown>));
  }

  if (path[0] === 'kitchen-transfers' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: xferBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(xferBody.status || '').trim() as KitchenTransferStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(KITCHEN_TRANSFERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as KitchenTransferDoc | null;
    if (!existing) return err('Transfer tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(clean(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, XFER_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = auditActor(auth);
    const now = new Date();

    if (toStatus === 'COMPLETED') {
      if (existing.stockPostedAt) return err('Sudah diposting', 400);
      const locked = await guardPosting(
        db,
        scopeAuth,
        xferBody,
        postingDateFromIso(existing.tanggal),
      );
      if (locked) return locked;

      try {
        await runInTransactionOrFallback(async ({ db: txDb, session }) => {
          if (!existing.allocationOnly && !session) {
            throw Object.assign(
              new Error('Posting stok XFR membutuhkan transaksi MongoDB (replica set)'),
              { httpStatus: 503 },
            );
          }
          const fresh = await txDb.collection(KITCHEN_TRANSFERS_COLLECTION).findOne(
            withTenantFilter(scopeAuth, { id, status: existing.status }),
            txOpts(session),
          ) as KitchenTransferDoc | null;
          if (!fresh) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });

          const productErrTx = await assertXferProductsActive(txDb, fresh.tenantId, fresh.lines);
          if (productErrTx) {
            throw Object.assign(new Error(productErrTx), { httpStatus: 400 });
          }

          const fefoRelocate: Array<Record<string, unknown>> = [];
          const lotRelocate: Array<Record<string, unknown>> = [];
          if (!fresh.allocationOnly) {
            const posted = await postXferStock(txDb, fresh, session!);
            if ('error' in posted) {
              throw Object.assign(new Error(posted.error), { httpStatus: 400 });
            }
            // W2-12/W2-13: relocate FG batches + ingredient lots FEFO with the stock move.
            for (const line of fresh.lines) {
              const qty = Number(line.qty);
              if (!(qty > 0)) continue;
              const fefo = await relocateBatchesFefo(
                txDb,
                {
                  tenantId: fresh.tenantId,
                  stokId: line.productId,
                  fromWarehouseKode: fresh.fromWarehouseKode,
                  toWarehouseKode: fresh.toWarehouseKode,
                  needQty: qty,
                  asOf: now,
                  allowExpired: true,
                  noTransaksi: fresh.noDokumen,
                  xferId: fresh.id,
                },
                session,
              );
              fefoRelocate.push({
                stokId: fefo.stokId,
                fromWarehouseKode: fefo.fromWarehouseKode,
                toWarehouseKode: fefo.toWarehouseKode,
                needQty: fefo.needQty,
                allocated: fefo.allocated,
                shortfall: fefo.shortfall,
                skippedNoBatches: fefo.skippedNoBatches,
                allocations: fefo.allocations,
              });
              const lots = await relocateLotsFefo(
                txDb,
                {
                  tenantId: fresh.tenantId,
                  stokId: line.productId,
                  fromWarehouseKode: fresh.fromWarehouseKode,
                  toWarehouseKode: fresh.toWarehouseKode,
                  needQty: qty,
                  asOf: now,
                  allowExpired: true,
                  noTransaksi: fresh.noDokumen,
                  xferId: fresh.id,
                },
                session,
              );
              lotRelocate.push({
                stokId: lots.stokId,
                fromWarehouseKode: lots.fromWarehouseKode,
                toWarehouseKode: lots.toWarehouseKode,
                needQty: lots.needQty,
                allocated: lots.allocated,
                shortfall: lots.shortfall,
                skippedNoLots: lots.skippedNoLots,
                allocations: lots.allocations,
              });
            }
          }

          const history = appendDocHistory(fresh.history, {
            at: now,
            fromStatus: fresh.status,
            toStatus: 'COMPLETED',
            userId: actor.userId,
            userName: actor.userName,
            note: fresh.allocationOnly
              ? 'Alokasi selesai (tanpa mutasi stok)'
              : 'Stok transfer diposting',
          });
          await txDb.collection(KITCHEN_TRANSFERS_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id }),
            {
              $set: {
                status: 'COMPLETED',
                history,
                stockPostedAt: now,
                updatedAt: now,
                ...(fefoRelocate.length ? { fefoRelocate } : {}),
                ...(lotRelocate.length ? { lotRelocate } : {}),
              },
            },
            txOpts(session),
          );
        });
      } catch (e) {
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 400) {
          return err(e instanceof Error ? e.message : 'Gagal', 400);
        }
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 409) {
          return err('Dokumen berubah — muat ulang', 409);
        }
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 503) {
          return err(e instanceof Error ? e.message : 'Transaksi MongoDB wajib', 503);
        }
        throw e;
      }

      const saved = await db.collection(KITCHEN_TRANSFERS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      );
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'XFER_COMPLETE',
        entityType: 'kitchen_transfer',
        entityId: id,
        summary: `XFR ${existing.noDokumen} selesai`,
        ...auditActor(auth),
      });
      return ok(clean(saved as Record<string, unknown>));
    }

    if (!isXferEditable(existing.status) && toStatus !== 'CANCELLED') {
      // allow APPROVED→PROCESSING etc via transitions map only
    }
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(xferBody.note || '').trim() || undefined,
    });
    await db.collection(KITCHEN_TRANSFERS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(KITCHEN_TRANSFERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'XFER_STATUS',
      entityType: 'kitchen_transfer',
      entityId: id,
      summary: `XFR ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'kitchen-transfers' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(KITCHEN_TRANSFERS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as KitchenTransferDoc | null;
    if (!existing) return err('Transfer tidak ditemukan', 404);
    if (existing.status === 'COMPLETED') return err('Transfer selesai tidak dapat dibatalkan', 400);
    if (existing.status === 'CANCELLED') return ok({ id: path[1], status: 'CANCELLED' });
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED', XFER_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);
    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Dibatalkan',
    });
    await db.collection(KITCHEN_TRANSFERS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'XFER_CANCEL',
      entityType: 'kitchen_transfer',
      entityId: path[1],
      summary: `XFR ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id: path[1], status: 'CANCELLED' });
  }

  return null;
}
