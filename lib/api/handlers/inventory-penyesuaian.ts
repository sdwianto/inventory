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
import { assertOperationalAccess } from '@/lib/api/tenant-validate';
import { requireRole, STOCK_ADJUST_ROLES } from '@/lib/api/require-auth';
import { guardPosting } from '@/lib/api/period-lock';
import {
  syncProductStokFromLokasi,
  ensureStokLokasiRow,
} from '@/lib/api/stok-lokasi';
import { warehouseLabel } from '@/lib/api/warehouses';
import { runInTransactionOrFallback } from '@/lib/api/transaction';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { resolveProductGudangKode, purgeOtherWarehouseRows } from '@/lib/api/product-warehouse';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { writeAuditLog } from '@/lib/api/audit-log';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { createJournalIfNotExists } from '@/lib/api/journal';
import { buildPenyesuaianJournalLines } from '@/lib/api/journal-lines';
import { postStockMutation } from '@/lib/api/stock-mutation';
import { syncBatchesOnVariance } from '@/lib/food-production/cycle-count-fefo';
import { syncLotsOnVariance } from '@/lib/food-production/cycle-count-ingredient-lots';
import type { HandlerContext } from '@/types/api/handler';
import { asProductRow, itemStokId, type InventoryBody } from './inventory-shared';

