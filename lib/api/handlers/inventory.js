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
import { requireAuth } from '@/lib/api/require-auth';
import { bulkDeleteMaster } from '@/lib/api/bulk-delete-master';
import { guardPosting } from '@/lib/api/period-lock';
import {
  parseLokasiKode,
  setQtyStokLokasi,
  syncProductStokFromLokasi,
  ensureStokLokasiRow,
  transferStokBetweenLokasi,
  getStokByWarehouseBatch,
} from '@/lib/api/stok-lokasi';
import { warehouseLabel, WAREHOUSE_CODES, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';

function periodKey(date, granularity) {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (granularity === 'day') return `${y}-${m}-${day}`;
  return `${y}-${m}`;
}

function emptyTrendBucket(key, label) {
  return {
    period: key,
    label,
    masukQty: 0,
    keluarQty: 0,
    netQty: 0,
    masukNilai: 0,
    keluarNilai: 0,
    netNilai: 0,
    keringMasukQty: 0,
    keringKeluarQty: 0,
    basahMasukQty: 0,
    basahKeluarQty: 0,
    keringMasukNilai: 0,
    keringKeluarNilai: 0,
    basahMasukNilai: 0,
    basahKeluarNilai: 0,
    transaksi: 0,
  };
}

async function aggregateOpeningBefore(db, tid, since) {
  const rows = await db.collection('stok_kartu').aggregate([
    { $match: { tenantId: tid, tanggal: { $lt: since } } },
    {
      $group: {
        _id: { $ifNull: ['$lokasiKode', '$lokasi'] },
        masuk: { $sum: { $ifNull: ['$masuk', 0] } },
        keluar: { $sum: { $ifNull: ['$keluar', 0] } },
      },
    },
  ]).toArray();

  let kering = 0;
  let basah = 0;
  for (const r of rows) {
    const net = (parseFloat(r.masuk) || 0) - (parseFloat(r.keluar) || 0);
    const lok = normalizeWarehouseKode(r._id || '');
    if (lok === 'GKERING') kering += net;
    else if (lok === 'GBASAH') basah += net;
  }
  return { kering, basah, total: kering + basah };
}

async function buildStockTrend(db, tenantId, { months = 6, granularity = 'day' } = {}) {
  const tid = tenantId || 'default';
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  since.setHours(0, 0, 0, 0);
  const until = new Date();
  until.setHours(23, 59, 59, 999);

  const opening = await aggregateOpeningBefore(db, tid, since);

  const entries = await db.collection('stok_kartu')
    .find({ tenantId: tid, tanggal: { $gte: since, $lte: until } })
    .project({
      tanggal: 1, masuk: 1, keluar: 1, hargaSatuan: 1, lokasi: 1, lokasiKode: 1,
    })
    .sort({ tanggal: 1 })
    .toArray();

  const buckets = new Map();
  for (const e of entries) {
    const key = periodKey(e.tanggal, granularity);
    const d = new Date(e.tanggal);
    const label = granularity === 'day'
      ? d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
      : d.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });
    if (!buckets.has(key)) buckets.set(key, emptyTrendBucket(key, label));

    const b = buckets.get(key);
    const masuk = parseFloat(e.masuk) || 0;
    const keluar = parseFloat(e.keluar) || 0;
    const harga = parseInt(e.hargaSatuan || 0, 10);
    const lok = normalizeWarehouseKode(e.lokasiKode || e.lokasi || '');

    b.masukQty += masuk;
    b.keluarQty += keluar;
    b.masukNilai += masuk * harga;
    b.keluarNilai += keluar * harga;
    b.transaksi += 1;

    if (lok === 'GKERING') {
      b.keringMasukQty += masuk;
      b.keringKeluarQty += keluar;
      b.keringMasukNilai += masuk * harga;
      b.keringKeluarNilai += keluar * harga;
    } else if (lok === 'GBASAH') {
      b.basahMasukQty += masuk;
      b.basahKeluarQty += keluar;
      b.basahMasukNilai += masuk * harga;
      b.basahKeluarNilai += keluar * harga;
    }
  }

  let runningQty = opening.total;
  let runningNilai = 0;
  let runningKering = opening.kering;
  let runningBasah = opening.basah;
  const periods = [];

  const cursor = new Date(since);
  while (cursor <= until) {
    const key = periodKey(cursor, granularity);
    const label = granularity === 'day'
      ? cursor.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })
      : cursor.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });

    const row = buckets.get(key) || emptyTrendBucket(key, label);
    row.netQty = row.masukQty - row.keluarQty;
    row.netNilai = row.masukNilai - row.keluarNilai;
    row.keringNetQty = row.keringMasukQty - row.keringKeluarQty;
    row.basahNetQty = row.basahMasukQty - row.basahKeluarQty;

    runningQty += row.netQty;
    runningNilai += row.netNilai;
    runningKering += row.keringNetQty;
    runningBasah += row.basahNetQty;

    periods.push({
      ...row,
      label,
      saldoQtyKumulatif: runningQty,
      saldoNilaiKumulatif: runningNilai,
      keringSaldoKumulatif: runningKering,
      basahSaldoKumulatif: runningBasah,
    });

    if (granularity === 'day') {
      cursor.setDate(cursor.getDate() + 1);
    } else {
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  const totals = periods.reduce((acc, p) => ({
    masukQty: acc.masukQty + p.masukQty,
    keluarQty: acc.keluarQty + p.keluarQty,
    netQty: acc.netQty + p.netQty,
    masukNilai: acc.masukNilai + p.masukNilai,
    keluarNilai: acc.keluarNilai + p.keluarNilai,
    netNilai: acc.netNilai + p.netNilai,
    keringMasukQty: acc.keringMasukQty + p.keringMasukQty,
    keringKeluarQty: acc.keringKeluarQty + p.keringKeluarQty,
    basahMasukQty: acc.basahMasukQty + p.basahMasukQty,
    basahKeluarQty: acc.basahKeluarQty + p.basahKeluarQty,
    transaksi: acc.transaksi + p.transaksi,
  }), {
    masukQty: 0, keluarQty: 0, netQty: 0,
    masukNilai: 0, keluarNilai: 0, netNilai: 0,
    keringMasukQty: 0, keringKeluarQty: 0, basahMasukQty: 0, basahKeluarQty: 0,
    transaksi: 0,
  });

  return {
    periods,
    totals,
    opening,
    since: since.toISOString(),
    until: until.toISOString(),
    granularity,
  };
}

