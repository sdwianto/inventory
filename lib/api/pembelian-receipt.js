// Eksekusi penerimaan barang (GRN) — dipakai pembelian langsung & receive PO.

import { v4 as uuidv4 } from 'uuid';
import { err, clean } from '@/lib/api/db';
import { createJournal } from '@/lib/api/journal';
import {
  effectiveUnitCost,
  calcWeightedAvgHargaBeli,
  buildJualPricesAfterBeliChange,
  toQty,
  toHarga,
} from '@/lib/api/inventory-cost';
import { tenantIdForWrite, findMasterDoc, authForMasterActing } from '@/lib/api/tenant-master';
import { stampTenantId, updateProductStockScoped } from '@/lib/api/tenant-operational';
import { assertSupplierCredit } from '@/lib/api/credit-limit';
import {
  parseLokasiKode,
  adjustStokLokasi,
  syncProductStokFromLokasi,
  ensureStokLokasiRow,
  getProductInventorySnapshot,
} from '@/lib/api/stok-lokasi';
import { resolveLokasiLabelForWrite } from '@/lib/api/lokasi-label';

export async function executePembelianReceipt(db, auth, body) {
  const items = body?.items || [];
  if (items.length === 0) return { error: err('Tidak ada item') };
  if (!body.supplierId) return { error: err('Supplier wajib') };
  if (!body.lokasi || !String(body.lokasi).trim()) {
    return { error: err('Pilih gudang/lokasi penempatan barang', 400) };
  }
  const tenantId = tenantIdForWrite(auth, body);
  if (auth?.isMaster && !body?.tenantId) return { error: err('Pilih tenant terlebih dahulu', 400) };
  const scopeAuth = authForMasterActing(auth, tenantId);
  const supplier = await findMasterDoc(db, 'supplier', scopeAuth, { id: body.supplierId });
  if (!supplier) return { error: err('Supplier tidak ditemukan', 404) };

  const now = new Date();
  const noPembelian = body.noPembelian || `PB${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;

  let subTotal = 0;
  const itemsFull = [];
  const stockState = new Map();

  for (const it of items) {
    const prod = await findMasterDoc(db, 'products', scopeAuth, { id: it.stokId });
    if (!prod) return { error: err(`Produk ${it.kode || it.stokId} tidak ditemukan`, 404) };
    const qty = toQty(it.qty);
    const harga = toHarga(it.harga);
    const diskon = toHarga(it.diskon);
    const jumlah = harga * qty - diskon;
    subTotal += jumlah;
    itemsFull.push({
      stokId: prod.id, kode: prod.kode, nama: prod.nama, satuan: prod.satuan,
      qty, harga, diskon, jumlah,
      lineId: it.lineId,
    });
    if (!stockState.has(prod.id)) {
      const snap = await getProductInventorySnapshot(db, tenantId, prod.id);
      stockState.set(prod.id, {
        stok: toQty(snap?.stok ?? prod.stok),
        hargaBeli: toHarga(snap?.hargaBeli ?? prod.hargaBeli),
        prod: snap?.prod || prod,
      });
    }
  }
  const penyesuaian = parseInt(body.penyesuaian || 0, 10);
  const ppn = parseInt(body.ppn || 0, 10);
  const total = subTotal + penyesuaian + ppn;
  const tunai = body.tunai !== false;
  const isHutang = !tunai;
  if (isHutang) {
    const credit = await assertSupplierCredit(db, scopeAuth, body.supplierId, total);
    if (!credit.ok) return { error: err(credit.error, 400) };
  }

  const lokasiLabel = await resolveLokasiLabelForWrite(db, tenantId, body.lokasi);
  const doc = {
    id: uuidv4(), noPembelian, tanggal: now, tenantId,
    supplierId: body.supplierId, supplierName: supplier.nama,
    lokasi: lokasiLabel,
    catatan: body.catatan || '',
    items: itemsFull, subTotal, penyesuaian, ppn, total,
    tunai, status: 'RECEIVED',
    purchaseOrderId: body.purchaseOrderId || null,
    noPO: body.noPO || null,
    jatuhTempo: isHutang ? new Date(body.jatuhTempo || Date.now() + (supplier.TOP || 30) * 86400000) : null,
    userName: body.userName || '', createdAt: now,
  };
  await db.collection('pembelian').insertOne(doc);

  const lokasiKode = parseLokasiKode(body.lokasi);

  for (const it of itemsFull) {
    const state = stockState.get(it.stokId) || { stok: 0, hargaBeli: 0, prod: null };
    const stokSebelum = state.stok;
    const hargaBeliSebelum = state.hargaBeli;
    const prodSnap = state.prod;

    const unitCost = effectiveUnitCost(it.qty, it.harga, it.diskon);
    const hargaBeliBaru = calcWeightedAvgHargaBeli(stokSebelum, hargaBeliSebelum, it.qty, unitCost);

    await ensureStokLokasiRow(db, tenantId, it.stokId, lokasiKode);
    const adj = await adjustStokLokasi(db, tenantId, it.stokId, lokasiKode, it.qty);
    if (adj.error) return { error: err(adj.error, 400) };

    const productSet = { hargaBeli: hargaBeliBaru, updatedAt: now };
    if (hargaBeliBaru !== hargaBeliSebelum && prodSnap) {
      Object.assign(productSet, buildJualPricesAfterBeliChange(hargaBeliSebelum, hargaBeliBaru, prodSnap));
    }
    await updateProductStockScoped(db, tenantId, it.stokId, { $set: productSet });
    const stokSesudah = await syncProductStokFromLokasi(db, tenantId, it.stokId);

    it.stokSebelum = stokSebelum;
    it.stokSesudah = stokSesudah;
    it.hargaBeliSebelum = hargaBeliSebelum;
    it.hargaBeliBaru = hargaBeliBaru;
    it.hargaSatuanMasuk = unitCost;
    if (productSet.hargaEcer != null) it.hargaEcerBaru = productSet.hargaEcer;
    if (productSet.hargaGrosir != null) it.hargaGrosirBaru = productSet.hargaGrosir;
    if (productSet.hargaSpesial != null) it.hargaSpesialBaru = productSet.hargaSpesial;

    state.stok = stokSesudah;
    state.hargaBeli = hargaBeliBaru;
    if (prodSnap) {
      state.prod = { ...prodSnap, hargaBeli: hargaBeliBaru, stok: stokSesudah, ...productSet };
    }
    stockState.set(it.stokId, state);

    await db.collection('stok_kartu').insertOne(stampTenantId(tenantId, {
      id: uuidv4(),
      stokId: it.stokId,
      lokasi: lokasiLabel,
      tanggal: now,
      noTransaksi: noPembelian,
      keterangan: body.purchaseOrderId ? `GRN PO ${body.noPO || ''} dari ${supplier.nama}` : `Pembelian dari ${supplier.nama}`,
      sourceType: 'PEMBELIAN',
      masuk: it.qty,
      keluar: 0,
      hargaSatuan: unitCost,
    }));
  }

  doc.items = itemsFull;
  await db.collection('pembelian').updateOne(
    { id: doc.id, tenantId },
    { $set: { items: itemsFull, updatedAt: now } },
  );

  if (isHutang) {
    await db.collection('hutang').insertOne(stampTenantId(tenantId, {
      id: uuidv4(),
      noHutang: `HT${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`,
      noPembelian, tanggal: now,
      supplierId: body.supplierId, referenceType: 'PEMBELIAN', referenceId: doc.id,
      total, terbayar: 0, sisa: total,
      jatuhTempo: doc.jatuhTempo,
      status: 'OUTSTANDING', createdAt: now,
    }));
  }

  const jurnalDetails = [
    { rekeningKode: '10310', rekeningNama: 'Persediaan Barang Dagangan', debet: total, kredit: 0, keterangan: `Pembelian ${noPembelian}` },
    {
      rekeningKode: tunai ? '10010' : '20010',
      rekeningNama: tunai ? 'Kas' : 'Hutang Usaha',
      debet: 0, kredit: total,
      keterangan: tunai ? 'Tunai' : `Hutang ke ${supplier.nama}`,
    },
  ];
  await createJournal(db, {
    tanggal: now, keterangan: `Pembelian ${noPembelian} dari ${supplier.nama}`,
    sourceType: 'AUTO_BELI', sourceId: doc.id, details: jurnalDetails, userName: body.userName,
    tenantId,
  });

  return { doc: clean(doc) };
}
