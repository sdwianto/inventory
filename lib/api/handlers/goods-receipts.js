import { v4 as uuidv4 } from 'uuid';

import { ok, err, clean } from '@/lib/api/db';

import { requireAuth } from '@/lib/api/require-auth';

import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';

import { stampTenantId } from '@/lib/api/tenant-operational';

import { parseLokasiKode, adjustStokLokasi, ensureStokLokasiRow, syncProductStokFromLokasi } from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import { assertProductWarehouse, resolveProductGudangKode } from '@/lib/api/product-warehouse';

import { guardPosting } from '@/lib/api/period-lock';

import { calcWeightedAvgHargaBeli, buildJualPricesAfterBeliChange } from '@/lib/api/inventory-cost';

import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';
import { syncShippedDeliveriesFromSales } from '@/lib/api/grn-sync-sales';
import { isUnresolvedGrnStatus, refreshGrnProducts, refreshUnresolvedGrnsForTenant } from '@/lib/api/grn-resolve-products';
import { enrichGrnList, enrichGrnDoc } from '@/lib/api/grn-enrich';
import { notifyGrnPostedToSales } from '@/lib/api/grn-notify-sales';



export async function handleGoodsReceipts({ db, route, method, path, body, url, auth }) {

  if (route === '/goods-receipts' && method === 'GET') {

    const denied = requireAuth(auth);

    if (denied) return denied;

    const status = url.searchParams.get('status');

    let filter = status ? { status } : {};

    filter = withTenantFilter(auth, filter);

    const tenantId = auth?.tenantId || 'default';
    await refreshUnresolvedGrnsForTenant(db, tenantId);

    const list = await db.collection('goods_receipts').find(filter).sort({ tanggal: -1 }).limit(300).toArray();

    const enriched = await enrichGrnList(db, tenantId, list);

    return ok(enriched.map(clean));

  }

  if (route === '/goods-receipts/sync-shipped' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const tenantId = auth?.tenantId || 'default';
    const result = await syncShippedDeliveriesFromSales(db, tenantId);
    if (result.error) return err(result.error, 400);
    return ok(result);
  }



  if (path[0] === 'goods-receipts' && path.length === 2 && method === 'GET') {

    const denied = requireAuth(auth);

    if (denied) return denied;

    let doc = await db.collection('goods_receipts').findOne(withTenantFilter(auth, { id: path[1] }));

    if (!doc) return err('Tidak ditemukan', 404);

    doc = await refreshGrnProducts(db, doc);

    doc = await enrichGrnDoc(db, doc);

    return ok(clean(doc));

  }



  if (path[0] === 'goods-receipts' && path[2] === 'post' && method === 'POST') {

    const denied = requireAuth(auth);

    if (denied) return denied;

    const locked = await guardPosting(db, auth, body);

    if (locked) return locked;



    const grn = await db.collection('goods_receipts').findOne(withTenantFilter(auth, { id: path[1] }));

    if (!grn) return err('GRN tidak ditemukan', 404);

    if (grn.status === 'POSTED') return err('GRN sudah diposting');

    if (isUnresolvedGrnStatus(grn.status)) {
      return err('Produk belum terdaftar di Master Produk. Daftarkan/sync kode barang yang sama dari sales.app.');
    }



    const tenantId = grn.tenantId || tenantIdForWrite(auth, body);

    const now = new Date();

    const itemsFull = [];

    const lokasiSet = new Set();

    for (const [lineIndex, it] of (grn.items || []).entries()) {

      if (!it.localStokId) return err(`Kode ${it.vendorKode} belum terdaftar di Master Produk`);

      const bodyLine = body?.items?.find((b) => (
        (b.lineIndex != null && b.lineIndex === lineIndex)
        || (b.lineIndex == null && b.lineId === it.lineId)
      ));

      const qty = parseFloat(bodyLine?.qty ?? it.qtyOrdered) || 0;

      if (qty <= 0) continue;

      const prod = await db.collection('products').findOne({ id: it.localStokId, tenantId });

      if (!prod) return err(`Produk lokal tidak ditemukan: ${it.vendorKode}`);

      const lokasiKode = resolveProductGudangKode(prod);

      if (!isValidWarehouseKode(lokasiKode)) {
        return err(`Gudang tidak valid untuk ${it.vendorKode}.`, 400);
      }
      const whErr = assertProductWarehouse(prod, lokasiKode);
      if (whErr) return err(whErr.error, 400);

      lokasiSet.add(lokasiKode);



      const unitCost = parseInt(it.harga || it.hargaSatuan || 0, 10);

      const oldQty = parseFloat(prod.stok) || 0;

      const oldBeli = parseInt(prod.hargaBeli || 0, 10);

      const newBeli = calcWeightedAvgHargaBeli(oldQty, oldBeli, qty, unitCost);

      const pricePatch = buildJualPricesAfterBeliChange(oldBeli, newBeli, prod);



      await ensureStokLokasiRow(db, tenantId, it.localStokId, lokasiKode);

      const adj = await adjustStokLokasi(db, tenantId, it.localStokId, lokasiKode, qty);

      if (adj.error) return err(adj.error, 400);

      const newStok = await syncProductStokFromLokasi(db, tenantId, it.localStokId);



      await db.collection('products').updateOne(

        { id: it.localStokId, tenantId },

        { $set: { hargaBeli: newBeli, stok: newStok, ...pricePatch, updatedAt: now } },

      );



      const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;

      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {

        id: uuidv4(), stokId: it.localStokId, lokasi: lokasiLabel, lokasiKode, tanggal: now, noTransaksi: grn.noGRN,

        keterangan: `GRN dari ${grn.noDO} (sales.app)`, sourceType: 'GRN',

        masuk: qty, keluar: 0, hargaSatuan: unitCost,

      }));

      itemsFull.push({ ...it, qtyReceived: qty, lokasiKode, lokasiNama: warehouseLabel(lokasiKode), hargaBeliBaru: newBeli });

    }

    if (!itemsFull.length) return err('Tidak ada qty diterima');

    const receivedTotal = itemsFull.reduce((s, it) => {
      const qty = parseFloat(it.qtyReceived) || 0;
      const harga = parseInt(it.harga || it.hargaSatuan || 0, 10);
      return s + Math.round(qty * harga);
    }, 0);

    const lokasiSummary = [...lokasiSet].map((k) => `${k} - ${warehouseLabel(k)}`).join(', ');

    await db.collection('goods_receipts').updateOne(

      { id: grn.id },

      { $set: { status: 'POSTED', items: itemsFull, receivedTotal, lokasi: lokasiSummary, lokasiKodes: [...lokasiSet], postedAt: now, userName: body?.userName } },

    );

    const posted = await db.collection('goods_receipts').findOne({ id: grn.id });

    const cpoSync = await syncCpoOnGrnPosted(db, posted);

    const invoiceSync = await notifyGrnPostedToSales(db, tenantId, posted);

    let enriched = await enrichGrnDoc(db, posted);
    if (invoiceSync?.noInvoice) {
      enriched = { ...enriched, noInvoice: invoiceSync.noInvoice };
    }

    return ok(clean({ ...enriched, cpoSync, invoiceSync }));

  }

  if (path[0] === 'goods-receipts' && path[2] === 'replay-invoice' && method === 'POST') {
    const denied = requireAuth(auth);
    if (denied) return denied;

    const grn = await db.collection('goods_receipts').findOne(withTenantFilter(auth, { id: path[1] }));
    if (!grn) return err('GRN tidak ditemukan', 404);
    if (grn.status !== 'POSTED') return err('GRN harus POSTED dulu', 400);

    const tenantId = grn.tenantId || tenantIdForWrite(auth, body);
    const invoiceSync = await notifyGrnPostedToSales(db, tenantId, grn);
    let enriched = await enrichGrnDoc(db, grn);
    if (invoiceSync?.noInvoice) {
      enriched = { ...enriched, noInvoice: invoiceSync.noInvoice };
    }
    return ok(clean({ ...enriched, invoiceSync }));
  }

  return null;

}


