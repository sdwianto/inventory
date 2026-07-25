import type { AnyBulkWriteOperation, ClientSession, Db, Document } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
// Posting GRN — batch update stok, kartu stok, produk.

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { parseLokasiKode, ensureStokLokasiIndexes } from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import { assertProductWarehouse, resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { calcWeightedAvgHargaBeli, buildJualPricesAfterBeliChange } from '@/lib/api/inventory-cost';
import { productFilterById } from '@/lib/api/tenant-operational';
import { resolveLineQtyBase, unitCostPerBaseFromLine } from '@/lib/uom/resolve-line-qty';
import { formatStockDualLabel } from '@/lib/uom/display';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import type { GrnDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';
import {
  INGREDIENT_LOTS_COLLECTION,
  buildIngredientLotNo,
  defaultIngredientExpiryDate,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import { STOK_BIN_COLLECTION } from '@/lib/api/stok-bin';

function lokasiKey(stokId: string, kode: string) {
  return `${stokId}:${kode}`;
}

/**
 * @returns {{ itemsFull, receivedTotal, lokasiSet, kartuDocs, error? }}
 */
export async function applyGrnStockPosting(
  db: Db,
  tenantId: string,
  grn: GrnDoc,
  bodyItems: JsonObject[] = [],
  session?: ClientSession,
) {
  const tid = tenantId || 'default';
  const now = new Date();
  await ensureStokLokasiIndexes(db);

  const lineInputs: { it: JsonObject; qty: number; qtyBase: number; resolved: import('@/lib/uom/resolve-line-qty').ResolvedLineQty; lineIndex: number }[] = [];
  const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
  for (const [lineIndex, it] of ((grn.items || []) as JsonObject[]).entries()) {
    if (!it.localStokId) {
      return { error: `Kode ${it.vendorKode} belum terdaftar di Master Produk` };
    }
    const bodyLine = bodyItems?.find((b) => (
      (b.lineIndex != null && b.lineIndex === lineIndex)
      || (b.lineIndex == null && b.lineId === it.lineId)
    ));
    const qty = parseFloat(String(bodyLine?.qty ?? it.qtyOrdered ?? it.qtyReceived ?? 0)) || 0;
    if (qty <= 0) continue;
    const resolved = await resolveLineQtyBase(db, tid, String(it.localStokId), {
      qty,
      uomId: String(bodyLine?.uomId || it.uomId || ''),
      satuan: String(bodyLine?.satuan || it.satuan || ''),
    }, uomsCache);
    if ('error' in resolved) return { error: resolved.error };
    lineInputs.push({ it, qty: resolved.qty, qtyBase: resolved.qtyBase, resolved, lineIndex });
  }

  if (!lineInputs.length) return { error: 'Tidak ada qty diterima' };

  const stokIds = [...new Set(lineInputs.map((l) => l.it.localStokId))];
  const products = await db.collection('products')
    .find({ tenantId: tid, id: { $in: stokIds } })
    .toArray();
  const prodById = new Map(products.map((p) => [p.id, p]));

  const lokasiKeysPre = [...new Set(lineInputs.map((l) => {
    const prod = prodById.get(l.it.localStokId) as Record<string, unknown> | undefined;
    const kode = prod ? resolveProductGudangKode(prod) : '';
    return lokasiKey(String(l.it.localStokId), kode);
  }))].map((k) => {
    const [stokId, lokasiKode] = k.split(':');
    return { stokId, lokasiKode };
  });
  const existingLokasiPre = lokasiKeysPre.length
    ? await db.collection('stok_lokasi').find({
      tenantId: tid,
      $or: lokasiKeysPre.map(({ stokId, lokasiKode }) => ({ stokId, lokasiKode })),
    }).toArray()
    : [];
  const lokasiByKey = new Map(existingLokasiPre.map((r) => [lokasiKey(r.stokId, r.lokasiKode), r]));

  const lokasiDeltas = new Map<string, number>();
  const productState = new Map<string, {
    oldQty: number;
    oldBeli: number;
    newBeli: number;
    prod: Record<string, unknown>;
  }>();
  const itemsFull: JsonObject[] = [];
  const lokasiSet = new Set<string>();
  const kartuDocs: JsonObject[] = [];
  const lotDocs: IngredientLotDoc[] = [];
  const receivedDay = now.toISOString().slice(0, 10);
  /** W2-16: cache default bin per warehouse (null = none). */
  const defaultBinByWh = new Map<string, string | null>();
  /** W2-17: accumulate qtyBase per (stokId, warehouse, bin) when default bin resolved. */
  const binDeltas = new Map<string, number>();

  for (const { it, qty, qtyBase, resolved, lineIndex } of lineInputs) {
    const prod = prodById.get(it.localStokId) as Record<string, unknown> | undefined;
    if (!prod) return { error: `Produk lokal tidak ditemukan: ${it.vendorKode}` };

    const lokasiKode = resolveProductGudangKode(prod);
    if (!isValidWarehouseKode(lokasiKode)) {
      return { error: `Gudang tidak valid untuk ${it.vendorKode}.` };
    }
    const whErr = assertProductWarehouse(prod, lokasiKode);
    if (whErr) return { error: whErr.error };

    lokasiSet.add(lokasiKode);
    if (!defaultBinByWh.has(lokasiKode)) {
      defaultBinByWh.set(
        lokasiKode,
        await resolveDefaultBinKode(db, tid, lokasiKode),
      );
    }
    const binKode = defaultBinByWh.get(lokasiKode) || undefined;
    if (binKode) {
      const bk = `${String(it.localStokId)}:${lokasiKode}:${binKode}`;
      binDeltas.set(bk, (binDeltas.get(bk) || 0) + qtyBase);
    }
    const unitCost = parseInt(String(it.harga || it.hargaSatuan || 0), 10);
    const unitCostBase = unitCostPerBaseFromLine(resolved, unitCost * qty);
    const lk = lokasiKey(String(it.localStokId), lokasiKode);
    lokasiDeltas.set(lk, (lokasiDeltas.get(lk) || 0) + qtyBase);

    let state = productState.get(String(it.localStokId));
    const lkInit = lokasiKey(String(it.localStokId), lokasiKode);
    const rowInit = lokasiByKey.get(lkInit);
    const lokasiQty = parseFloat(String((rowInit as { qty?: unknown })?.qty)) || 0;
    if (!state) {
      state = {
        oldQty: lokasiQty,
        oldBeli: parseInt(String(prod.hargaBeli || 0), 10),
        newBeli: parseInt(String(prod.hargaBeli || 0), 10),
        prod,
      };
      productState.set(String(it.localStokId), state);
    }
    state.newBeli = calcWeightedAvgHargaBeli(state.oldQty, state.newBeli, qtyBase, unitCostBase);
    state.oldQty += qtyBase;

    const lokasiLabel = `${lokasiKode} - ${warehouseLabel(lokasiKode)}`;
    kartuDocs.push(stampTenantId(tid, {
      id: uuidv4(),
      stokId: it.localStokId,
      lokasi: lokasiLabel,
      lokasiKode,
      ...(binKode ? { binKode } : {}),
      tanggal: now,
      noTransaksi: grn.noGRN,
      keterangan: `GRN dari ${grn.noDO} (sales.app)`,
      sourceType: 'GRN',
      masuk: qtyBase,
      keluar: 0,
      qtyEntered: qty,
      uomId: resolved.uomId,
      satuan: resolved.satuan,
      hargaSatuan: unitCostBase,
    }));

    // W2-5: stamp ingredient lot (body override → line → default shelf).
    const bodyLine = bodyItems?.find((b) => (
      (b.lineIndex != null && b.lineIndex === lineIndex)
      || (b.lineIndex == null && b.lineId === it.lineId)
    ));
    const expiryRaw = String(bodyLine?.expiryDate || it.expiryDate || '').trim();
    const expiryDate = /^\d{4}-\d{2}-\d{2}/.test(expiryRaw)
      ? expiryRaw.slice(0, 10)
      : defaultIngredientExpiryDate(receivedDay);
    const lotNo = String(bodyLine?.lotNo || it.lotNo || '').trim()
      || buildIngredientLotNo({
        noGRN: grn.noGRN ? String(grn.noGRN) : undefined,
        productKode: String(prod.kode || it.vendorKode || ''),
        lineIndex,
        receivedAt: receivedDay,
      });

    const lot: IngredientLotDoc = {
      id: uuidv4(),
      tenantId: tid,
      lotNo,
      grnId: String(grn.id || ''),
      noGRN: grn.noGRN ? String(grn.noGRN) : undefined,
      productId: String(it.localStokId),
      productKode: String(prod.kode || it.vendorKode || ''),
      productNama: String(prod.nama || it.nama || ''),
      warehouseKode: lokasiKode,
      ...(binKode ? { binKode } : {}),
      receivedAt: receivedDay,
      expiryDate,
      qty: qtyBase,
      qtyRemaining: qtyBase,
      satuan: resolved.satuan,
      status: 'ACTIVE',
      lineIndex,
      createdAt: now,
      updatedAt: now,
    };
    lotDocs.push(lot);

    itemsFull.push({
      ...it,
      qtyReceived: qty,
      qtyReceivedBase: qtyBase,
      uomId: resolved.uomId,
      satuan: resolved.satuan,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      ...(binKode ? { binKode } : {}),
      hargaBeliBaru: state.newBeli,
      lotNo,
      lotId: lot.id,
      expiryDate,
    });
  }

  const lokasiKeys = [...lokasiDeltas.keys()].map((k) => {
    const [stokId, kode] = k.split(':');
    return { stokId, lokasiKode: kode };
  });

  const stokLokasiBulk: Record<string, unknown>[] = [];
  for (const [lk, delta] of lokasiDeltas) {
    const [stokId, kode] = lk.split(':');
    const row = lokasiByKey.get(lk);
    const current = parseFloat(String((row as { qty?: unknown })?.qty)) || 0;
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
    await db.collection('stok_lokasi').bulkWrite(
      stokLokasiBulk as AnyBulkWriteOperation<Document>[],
      { ordered: false, ...txOpts(session) },
    );
  }

  // W2-17: parallel bin ledger when default bin resolved (same session as stok_lokasi).
  const stokBinBulk: Record<string, unknown>[] = [];
  for (const [bk, delta] of binDeltas) {
    if (!delta) continue;
    const parts = bk.split(':');
    const stokId = parts[0];
    const warehouseKode = parts[1];
    const binKodePart = parts.slice(2).join(':');
    if (!stokId || !warehouseKode || !binKodePart) continue;
    stokBinBulk.push({
      updateOne: {
        filter: { tenantId: tid, stokId, warehouseKode, binKode: binKodePart },
        update: {
          $inc: { qty: delta },
          $set: { updatedAt: now },
          $setOnInsert: {
            id: uuidv4(),
            tenantId: tid,
            stokId,
            warehouseKode,
            binKode: binKodePart,
            createdAt: now,
          },
        },
        upsert: true,
      },
    });
  }
  if (stokBinBulk.length) {
    await db.collection(STOK_BIN_COLLECTION).bulkWrite(
      stokBinBulk as AnyBulkWriteOperation<Document>[],
      { ordered: false, ...txOpts(session) },
    );
  }

  const allLokasiRows = await db.collection('stok_lokasi')
    .find({ tenantId: tid, stokId: { $in: stokIds } })
    .project({ stokId: 1, qty: 1 })
    .toArray();
  const stokTotalById = new Map<string, number>();
  for (const r of allLokasiRows) {
    const sid = String(r.stokId);
    stokTotalById.set(sid, (stokTotalById.get(sid) || 0) + (parseFloat(String(r.qty)) || 0));
  }

  const uomsByProduct = await listProductUomsByProductIds(db, tid, [...productState.keys()]);

  const productBulk: Record<string, unknown>[] = [];
  for (const [stokId, state] of productState) {
    const newStok = stokTotalById.get(stokId) ?? state.oldQty;
    const pricePatch = buildJualPricesAfterBeliChange(
      parseInt(String(state.prod.hargaBeli || 0), 10),
      state.newBeli,
      state.prod,
    );
    const uoms = uomsByProduct.get(stokId) || [];
    const uomCount = uoms.length || Number(state.prod.uomCount) || 1;
    const stokDisplay = uomCount <= 1
      ? `${Number.isInteger(newStok) ? newStok : Math.round(newStok * 1000) / 1000} ${String(state.prod.satuan || 'PCS')}`
      : formatStockDualLabel(newStok, uoms);
    productBulk.push({
      updateOne: {
        filter: productFilterById(tid, stokId),
        update: {
          $set: {
            hargaBeli: state.newBeli,
            stok: newStok,
            stokDisplay,
            uomCount: uoms.length || uomCount,
            ...pricePatch,
            updatedAt: now,
          },
        },
      },
    });
  }
  if (productBulk.length) {
    await db.collection('products').bulkWrite(
      productBulk as AnyBulkWriteOperation<Document>[],
      { ordered: false, ...txOpts(session) },
    );
  }

  if (kartuDocs.length) {
    await db.collection('stok_kartu').insertMany(kartuDocs, txOpts(session));
  }

  // Idempotent lot stamp: skip insert if lots already exist for this GRN (replay-safe).
  if (lotDocs.length && grn.id) {
    const existingLots = await db.collection(INGREDIENT_LOTS_COLLECTION).countDocuments(
      { tenantId: tid, grnId: String(grn.id) },
      txOpts(session),
    );
    if (existingLots === 0) {
      await db.collection(INGREDIENT_LOTS_COLLECTION).insertMany(lotDocs, txOpts(session));
    }
  }

  const receivedTotal = itemsFull.reduce((s, it) => {
    const qty = parseFloat(String(it.qtyReceived)) || 0;
    const harga = parseInt(String(it.harga || it.hargaSatuan || 0), 10);
    return s + Math.round(qty * harga);
  }, 0);

  return { itemsFull, receivedTotal, lokasiSet, kartuDocs, lotDocs };
}
