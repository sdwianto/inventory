import { v4 as uuidv4 } from 'uuid';

import { ok, err, clean } from '@/lib/api/db';

import { requireAuth } from '@/lib/api/require-auth';

import { tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';

import { stampTenantId } from '@/lib/api/tenant-operational';

import { parseLokasiKode, adjustStokLokasi, ensureStokLokasiRow, syncProductStokFromLokasi } from '@/lib/api/stok-lokasi';

import { guardPosting } from '@/lib/api/period-lock';

import { calcWeightedAvgHargaBeli, buildJualPricesAfterBeliChange } from '@/lib/api/inventory-cost';



export async function handleGoodsReceipts({ db, route, method, path, body, url, auth }) {

  if (route === '/goods-receipts' && method === 'GET') {

    const denied = requireAuth(auth);

    if (denied) return denied;

    const status = url.searchParams.get('status');

    let filter = status ? { status } : {};

    filter = withTenantFilter(auth, filter);

    const list = await db.collection('goods_receipts').find(filter).sort({ tanggal: -1 }).limit(300).toArray();

    return ok(list.map(clean));

  }



  if (path[0] === 'goods-receipts' && path.length === 2 && method === 'GET') {

    const denied = requireAuth(auth);

    if (denied) return denied;

    const doc = await db.collection('goods_receipts').findOne(withTenantFilter(auth, { id: path[1] }));

    if (!doc) return err('Tidak ditemukan', 404);

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

    if (grn.status === 'NEEDS_MAPPING') return err('Selesaikan mapping produk terlebih dahulu');



    const tenantId = grn.tenantId || tenantIdForWrite(auth, body);

    const lokasi = body?.lokasi || grn.lokasi || 'L001';

    const lokasiKode = parseLokasiKode(lokasi);

    const now = new Date();

    const itemsFull = [];



    for (const it of (grn.items || [])) {

      if (!it.localStokId) return err(`Baris ${it.vendorKode} belum ter-mapping`);

      const qty = parseFloat(body?.items?.find((b) => b.lineId === it.lineId)?.qty ?? it.qtyOrdered) || 0;

      if (qty <= 0) continue;



      const prod = await db.collection('products').findOne({ id: it.localStokId, tenantId });

      if (!prod) return err(`Produk lokal tidak ditemukan: ${it.vendorKode}`);



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



      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {

        id: uuidv4(), stokId: it.localStokId, lokasi, tanggal: now, noTransaksi: grn.noGRN,

        keterangan: `GRN dari ${grn.noDO} (sales.app)`, sourceType: 'GRN',

        masuk: qty, keluar: 0, hargaSatuan: unitCost,

      }));

      itemsFull.push({ ...it, qtyReceived: qty, hargaBeliBaru: newBeli });

    }

    if (!itemsFull.length) return err('Tidak ada qty diterima');



    await db.collection('goods_receipts').updateOne(

      { id: grn.id },

      { $set: { status: 'POSTED', items: itemsFull, lokasi, postedAt: now, userName: body?.userName } },

    );

    return ok(clean(await db.collection('goods_receipts').findOne({ id: grn.id })));

  }

  return null;

}


