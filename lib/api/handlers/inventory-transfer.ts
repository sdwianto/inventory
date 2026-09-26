import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  findMasterDoc,
  resolveOperationalScope,
  tenantIdForWrite,
} from '@/lib/api/tenant-master';
import {
  withOperationalFilter,
  stampTenantId,
} from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import { requireRole, STOCK_TRANSFER_ROLES } from '@/lib/api/require-auth';
import { parseLokasiKode } from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode } from '@/lib/api/warehouses';
import { postStockMovements } from '@/lib/stock-ledger';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';
import { writeAuditLog } from '@/lib/api/audit-log';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { runInTransactionOrFallback } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { relocateBatchesFefo } from '@/lib/food-production/transfer-fefo';
import { isFoodSafetyHoldEnforced } from '@/lib/api/feature-flags';
import { assertFefoExitNotBlockedByHold } from '@/lib/food-production/food-safety-exit-gate';
import type { HandlerContext } from '@/types/api/handler';
import { asProductRow, itemStokId, type InventoryBody } from './inventory-shared';

type TransferLine = Record<string, unknown> & {
  qtyBase: number;
  qty: number;
  uomId?: string;
  satuan?: string;
  hargaBeli?: number;
};

export async function handleTransfer({
  db,
  route,
  method,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const invBody = (body || {}) as InventoryBody;

  if (route === '/stok/transfer' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('transfer_stok')
      .find(withOperationalFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/stok/transfer' && method === 'POST') {
    const deniedRole = requireRole(auth, [...STOCK_TRANSFER_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const actorName = String(scopeAuth?.name || scopeAuth?.email || 'System');
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    if (!invBody?.lokasiAsal || !invBody?.lokasiTujuan) return err('Lokasi asal & tujuan wajib');
    if (invBody.lokasiAsal === invBody.lokasiTujuan) return err('Lokasi asal & tujuan tidak boleh sama');
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    const transferLines: TransferLine[] = [];

    for (const it of items) {
      const stokId = itemStokId(it);
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: stokId });
      if (!prodRaw) return err(`Produk ${it.kode || stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      const whCheckAsal = assertProductWarehouse(prod, invBody.lokasiAsal);
      if (whCheckAsal) return err(whCheckAsal.error, 400);
      const whCheckTujuan = assertProductWarehouse(prod, invBody.lokasiTujuan);
      if (whCheckTujuan) return err(whCheckTujuan.error, 400);
      const resolved = await resolveLineQtyBase(db, tenantId, prod.id, {
        qty: String(it.qty ?? 0),
        uomId: (it as { uomId?: string }).uomId,
        satuan: (it as { satuan?: string }).satuan,
      }, uomsCache);
      if ('error' in resolved) return err(resolved.error, 400);
      transferLines.push({
        ...it,
        qty: resolved.qty,
        qtyBase: resolved.qtyBase,
        uomId: resolved.uomId,
        satuan: resolved.satuan,
        hargaBeli: prod.hargaBeli,
      });
    }

    const now = new Date();
    let noTransfer = '';
    const doc = stampTenantId(tenantId, {
      id: uuidv4(), noTransfer, tanggal: now,
      lokasiAsal: invBody.lokasiAsal, lokasiAsalNama: invBody.lokasiAsalNama || '',
      lokasiTujuan: invBody.lokasiTujuan, lokasiTujuanNama: invBody.lokasiTujuanNama || '',
      keterangan: invBody.keterangan || '', items: transferLines, userId: scopeAuth?.userId || '', userName: actorName, createdAt: now,
    });

    // ADR-004 P0G — gate dokumen transfer sebelum mutasi stok (relocate mewarisi HOLD).
    const enforceFoodSafetyHold = await isFoodSafetyHoldEnforced(db, tenantId);
    const asalKode = parseLokasiKode(invBody.lokasiAsal);
    const tujuanKode = parseLokasiKode(invBody.lokasiTujuan);
    const holdGate = await assertFefoExitNotBlockedByHold(db, {
      tenantId,
      enforce: enforceFoodSafetyHold,
      asOf: now,
      allowExpired: true,
      context: 'transfer',
      lines: transferLines.map((it) => ({
        stokId: itemStokId(it),
        stokNama: String((it as { nama?: string }).nama || ''),
        warehouseKode: asalKode,
        needQty: it.qtyBase,
      })),
    });
    if (!holdGate.ok) return err(holdGate.error, 400);

    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        noTransfer = await nextDocNumber(txDb, tenantId, 'TR', 'TR', session);
        doc.noTransfer = noTransfer;
        const fefoRelocate: Array<Record<string, unknown>> = [];
        const lotRelocate: Array<Record<string, unknown>> = [];
        if (asalKode === tujuanKode) throw new Error('Lokasi asal dan tujuan sama');
        if (isValidWarehouseKode(asalKode) && isValidWarehouseKode(tujuanKode)) {
          throw new Error('Produk tidak bisa dipindah antar Gudang Kering dan Basah — item di kedua gudang berbeda');
        }
        const posted = await postStockMovements(txDb, session, {
          tenantId,
          sourceType: 'TRANSFER',
          sourceId: String(doc.id),
          noTransaksi: noTransfer,
          keterangan: `Transfer ${noTransfer}`,
          postingDate: now,
          actor: scopeAuth ? { userId: scopeAuth.userId, userName: scopeAuth.name || scopeAuth.email, role: scopeAuth.role } : null,
          lines: transferLines.flatMap((it, idx) => {
            const stokId = itemStokId(it);
            const common = {
              productId: stokId,
              qtyEntered: it.qty,
              uomId: it.uomId,
              satuan: it.satuan,
              unitCost: Number(it.hargaBeli) > 0 ? Number(it.hargaBeli) : undefined,
            };
            return [
              {
                ...common,
                lineRef: `${idx + 1}:OUT`,
                warehouseKode: String(invBody.lokasiAsal),
                deltaQtyBase: -it.qtyBase,
                lokasiLabel: String(invBody.lokasiAsal),
                keterangan: `Transfer keluar ke ${invBody.lokasiTujuanNama || invBody.lokasiTujuan}`,
                // W2-13: lot bahan pindah FEFO bersama stok.
                lotPolicy: { mode: 'RELOCATE' as const, toWarehouseKode: tujuanKode },
              },
              {
                ...common,
                lineRef: `${idx + 1}:IN`,
                warehouseKode: String(invBody.lokasiTujuan),
                deltaQtyBase: it.qtyBase,
                lokasiLabel: String(invBody.lokasiTujuan),
                keterangan: `Transfer masuk dari ${invBody.lokasiAsalNama || invBody.lokasiAsal}`,
              },
            ];
          }),
        });
        if (!posted.ok) throw new Error(posted.error);

        for (const line of posted.lines) {
          if (!line.lot) continue;
          lotRelocate.push({
            stokId: line.productId,
            fromWarehouseKode: asalKode,
            toWarehouseKode: tujuanKode,
            needQty: -line.deltaQtyBase,
            allocated: line.lot.allocated,
            shortfall: line.lot.shortfall,
            skippedNoLots: line.lot.skippedNoLots,
            allocations: line.lot.allocations,
          });
        }

        for (const it of transferLines) {
          const stokId = itemStokId(it);
          // W2-12: relocate FG batches FEFO with the stock move.
          const fefo = await relocateBatchesFefo(
            txDb,
            {
              tenantId,
              stokId,
              fromWarehouseKode: asalKode,
              toWarehouseKode: tujuanKode,
              needQty: it.qtyBase,
              asOf: now,
              allowExpired: true,
              noTransaksi: noTransfer,
              transferId: String(doc.id),
              enforceFoodSafetyHold,
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
        }
        (doc as Record<string, unknown>).fefoRelocate = fefoRelocate;
        (doc as Record<string, unknown>).lotRelocate = lotRelocate;
        await txDb.collection('transfer_stok').insertOne(doc, session ? { session } : {});
        await writeAuditLog(txDb, {
          tenantId,
          action: 'STOCK_TRANSFER',
          entityType: 'transfer_stok',
          entityId: String(doc.id),
          summary: `Transfer ${noTransfer}`,
          userId: scopeAuth?.userId,
          userName: actorName,
          metadata: {
            noTransfer,
            lokasiAsal: invBody.lokasiAsal,
            lokasiTujuan: invBody.lokasiTujuan,
            itemCount: items.length,
          },
        }, session);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan transfer stok';
      return err(msg, 400);
    }
    await invalidateDashboardSnapshot(db, tenantId);
    return ok(clean(doc));
  }

  return null;
}