export async function handlePenyesuaian({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const invBody = (body || {}) as InventoryBody;

  if (route === '/stok/penyesuaian' && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('penyesuaian_stok')
      .find(withOperationalFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/stok/penyesuaian' && method === 'POST') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    const now = new Date();
    const noPS = await nextDocNumber(db, tenantId, 'PS', 'PS');
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noPenyesuaian: noPS,
      tanggal: now,
      lokasi: '',
      keterangan: invBody.keterangan || '',
      userId: invBody.userId || '',
      userName: invBody.userName || '',
      items: [] as Array<{
        stokId: string;
        kode?: string;
        nama?: string;
        satuan?: string;
        uomId?: string;
        qtyEntered?: number;
        gudangKode: string;
        qtySistem: number;
        qtyAktual: number;
        selisih: number;
        fefoSync?: Record<string, unknown>;
        lotSync?: Record<string, unknown>;
      }>,
      createdAt: now,
    });
    const adjustPlan: Array<{ prod: ReturnType<typeof asProductRow>; lokasiKode: string; lokasiLabel: string; qtyAktual: number; qtyEntered?: number; uomId?: string; satuan?: string; hargaBeli: number }> = [];
    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    for (const it of items) {
      const stokId = itemStokId(it);
      const prodRaw = await findMasterDoc(db, 'products', scopeAuth, { id: stokId });
      if (!prodRaw) return err(`Produk ${it.kode || stokId} tidak ditemukan`, 404);
      const prod = asProductRow(prodRaw);
      const resolved = await resolveLineQtyBase(db, tenantId, prod.id, {
        qty: String(it.qtyAktual ?? 0),
        uomId: (it as { uomId?: string }).uomId,
        satuan: (it as { satuan?: string }).satuan,
      }, uomsCache);
      if ('error' in resolved) return err(resolved.error, 400);
      const lokasiKode = resolveProductGudangKode(prod);
      const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
      if (!doc.lokasi) doc.lokasi = lokasiLabel;
      else if (doc.lokasi !== lokasiLabel && doc.lokasi !== 'Multi gudang') doc.lokasi = 'Multi gudang';
      adjustPlan.push({
        prod, lokasiKode, lokasiLabel,
        qtyAktual: resolved.qtyBase,
        qtyEntered: resolved.qty,
        uomId: resolved.uomId,
        satuan: resolved.satuan,
        hargaBeli: parseInt(String(prod.hargaBeli || 0), 10),
      });
    }

    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        for (const plan of adjustPlan) {
          const { prod, lokasiKode, qtyAktual, hargaBeli } = plan;
          await ensureStokLokasiRow(txDb, tenantId, prod.id, lokasiKode, session);
          const row = await txDb.collection('stok_lokasi').findOne(
            { tenantId, stokId: prod.id, lokasiKode },
            session ? { session } : {},
          );
          const qtySistem = row ? (parseFloat(String(row.qty)) || 0) : 0;
          const selisih = qtyAktual - qtySistem;
          let fefoSync: Record<string, unknown> | undefined;
          let lotSync: Record<string, unknown> | undefined;

          // W2-4/W2-8: stock mutation + FG batch sync + ingredient lot sync.
          if (selisih !== 0) {
            const posted = await postStockMutation(txDb, {
              tenantId,
              productId: prod.id,
              warehouseKode: lokasiKode,
              deltaQtyBase: selisih,
              sourceType: 'PENYESUAIAN',
              noTransaksi: noPS,
              keterangan: `Penyesuaian Stok ${selisih >= 0 ? '(+)' : '(-)'} ${noPS}`,
              hargaSatuan: prod.hargaBeli || 0,
              qtyEntered: plan.qtyEntered,
              uomId: plan.uomId,
              satuan: plan.satuan || prod.satuan,
              session,
            });
            if (!posted.ok) {
              throw new Error(posted.error || `Gagal penyesuaian ${prod.kode || prod.id}`);
            }
            const syncInput = {
              tenantId,
              stokId: prod.id,
              warehouseKode: lokasiKode,
              deltaQty: selisih,
              asOf: now,
              noDokumen: noPS,
            };
            fefoSync = await syncBatchesOnVariance(txDb, syncInput, session) as unknown as Record<string, unknown>;
            lotSync = await syncLotsOnVariance(txDb, syncInput, session) as unknown as Record<string, unknown>;
          } else {
            await syncProductStokFromLokasi(txDb, tenantId, prod.id, session);
          }

          await purgeOtherWarehouseRows(txDb, tenantId, prod.id, lokasiKode, session);

          doc.items.push({
            stokId: prod.id, kode: prod.kode, nama: prod.nama,
            satuan: plan.satuan || prod.satuan,
            uomId: plan.uomId,
            qtyEntered: plan.qtyEntered,
            gudangKode: lokasiKode, qtySistem, qtyAktual, selisih,
            ...(fefoSync ? { fefoSync } : {}),
            ...(lotSync ? { lotSync } : {}),
          });

          if (selisih !== 0) {
            const jAmt = Math.round(Math.abs(selisih) * hargaBeli);
            const jLines = buildPenyesuaianJournalLines({
              noDoc: `${noPS}/${prod.kode}`,
              amount: jAmt,
              increase: selisih > 0,
            });
            if (jLines.length) {
              await createJournalIfNotExists(txDb, {
                tanggal: now,
                keterangan: `Penyesuaian ${prod.kode} ${noPS}`,
                sourceType: 'AUTO_PENYESUAIAN',
                sourceId: `${doc.id}:${prod.id}`,
                details: jLines,
                userName: invBody.userName || '',
                tenantId,
              }, session);
            }
          }
        }
        await txDb.collection('penyesuaian_stok').insertOne(doc, session ? { session } : {});
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal menyimpan penyesuaian stok';
      return err(msg, 400);
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'STOCK_ADJUSTMENT',
      entityType: 'penyesuaian_stok',
      entityId: String(doc.id),
      summary: `Penyesuaian ${noPS} (${items.length} item)`,
      userId: String(invBody.userId || scopeAuth?.userId || ''),
      userName: String(invBody.userName || scopeAuth?.name || scopeAuth?.email || 'System'),
      metadata: { noPenyesuaian: noPS, itemCount: items.length },
    });
    await invalidateDashboardSnapshot(db, tenantId);
    return ok(clean(doc));
  }

  if (path[0] === 'stok' && path[1] === 'penyesuaian' && path.length === 3 && method === 'GET') {
    const deniedRole = requireRole(auth, STOCK_ADJUST_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const access = await assertOperationalAccess(db, scopeAuth, 'penyesuaian_stok', { id: path[2] });
    if ('error' in access) return access.error;
    return ok(clean(access.doc));
  }

  return null;
}
