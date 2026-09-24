// Posting GRN — mutasi stok + lot bahan lewat buku stok, harga rata-rata produk.

import type { AnyBulkWriteOperation, ClientSession, Db, Document } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';

import { v4 as uuidv4 } from 'uuid';
import { ensureStokLokasiIndexes } from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import { assertProductWarehouse, resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { calcWeightedAvgHargaBeli, buildJualPricesAfterBeliChange } from '@/lib/api/inventory-cost';
import { productFilterById } from '@/lib/api/tenant-operational';
import { resolveLineQtyBase, unitCostPerBaseFromLine } from '@/lib/uom/resolve-line-qty';
import { listProductUomsByProductIds, persistStokDisplay } from '@/lib/api/product-uom';
import type { GrnDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';
import {
  INGREDIENT_LOTS_COLLECTION,
  buildIngredientLotNo,
  defaultIngredientExpiryDate,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import { postStockMovements, roundStockQty, type StockActor, type StockMovementLine } from '@/lib/stock-ledger';
import { qtyGt } from '@/lib/stock-ledger/precision';

function lokasiKey(stokId: string, kode: string) {
  return `${stokId}:${kode}`;
}

/**
 * @returns {{ itemsFull, receivedTotal, lokasiSet, lotDocs, error? }}
 */
export async function applyGrnStockPosting(
  db: Db,
  tenantId: string,
  grn: GrnDoc,
  bodyItems: JsonObject[] = [],
  session?: ClientSession,
  actor?: StockActor | null,
) {
  const tid = tenantId || 'default';
  const now = new Date();
  await ensureStokLokasiIndexes(db);

  const lineInputs: {
    it: JsonObject; qty: number; qtyBase: number;
    resolved: import('@/lib/uom/resolve-line-qty').ResolvedLineQty; lineIndex: number;
    qtyRejected: number; rejectReason?: string;
  }[] = [];
  /** Baris yang ditolak penuh (qty diterima 0) — dicatat tanpa diproses stok/lot/kartu. */
  const rejectedOnlyLines: { it: JsonObject; qtyRejected: number; rejectReason?: string }[] = [];
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
    const qtyRejected = parseFloat(String(bodyLine?.qtyRejected ?? 0)) || 0;
    const rejectReason = bodyLine?.rejectReason ? String(bodyLine.rejectReason) : undefined;
    const uomCtx = {
      uomId: String(bodyLine?.uomId || it.uomId || ''),
      satuan: String(bodyLine?.satuan || it.satuan || ''),
    };

    // Qty diterima + qty ditolak tidak boleh melebihi qty kirim — kalau tidak, barang yang
    // sama bisa tercatat MASUK stok sekaligus DITOLAK (lihat GRN2608000010/Kelengkeng).
    let qtyRejectedBase = 0;
    if (qtyRejected > 0) {
      const rejectedResolved = await resolveLineQtyBase(db, tid, String(it.localStokId), { qty: qtyRejected, ...uomCtx }, uomsCache);
      if ('error' in rejectedResolved) return { error: rejectedResolved.error };
      qtyRejectedBase = rejectedResolved.qtyBase;
    }
    const orderedBase = parseFloat(String(it.qtyBase ?? it.qtyOrdered ?? 0)) || 0;
    const itemLabel = String(it.vendorKode || it.localNama || it.vendorNama || it.localKode || '');

    if (qty <= 0) {
      if (qtyRejected > 0) {
        if (orderedBase > 0 && qtyGt(qtyRejectedBase, orderedBase)) {
          return { error: `Qty ditolak melebihi qty kirim untuk ${itemLabel}` };
        }
        rejectedOnlyLines.push({ it, qtyRejected, rejectReason });
      }
      continue;
    }
    const resolved = await resolveLineQtyBase(db, tid, String(it.localStokId), { qty, ...uomCtx }, uomsCache);
    if ('error' in resolved) return { error: resolved.error };
    if (orderedBase > 0 && qtyGt(resolved.qtyBase + qtyRejectedBase, orderedBase)) {
      return { error: `Qty diterima + ditolak (melebihi qty kirim) untuk ${itemLabel}` };
    }
    lineInputs.push({ it, qty: resolved.qty, qtyBase: roundStockQty(resolved.qtyBase), resolved, lineIndex, qtyRejected, rejectReason });
  }

  if (!lineInputs.length && !rejectedOnlyLines.length) return { error: 'Tidak ada qty diterima' };

  const stokIds = [...new Set(lineInputs.map((l) => l.it.localStokId))];
  const products = await db.collection('products')
    .find({ tenantId: tid, id: { $in: stokIds } }, txOpts(session))
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
    }, txOpts(session)).toArray()
    : [];
  const lokasiByKey = new Map(existingLokasiPre.map((r) => [lokasiKey(r.stokId, r.lokasiKode), r]));

  // Idempotent lot stamp: lot tidak dibuat ulang bila GRN ini sudah punya lot (replay-safe).
  const grnHasLots = grn.id
    ? (await db.collection(INGREDIENT_LOTS_COLLECTION).countDocuments(
      { tenantId: tid, grnId: String(grn.id) },
      { limit: 1, ...txOpts(session) },
    )) > 0
    : true;

  const productState = new Map<string, {
    oldQty: number;
    oldBeli: number;
    newBeli: number;
    prod: Record<string, unknown>;
  }>();
  const itemsFull: JsonObject[] = [];
  const lokasiSet = new Set<string>();
  const movementLines: StockMovementLine[] = [];
  const lotDocs: IngredientLotDoc[] = [];
  const receivedDay = now.toISOString().slice(0, 10);
  /** W2-16: cache default bin per warehouse (null = none). */
  const defaultBinByWh = new Map<string, string | null>();

  for (const { it, qty, qtyBase, resolved, lineIndex, qtyRejected, rejectReason } of lineInputs) {
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
    const unitCost = parseInt(String(it.harga || it.hargaSatuan || 0), 10);
    const unitCostBase = unitCostPerBaseFromLine(resolved, unitCost * qty);

    let state = productState.get(String(it.localStokId));
    const lkInit = lokasiKey(String(it.localStokId), lokasiKode);
    const rowInit = lokasiByKey.get(lkInit);
    const lokasiQty = roundStockQty((rowInit as { qty?: number | string } | undefined)?.qty);
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
    state.oldQty = roundStockQty(state.oldQty + qtyBase);


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
      // ADR-004 Fase 6 — supplier identity dari GRN (bukan nama otoritatif).
      supplierId: String(
        (grn as { supplierId?: unknown }).supplierId
        || grn.vendorTenantId
        || '',
      ).trim() || undefined,
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

    movementLines.push({
      lineRef: String(lineIndex),
      productId: String(it.localStokId),
      warehouseKode: lokasiKode,
      deltaQtyBase: qtyBase,
      unitCost: unitCostBase,
      qtyEntered: qty,
      uomId: resolved.uomId,
      satuan: resolved.satuan,
      lotPolicy: grnHasLots ? { mode: 'NONE' } : { mode: 'CREATE', lot },
    });

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
      qtyRejected,
      ...(rejectReason ? { rejectReason } : {}),
      ...(qtyRejected > 0 ? { rejectStatus: 'PENDING' } : {}),
    });
  }

  let stokTotalById = new Map<string, number>();
  if (movementLines.length) {
    const posted = await postStockMovements(db, session, {
      tenantId: tid,
      sourceType: 'GRN',
      sourceId: String(grn.id || ''),
      noTransaksi: String(grn.noGRN || grn.id || ''),
      keterangan: `GRN dari ${grn.noDO} (sales.app)`,
      postingDate: now,
      actor,
      lines: movementLines,
    });
    if (!posted.ok) return { error: posted.error };
    stokTotalById = new Map(Object.entries(posted.productStok));
  }

  const uomsByProduct = await listProductUomsByProductIds(db, tid, [...productState.keys()]);

  // stok & stokDisplay sudah dihitung ulang buku stok di sesi ini — di sini hanya harga & jumlah UOM.
  const productBulk: Record<string, unknown>[] = [];
  for (const [stokId, state] of productState) {
    const pricePatch = buildJualPricesAfterBeliChange(
      parseInt(String(state.prod.hargaBeli || 0), 10),
      state.newBeli,
      state.prod,
    );
    const uoms = uomsByProduct.get(stokId) || [];
    const uomCount = uoms.length || Number(state.prod.uomCount) || 1;
    productBulk.push({
      updateOne: {
        filter: productFilterById(tid, stokId),
        update: {
          $set: {
            hargaBeli: state.newBeli,
            uomCount,
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
    for (const stokId of productState.keys()) {
      await persistStokDisplay(db, tid, stokId, stokTotalById.get(stokId), session);
    }
  }

  for (const { it, qtyRejected, rejectReason } of rejectedOnlyLines) {
    itemsFull.push({
      ...it,
      qtyReceived: 0,
      qtyReceivedBase: 0,
      qtyRejected,
      ...(rejectReason ? { rejectReason } : {}),
      ...(qtyRejected > 0 ? { rejectStatus: 'PENDING' } : {}),
    });
  }

  const receivedTotal = itemsFull.reduce((s, it) => {
    const qty = parseFloat(String(it.qtyReceived)) || 0;
    const harga = parseInt(String(it.harga || it.hargaSatuan || 0), 10);
    return s + Math.round(qty * harga);
  }, 0);

  return { itemsFull, receivedTotal, lokasiSet, lotDocs };
}
