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
import {
  ensureStokLokasiRow,
  transferStokBetweenLokasi,
} from '@/lib/api/stok-lokasi';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';
import { writeAuditLog } from '@/lib/api/audit-log';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import type { HandlerContext } from '@/types/api/handler';
import { asProductRow, itemStokId, type InventoryBody } from './inventory-shared';

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
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const locked = await guardPosting(db, scopeAuth, invBody);
    if (locked) return locked;
    if (!invBody?.lokasiAsal || !invBody?.lokasiTujuan) return err('Lokasi asal & tujuan wajib');
    if (invBody.lokasiAsal === invBody.lokasiTujuan) return err('Lokasi asal & tujuan tidak boleh sama');
    const items = invBody.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(scopeAuth, invBody);
    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    const transferLines: Array<Record<string, unknown> & { qtyBase: number; qty: number; uomId?: string; satuan?: string }> = [];
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
      await ensureStokLokasiRow(db, tenantId, stokId, invBody.lokasiAsal);
      const tr = await transferStokBetweenLokasi(
        db, tenantId, stokId, invBody.lokasiAsal!, invBody.lokasiTujuan!, resolved.qtyBase,
      );
      if ('error' in tr && tr.error) return err(`Stok ${prod.nama}: ${tr.error}`, 400);
      transferLines.push({
        ...it,
        qty: resolved.qty,
        qtyBase: resolved.qtyBase,
        uomId: resolved.uomId,
        satuan: resolved.satuan,
      });
    }
    const now = new Date();
    const noTransfer = `TR${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(), noTransfer, tanggal: now,
      lokasiAsal: invBody.lokasiAsal, lokasiAsalNama: invBody.lokasiAsalNama || '',
      lokasiTujuan: invBody.lokasiTujuan, lokasiTujuanNama: invBody.lokasiTujuanNama || '',
      keterangan: invBody.keterangan || '', items: transferLines, userName: invBody.userName || '', createdAt: now,
    });
    await db.collection('transfer_stok').insertOne(doc);
    for (const it of transferLines) {
      const stokId = itemStokId(it);
      const qtyBase = it.qtyBase;
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId, lokasi: invBody.lokasiAsal, tanggal: now,
        noTransaksi: noTransfer, keterangan: `Transfer keluar ke ${invBody.lokasiTujuanNama || invBody.lokasiTujuan}`,
        sourceType: 'TRANSFER', masuk: 0, keluar: qtyBase,
        qtyEntered: it.qty, uomId: it.uomId, satuan: it.satuan,
        hargaSatuan: it.hargaBeli || 0,
      }));
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId, lokasi: invBody.lokasiTujuan, tanggal: now,
        noTransaksi: noTransfer, keterangan: `Transfer masuk dari ${invBody.lokasiAsalNama || invBody.lokasiAsal}`,
        sourceType: 'TRANSFER', masuk: qtyBase, keluar: 0,
        qtyEntered: it.qty, uomId: it.uomId, satuan: it.satuan,
        hargaSatuan: it.hargaBeli || 0,
      }));
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'STOCK_TRANSFER',
      entityType: 'transfer_stok',
      entityId: String(doc.id),
      summary: `Transfer ${noTransfer}`,
      userName: String(invBody.userName || scopeAuth?.name || scopeAuth?.email || 'System'),
      metadata: {
        noTransfer,
        lokasiAsal: invBody.lokasiAsal,
        lokasiTujuan: invBody.lokasiTujuan,
        itemCount: items.length,
      },
    });
    await invalidateDashboardSnapshot(db, tenantId);
    return ok(clean(doc));
  }

  return null;
}