export async function handleInventory({ db, route, method, path, body, url, auth }) {
  // ---------- SALDO PER GUDANG ----------
  if (route === '/stok/saldo' && method === 'GET') {
    const denied = requireAuth(auth);
    if (denied) return denied;
    const acting = resolveActingTenantId(auth, { url });
    const scopeAuth = auth?.isMaster && url.searchParams.get('tenantId')
      ? authForMasterActing(auth, acting)
      : auth;
    const tid = acting || auth?.tenantId || 'default';
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    let filter = withTenantFilter(scopeAuth, { aktif: { $ne: false } });
    if (q) {
      filter = {
        ...filter,
        $or: [
          { nama: { $regex: q, $options: 'i' } },
          { kode: { $regex: q, $options: 'i' } },
        ],
      };
    }
    const gudangFilter = url.searchParams.get('gudang');
    if (gudangFilter && WAREHOUSE_CODES.includes(normalizeWarehouseKode(gudangFilter))) {
      filter = { ...filter, gudangKode: normalizeWarehouseKode(gudangFilter) };
    }
    const products = await db.collection('products')
      .find(filter)
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, stok: 1, hargaBeli: 1, tenantId: 1, gudangKode: 1 })
      .sort({ gudangKode: 1, nama: 1 })
      .limit(500)
      .toArray();
    const trendMonths = Math.min(24, Math.max(1, parseInt(url.searchParams.get('trendMonths') || '6', 10)));
    const stokMap = await getStokByWarehouseBatch(db, tid, products.map((p) => p.id));
    let summaryQtyKering = 0;
    let summaryQtyBasah = 0;
    let summaryNilaiKering = 0;
    let summaryNilaiBasah = 0;
    let skuAktif = 0;

    const rows = products.map((p) => {
      const gudangKode = resolveProductGudangKode(p);
      const byWh = stokMap.get(p.id) || Object.fromEntries(WAREHOUSE_CODES.map((k) => [k, 0]));
      const stokQty = byWh[gudangKode] || parseFloat(p.stok) || 0;
      const hargaBeli = parseInt(p.hargaBeli || 0, 10);
      const nilaiStok = Math.round(stokQty * hargaBeli);
      const qtyKering = gudangKode === 'GKERING' ? stokQty : 0;
      const qtyBasah = gudangKode === 'GBASAH' ? stokQty : 0;
      const nilaiKering = gudangKode === 'GKERING' ? nilaiStok : 0;
      const nilaiBasah = gudangKode === 'GBASAH' ? nilaiStok : 0;

      if (stokQty > 0) skuAktif += 1;
      summaryQtyKering += qtyKering;
      summaryQtyBasah += qtyBasah;
      summaryNilaiKering += nilaiKering;
      summaryNilaiBasah += nilaiBasah;

      return clean({
        ...p,
        gudangKode,
        gudangNama: warehouseLabel(gudangKode),
        hargaBeli,
        stokQty,
        nilaiStok,
        stokGudangKering: qtyKering,
        stokGudangBasah: qtyBasah,
        stokByWarehouse: { [gudangKode]: stokQty },
        stokTotal: stokQty,
        nilaiGudangKering: nilaiKering,
        nilaiGudangBasah: nilaiBasah,
        nilaiTotal: nilaiStok,
      });
    });

    const trend = await buildStockTrend(db, tid, { months: trendMonths, granularity: 'day' });

    return ok({
      warehouses: WAREHOUSE_CODES.map((k) => ({ kode: k, nama: warehouseLabel(k) })),
      summary: {
        qtyKering: summaryQtyKering,
        qtyBasah: summaryQtyBasah,
        qtyTotal: summaryQtyKering + summaryQtyBasah,
        nilaiKering: summaryNilaiKering,
        nilaiBasah: summaryNilaiBasah,
        nilaiTotal: summaryNilaiKering + summaryNilaiBasah,
        skuAktif,
        skuTotal: rows.length,
      },
      trend,
      rows,
    });
  }

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
