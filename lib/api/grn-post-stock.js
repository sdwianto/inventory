// Posting GRN — batch update stok, kartu stok, produk.

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { parseLokasiKode, ensureStokLokasiIndexes } from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import { assertProductWarehouse, resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { calcWeightedAvgHargaBeli, buildJualPricesAfterBeliChange } from '@/lib/api/inventory-cost';
import { productFilterById } from '@/lib/api/tenant-operational';

function lokasiKey(stokId, kode) {
  return `${stokId}:${kode}`;
}

/**
 * @returns {{ itemsFull, receivedTotal, lokasiSet, kartuDocs, error? }}
 */
export async function applyGrnStockPosting(db, tenantId, grn, bodyItems = []) {
  const tid = tenantId || 'default';
  const now = new Date();
  await ensureStokLokasiIndexes(db);

  const lineInputs = [];
  for (const [lineIndex, it] of (grn.items || []).entries()) {
    if (!it.localStokId) {
      return { error: `Kode ${it.vendorKode} belum terdaftar di Master Produk` };
    }
    const bodyLine = bodyItems?.find((b) => (
      (b.lineIndex != null && b.lineIndex === lineIndex)
      || (b.lineIndex == null && b.lineId === it.lineId)
    ));
    const qty = parseFloat(bodyLine?.qty ?? it.qtyOrdered) || 0;
    if (qty <= 0) continue;
    lineInputs.push({ it, qty, lineIndex });
  }

  if (!lineInputs.length) return { error: 'Tidak ada qty diterima' };

  const stokIds = [...new Set(lineInputs.map((l) => l.it.localStokId))];
  const products = await db.collection('products')
    .find({ tenantId: tid, id: { $in: stokIds } })
    .toArray();
  const prodById = new Map(products.map((p) => [p.id, p]));

  const lokasiDeltas = new Map();
  const productState = new Map();
  const itemsFull = [];
  const lokasiSet = new Set();
  const kartuDocs = [];

  for (const { it, qty } of lineInputs) {
    const prod = prodById.get(it.localStokId);
    if (!prod) return { error: `Produk lokal tidak ditemukan: ${it.vendorKode}` };

    const lokasiKode = resolveProductGudangKode(prod);
    if (!isValidWarehouseKode(lokasiKode)) {
      return { error: `Gudang tidak valid untuk ${it.vendorKode}.` };
    }
    const whErr = assertProductWarehouse(prod, lokasiKode);
    if (whErr) return { error: whErr.error };

    lokasiSet.add(lokasiKode);
    const unitCost = parseInt(it.harga || it.hargaSatuan || 0, 10);
    const lk = lokasiKey(it.localStokId, lokasiKode);
    lokasiDeltas.set(lk, (lokasiDeltas.get(lk) || 0) + qty);

    let state = productState.get(it.localStokId);
    if (!state) {
      state = {
        oldQty: parseFloat(prod.stok) || 0,
        oldBeli: parseInt(prod.hargaBeli || 0, 10),
        newBeli: parseInt(prod.hargaBeli || 0, 10),
        prod,
      };
      productState.set(it.localStokId, state);
    }
    state.newBeli = calcWeightedAvgHargaBeli(state.oldQty, state.newBeli, qty, unitCost);
    state.oldQty += qty;

    const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
    kartuDocs.push(stampTenantId(tid, {
      id: uuidv4(),
      stokId: it.localStokId,
      lokasi: lokasiLabel,
      lokasiKode,
      tanggal: now,
      noTransaksi: grn.noGRN,
      keterangan: `GRN dari ${grn.noDO} (sales.app)`,
      sourceType: 'GRN',
      masuk: qty,
      keluar: 0,
      hargaSatuan: unitCost,
    }));

    itemsFull.push({
      ...it,
      qtyReceived: qty,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      hargaBeliBaru: state.newBeli,
    });
  }

  const lokasiKeys = [...lokasiDeltas.keys()].map((k) => {
    const [stokId, kode] = k.split(':');
    return { stokId, lokasiKode: kode };
  });

  const existingLokasi = lokasiKeys.length
    ? await db.collection('stok_lokasi').find({
      tenantId: tid,
      $or: lokasiKeys.map(({ stokId, lokasiKode }) => ({ stokId, lokasiKode })),
    }).toArray()
    : [];
  const lokasiByKey = new Map(existingLokasi.map((r) => [lokasiKey(r.stokId, r.lokasiKode), r]));

  const stokLokasiBulk = [];
  for (const [lk, delta] of lokasiDeltas) {
    const [stokId, kode] = lk.split(':');
    const row = lokasiByKey.get(lk);
    const current = parseFloat(row?.qty) || 0;
    const next = current + delta;
    if (next < 0) {
      return { error: `Stok di lokasi ${kode} tidak cukup (sisa: ${current})` };
    }
    if (row) {
      stokLokasiBulk.push({
        updateOne: {
          filter: { tenantId: tid, stokId, lokasiKode: kode },
          update: { $set: { qty: next, updatedAt: now } },
        },
      });
    } else {
      stokLokasiBulk.push({
        updateOne: {
          filter: { tenantId: tid, stokId, lokasiKode: kode },
          update: {
            $set: { qty: next, updatedAt: now },
            $setOnInsert: { id: uuidv4(), tenantId: tid, stokId, lokasiKode: kode },
          },
          upsert: true,
        },
      });
    }
  }

  if (stokLokasiBulk.length) {
    await db.collection('stok_lokasi').bulkWrite(stokLokasiBulk, { ordered: false });
  }

  const allLokasiRows = await db.collection('stok_lokasi')
    .find({ tenantId: tid, stokId: { $in: stokIds } })
    .project({ stokId: 1, qty: 1 })
    .toArray();
  const stokTotalById = new Map();
  for (const r of allLokasiRows) {
    stokTotalById.set(r.stokId, (stokTotalById.get(r.stokId) || 0) + (parseFloat(r.qty) || 0));
  }

  const productBulk = [];
  for (const [stokId, state] of productState) {
    const newStok = stokTotalById.get(stokId) ?? state.oldQty;
    const pricePatch = buildJualPricesAfterBeliChange(
      parseInt(state.prod.hargaBeli || 0, 10),
      state.newBeli,
      state.prod,
    );
    productBulk.push({
      updateOne: {
        filter: productFilterById(tid, stokId),
        update: {
          $set: {
            hargaBeli: state.newBeli,
            stok: newStok,
            ...pricePatch,
            updatedAt: now,
          },
        },
      },
    });
  }
  if (productBulk.length) {
    await db.collection('products').bulkWrite(productBulk, { ordered: false });
  }

  if (kartuDocs.length) {
    await db.collection('stok_kartu').insertMany(kartuDocs);
  }

  const receivedTotal = itemsFull.reduce((s, it) => {
    const qty = parseFloat(it.qtyReceived) || 0;
    const harga = parseInt(it.harga || it.hargaSatuan || 0, 10);
    return s + Math.round(qty * harga);
  }, 0);

  return { itemsFull, receivedTotal, lokasiSet, kartuDocs };
}
