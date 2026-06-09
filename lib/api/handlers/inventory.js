// Inventory handler: Kartu Stok, Penyesuaian, Produksi, Lokasi (master), Transfer Stok.

import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  tenantIdForWrite,
  bootstrapTenantMasterData,
  findMasterDoc,
  resolveActingTenantId,
  authForMasterActing,
} from '@/lib/api/tenant-master';
import {
  withOperationalFilter,
  stampTenantId,
  updateProductStockScoped,
} from '@/lib/api/tenant-operational';
import { assertOperationalAccess, assertMasterAccess } from '@/lib/api/tenant-validate';
import { bulkDeleteMaster } from '@/lib/api/bulk-delete-master';
import { guardPosting } from '@/lib/api/period-lock';
import {
  parseLokasiKode,
  setQtyStokLokasi,
  syncProductStokFromLokasi,
  ensureStokLokasiRow,
  transferStokBetweenLokasi,
} from '@/lib/api/stok-lokasi';

export async function handleInventory({ db, route, method, path, body, url, auth }) {
  // ---------- KARTU STOK ----------
  if (route === '/stok/kartu' && method === 'GET') {
    const productId = url.searchParams.get('productId') || '';
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    let filter = {};
    if (productId) filter.stokId = productId;
    if (from || to) {
      filter.tanggal = {};
      if (from) filter.tanggal.$gte = new Date(from);
      if (to) filter.tanggal.$lte = new Date(to);
    }
    filter = withOperationalFilter(auth, filter);
    const list = await db.collection('stok_kartu')
      .find(filter)
      .project({
        id: 1, stokId: 1, lokasi: 1, tanggal: 1, noTransaksi: 1, keterangan: 1,
        sourceType: 1, masuk: 1, keluar: 1, hargaSatuan: 1, tenantId: 1,
      })
      .sort({ tanggal: 1, _id: 1 })
      .limit(2000)
      .toArray();
    let saldo = 0;
    const enriched = list.map((r) => {
      saldo += (r.masuk || 0) - (r.keluar || 0);
      return { ...clean(r), saldo };
    });
    let product = null;
    if (productId) {
      const p = await findMasterDoc(db, 'products', auth, { id: productId });
      if (p) product = clean(p);
    }
    return ok({ rows: enriched, product });
  }

  // ---------- PENYESUAIAN ----------
  if (route === '/stok/penyesuaian' && method === 'GET') {
    const list = await db.collection('penyesuaian_stok')
      .find(withOperationalFilter(auth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }
  if (route === '/stok/penyesuaian' && method === 'POST') {
    const locked = await guardPosting(db, auth, body);
    if (locked) return locked;
    const items = body?.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(auth, body);
    const lokasiKode = parseLokasiKode(body.lokasi);
    const now = new Date();
    const noPS = `PS${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noPenyesuaian: noPS,
      tanggal: now,
      lokasi: body.lokasi || 'L001 - Toko Utama',
      keterangan: body.keterangan || '',
      userId: body.userId || '',
      userName: body.userName || '',
      items: [],
      createdAt: now,
    });
    for (const it of items) {
      const prod = await findMasterDoc(db, 'products', auth, { id: it.stokId });
      if (!prod) return err(`Produk ${it.kode || it.stokId} tidak ditemukan`, 404);
      await ensureStokLokasiRow(db, tenantId, prod.id, lokasiKode);
      const row = await db.collection('stok_lokasi').findOne({
        tenantId, stokId: prod.id, lokasiKode,
      });
      const qtySistem = row?.qty ?? prod.stok ?? 0;
      const qtyAktual = parseFloat(it.qtyAktual || 0);
      const selisih = qtyAktual - qtySistem;
      doc.items.push({
        stokId: prod.id, kode: prod.kode, nama: prod.nama, satuan: prod.satuan,
        qtySistem, qtyAktual, selisih,
      });
      await setQtyStokLokasi(db, tenantId, prod.id, lokasiKode, qtyAktual);
      await syncProductStokFromLokasi(db, tenantId, prod.id);
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(),
        stokId: prod.id, lokasi: doc.lokasi, tanggal: now, noTransaksi: noPS,
        keterangan: `Penyesuaian Stok ${selisih >= 0 ? '(+)' : '(-)'}`,
        sourceType: 'PENYESUAIAN',
        masuk: selisih > 0 ? selisih : 0,
        keluar: selisih < 0 ? Math.abs(selisih) : 0,
        hargaSatuan: prod.hargaBeli || 0,
      }));
    }
    await db.collection('penyesuaian_stok').insertOne(doc);
    return ok(clean(doc));
  }
  if (path[0] === 'stok' && path[1] === 'penyesuaian' && path.length === 3 && method === 'GET') {
    const access = await assertOperationalAccess(db, auth, 'penyesuaian_stok', { id: path[2] });
    if (access.error) return access.error;
    return ok(clean(access.doc));
  }

  // ---------- PRODUKSI ----------
  if (route === '/stok/produksi' && method === 'GET') {
    const list = await db.collection('produksi')
      .find(withOperationalFilter(auth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }
  if (route === '/stok/produksi' && method === 'POST') {
    const locked = await guardPosting(db, auth, body);
    if (locked) return locked;
    const bahan = body?.bahan || [];
    const hasil = body?.hasil || [];
    if (bahan.length === 0 || hasil.length === 0) return err('Bahan dan hasil wajib diisi');
    const tenantId = tenantIdForWrite(auth, body);
    for (const b of bahan) {
      const prod = await findMasterDoc(db, 'products', auth, { id: b.stokId });
      if (!prod) return err(`Bahan ${b.kode || b.stokId} tidak ditemukan`, 404);
      if ((prod.stok || 0) < b.qty) return err(`Stok bahan ${prod.nama} tidak cukup (sisa: ${prod.stok})`, 400);
    }
    const now = new Date();
    const kodeProduksi = `TP${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const biayaProduksi = parseInt(body.biayaProduksi || 0, 10);

    const bahanItems = [];
    let totalCostBahan = 0;
    for (const b of bahan) {
      const prod = await findMasterDoc(db, 'products', auth, { id: b.stokId });
      const qty = parseFloat(b.qty);
      const hargaBeli = prod.hargaBeli || 0;
      totalCostBahan += qty * hargaBeli;
      bahanItems.push({ stokId: prod.id, kode: prod.kode, nama: prod.nama, satuan: prod.satuan, qty, hargaBeli });
    }
    const totalCost = totalCostBahan + biayaProduksi;
    const totalHasilQty = hasil.reduce((s, h) => s + parseFloat(h.qty || 0), 0);
    const hppPerUnit = totalHasilQty > 0 ? Math.round(totalCost / totalHasilQty) : 0;

    const hasilItems = [];
    for (const h of hasil) {
      const prod = await findMasterDoc(db, 'products', auth, { id: h.stokId });
      if (!prod) return err(`Hasil ${h.kode || h.stokId} tidak ditemukan`, 404);
      hasilItems.push({ stokId: prod.id, kode: prod.kode, nama: prod.nama, satuan: prod.satuan, qty: parseFloat(h.qty), hargaBeli: hppPerUnit });
    }

    const doc = stampTenantId(tenantId, {
      id: uuidv4(), kodeProduksi, tanggal: now, catatan: body.catatan || '',
      biayaProduksi, totalCostBahan, totalCost, hppPerUnit,
      userId: body.userId || '', userName: body.userName || '',
      bahan: bahanItems, hasil: hasilItems, createdAt: now,
    });

    for (const b of bahanItems) {
      await updateProductStockScoped(db, tenantId, b.stokId, { $inc: { stok: -b.qty }, $set: { updatedAt: now } });
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId: b.stokId, tanggal: now, noTransaksi: kodeProduksi,
        keterangan: 'Produksi - Bahan', sourceType: 'PRODUKSI',
        masuk: 0, keluar: b.qty, hargaSatuan: b.hargaBeli,
      }));
    }
    for (const h of hasilItems) {
      await updateProductStockScoped(db, tenantId, h.stokId, {
        $inc: { stok: h.qty },
        $set: { updatedAt: now, hargaBeli: hppPerUnit },
      });
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId: h.stokId, tanggal: now, noTransaksi: kodeProduksi,
        keterangan: 'Produksi - Hasil', sourceType: 'PRODUKSI',
        masuk: h.qty, keluar: 0, hargaSatuan: hppPerUnit,
      }));
    }
    await db.collection('produksi').insertOne(doc);
    return ok(clean(doc));
  }
  if (path[0] === 'stok' && path[1] === 'produksi' && path.length === 3 && method === 'GET') {
    const access = await assertOperationalAccess(db, auth, 'produksi', { id: path[2] });
    if (access.error) return access.error;
    return ok(clean(access.doc));
  }

  // ---------- LOKASI MASTER ----------
  if (route === '/lokasi' && method === 'GET') {
    const acting = resolveActingTenantId(auth, { url });
    const scopeAuth = auth?.isMaster && url.searchParams.get('tenantId')
      ? authForMasterActing(auth, acting)
      : auth;
    const tenantId = acting || auth?.tenantId || 'default';
    const filter = withTenantFilter(scopeAuth, {});
    let list = await db.collection('lokasi').find(filter).sort({ kode: 1 }).toArray();
    if (list.length === 0 && !auth?.isMaster) {
      await bootstrapTenantMasterData(db, tenantId, { includeProducts: false });
      list = await db.collection('lokasi').find(filter).sort({ kode: 1 }).toArray();
    }
    return ok(list.map(clean));
  }
  if (route === '/lokasi' && method === 'POST') {
    if (!body?.nama) return err('Nama wajib');
    if (auth?.isMaster && !body?.tenantId) return err('Pilih tenant untuk lokasi baru', 400);
    const tenantId = tenantIdForWrite(auth, body);
    const kode = body.kode || `L${String(Date.now()).slice(-3)}`;
    const existing = await db.collection('lokasi').findOne({ tenantId, kode });
    if (existing) return err('Kode lokasi sudah ada di tenant ini');
    const doc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama: body.nama,
      keterangan: body.keterangan || '',
      aktif: true,
      createdAt: new Date(),
    };
    await db.collection('lokasi').insertOne(doc);
    return ok(clean(doc));
  }
  if (path[0] === 'lokasi' && path.length === 2) {
    const id = path[1];
    const access = await assertMasterAccess(db, auth, 'lokasi', { id });
    if (method === 'PUT') {
      if (access.error) return access.error;
      const lokExisting = access.doc;
      const update = { ...(body || {}), updatedAt: new Date() };
      delete update.id;
      delete update._id;
      delete update.tenantId;
      await db.collection('lokasi').updateOne(
        withTenantFilter(auth, { id }),
        { $set: update },
      );
      return ok(clean(await findMasterDoc(db, 'lokasi', auth, { id })));
    }
    if (method === 'DELETE') {
      if (access.error) return access.error;
      await db.collection('lokasi').deleteOne(withTenantFilter(auth, { id }));
      return ok({ message: 'deleted' });
    }
  }
  if (route === '/lokasi/bulk-delete' && method === 'POST') {
    return bulkDeleteMaster(db, auth, 'lokasi', body?.ids);
  }

  // ---------- TRANSFER STOK ----------
  if (route === '/stok/transfer' && method === 'GET') {
    const list = await db.collection('transfer_stok')
      .find(withOperationalFilter(auth, {}))
      .sort({ tanggal: -1 })
      .limit(200)
      .toArray();
    return ok(list.map(clean));
  }
  if (route === '/stok/transfer' && method === 'POST') {
    const locked = await guardPosting(db, auth, body);
    if (locked) return locked;
    if (!body?.lokasiAsal || !body?.lokasiTujuan) return err('Lokasi asal & tujuan wajib');
    if (body.lokasiAsal === body.lokasiTujuan) return err('Lokasi asal & tujuan tidak boleh sama');
    const items = body.items || [];
    if (items.length === 0) return err('Tidak ada item');
    const tenantId = tenantIdForWrite(auth, body);
    for (const it of items) {
      const prod = await findMasterDoc(db, 'products', auth, { id: it.stokId });
      if (!prod) return err(`Produk ${it.kode || it.stokId} tidak ditemukan`, 404);
      await ensureStokLokasiRow(db, tenantId, it.stokId, body.lokasiAsal);
      const tr = await transferStokBetweenLokasi(
        db, tenantId, it.stokId, body.lokasiAsal, body.lokasiTujuan, it.qty,
      );
      if (tr.error) return err(`Stok ${prod.nama}: ${tr.error}`, 400);
    }
    const now = new Date();
    const noTransfer = `TR${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
    const doc = stampTenantId(tenantId, {
      id: uuidv4(), noTransfer, tanggal: now,
      lokasiAsal: body.lokasiAsal, lokasiAsalNama: body.lokasiAsalNama || '',
      lokasiTujuan: body.lokasiTujuan, lokasiTujuanNama: body.lokasiTujuanNama || '',
      keterangan: body.keterangan || '', items, userName: body.userName || '', createdAt: now,
    });
    await db.collection('transfer_stok').insertOne(doc);
    for (const it of items) {
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId: it.stokId, lokasi: body.lokasiAsal, tanggal: now,
        noTransaksi: noTransfer, keterangan: `Transfer keluar ke ${body.lokasiTujuanNama || body.lokasiTujuan}`,
        sourceType: 'TRANSFER', masuk: 0, keluar: parseFloat(it.qty), hargaSatuan: it.hargaBeli || 0,
      }));
      await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
        id: uuidv4(), stokId: it.stokId, lokasi: body.lokasiTujuan, tanggal: now,
        noTransaksi: noTransfer, keterangan: `Transfer masuk dari ${body.lokasiAsalNama || body.lokasiAsal}`,
        sourceType: 'TRANSFER', masuk: parseFloat(it.qty), keluar: 0, hargaSatuan: it.hargaBeli || 0,
      }));
    }
    return ok(clean(doc));
  }

  return null;
}
