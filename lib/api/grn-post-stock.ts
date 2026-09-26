// Posting GRN — mutasi stok + lot bahan lewat buku stok, harga rata-rata produk.

import type { AnyBulkWriteOperation, ClientSession, Db, Document } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';

import { v4 as uuidv4 } from 'uuid';
import { ensureStokLokasiIndexes } from '@/lib/api/stok-lokasi';
import { isValidWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import { assertProductWarehouse, resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { calcWeightedAvgHargaBeli, buildJualPricesAfterBeliChange } from '@/lib/api/inventory-cost';
import { productFilterById } from '@/lib/api/tenant-operational';
import { resolveLineQtyBase, unitCostPerBaseFromLine } from '@/lib/uom/resolve-line-qty';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import type { GrnDoc } from '@/types/documents';
import type { JsonObject } from '@/types/json';
import {
  INGREDIENT_LOTS_COLLECTION,
  buildIngredientLotNo,
  resolveLotExpiry,
  businessDateIso,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { resolveDefaultBinKode } from '@/lib/api/warehouse-bins';
import { postStockMovements, roundStockQty, type StockActor, type StockMovementLine } from '@/lib/stock-ledger';
import { reserveGrnLotsForPlan } from '@/lib/stock-ledger/plan-reservation';
import {
  assertGrnWithinPo,
  getPoOverReceiveTolerancePct,
  poLineRemaining,
  type PoOverReceiveLine,
} from '@/lib/api/po-receive-control';
import { findMatchingGrnLine } from '@/lib/uom/match-vendor-line';
import { syncCpoOnGrnPosted } from '@/lib/api/cpo-status-sync';
import { qtyGt } from '@/lib/stock-ledger/precision';
import { loadStockUomMapper, resolveStockProducts } from '@/lib/api/product-merge';

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
  control?: { overReceiveReason?: string | null },
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

  // Baris GRN menunjuk salinan katalog vendor; stok/lot/harga rata-rata milik item persediaan kanonik.
  const targetRes = await resolveStockProducts(db, tid, lineInputs.map((l) => String(l.it.localStokId)), session);
  if ('error' in targetRes) return { error: targetRes.error };
  const stockIdOf = (it: JsonObject) => {
    const src = String(it.localStokId);
    return targetRes.targets.get(src)?.productId || src;
  };
  const stokIds = [...new Set(lineInputs.map((l) => stockIdOf(l.it)))];
  const products = await db.collection('products')
    .find({ tenantId: tid, id: { $in: stokIds } }, txOpts(session))
    .toArray();
  const prodById = new Map(products.map((p) => [p.id, p]));
  const stockUomOf = await loadStockUomMapper(db, tid, targetRes.targets);

  const lokasiKeysPre = [...new Set(lineInputs.map((l) => {
    const prod = prodById.get(stockIdOf(l.it)) as Record<string, unknown> | undefined;
    const kode = prod ? resolveProductGudangKode(prod) : '';
    return lokasiKey(stockIdOf(l.it), kode);
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
  const receivedDay = businessDateIso(now);
  const lotExpiryRequired = await isTenantFeatureEnabled(db, tid, 'lotExpiryRequired');
  const lotQcRequired = await isTenantFeatureEnabled(db, tid, 'lotQcRequired');
  const lineErrors: string[] = [];
  /** W2-16: cache default bin per warehouse (null = none). */
  const defaultBinByWh = new Map<string, string | null>();

  for (const { it, qty, qtyBase, resolved, lineIndex, qtyRejected, rejectReason } of lineInputs) {
    const stockId = stockIdOf(it);
    const prod = prodById.get(stockId) as Record<string, unknown> | undefined;
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

    let state = productState.get(stockId);
    const lkInit = lokasiKey(stockId, lokasiKode);
    const rowInit = lokasiByKey.get(lkInit);
    const lokasiQty = roundStockQty((rowInit as { qty?: number | string } | undefined)?.qty);
    if (!state) {
      state = {
        oldQty: lokasiQty,
        oldBeli: parseInt(String(prod.hargaBeli || 0), 10),
        newBeli: parseInt(String(prod.hargaBeli || 0), 10),
        prod,
      };
      productState.set(stockId, state);
    }
    state.newBeli = calcWeightedAvgHargaBeli(state.oldQty, state.newBeli, qtyBase, unitCostBase);
    state.oldQty = roundStockQty(state.oldQty + qtyBase);


    const bodyLine = bodyItems?.find((b) => (
      (b.lineIndex != null && b.lineIndex === lineIndex)
      || (b.lineIndex == null && b.lineId === it.lineId)
    ));
    const label = String(prod.nama || it.localNama || it.vendorNama || it.vendorKode || '');
    const expiry = resolveLotExpiry({
      receivedAt: receivedDay,
      inputExpiry: bodyLine?.expiryDate ?? it.expiryDate,
      shelfLifeDays: prod.shelfLifeDays,
      required: lotExpiryRequired,
      label,
    });
    if ('error' in expiry) {
      lineErrors.push(expiry.error);
      continue;
    }
    const { expiryDate, expirySource } = expiry;
    const supplierLotNo = String(bodyLine?.supplierLotNo ?? it.supplierLotNo ?? '').trim().slice(0, 64);
    if (lotExpiryRequired && prod.requiresLotNo === true && !supplierLotNo) {
      lineErrors.push(`No. lot pemasok wajib untuk ${label}`);
      continue;
    }
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
      productId: stockId,
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
      expirySource,
      ...(supplierLotNo ? { supplierLotNo } : {}),
      qty: qtyBase,
      qtyRemaining: qtyBase,
      satuan: resolved.satuan,
      status: 'ACTIVE',
      ...(lotQcRequired ? { qcStatus: 'QUARANTINE' as const } : {}),
      ...(actor?.userId ? { receivedByUserId: String(actor.userId) } : {}),
      lineIndex,
      createdAt: now,
      updatedAt: now,
    };
    lotDocs.push(lot);

    movementLines.push({
      lineRef: String(lineIndex),
      productId: stockId,
      warehouseKode: lokasiKode,
      deltaQtyBase: qtyBase,
      unitCost: unitCostBase,
      qtyEntered: qty,
      uomId: stockUomOf(String(it.localStokId), resolved.uomId),
      satuan: resolved.satuan,
      lotPolicy: grnHasLots ? { mode: 'NONE' } : { mode: 'CREATE', lot },
    });

    itemsFull.push({
      ...it,
      ...(stockId !== String(it.localStokId) ? { stockProductId: stockId } : {}),
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
      expirySource,
      ...(supplierLotNo ? { supplierLotNo } : {}),
      qtyRejected,
      ...(rejectReason ? { rejectReason } : {}),
      ...(qtyRejected > 0 ? { rejectStatus: 'PENDING' } : {}),
    });
  }
  if (lineErrors.length) return { error: lineErrors.join('; ') };

  const noPO = String(grn.noPO || '').trim();
  const overReceiveLines: PoOverReceiveLine[] = [];
  let overReceiveTolerancePct = 0;
  if (noPO) {
    const po = await db.collection('customer_purchase_orders').findOne(
      { ...tenantIdMatchFilter(tid), noPO },
      { projection: { items: 1, status: 1 }, ...txOpts(session) },
    );
    if (!po) {
      return { error: `PO ${noPO} tidak ditemukan di tenant ini — periksa nomor PO pada DO/GRN sebelum menerima barang.` };
    }
    if (String(po.status || '').toUpperCase() === 'CANCELLED') {
      return { error: `PO ${noPO} sudah dibatalkan — barang tidak bisa diterima. Tolak kiriman atau minta vendor membatalkan DO.` };
    }
    const rawPoItems = Array.isArray(po?.items) ? po.items as JsonObject[] : [];
    const poItems: JsonObject[] = [];
    for (const line of rawPoItems) {
      const remaining = poLineRemaining(line);
      let qtyRemainingBase: number | null = null;
      const productId = String(line.localStokId || '').trim();
      if (productId && remaining > 0) {
        const base = await resolveLineQtyBase(db, tid, productId, {
          qty: remaining,
          uomId: line.uomId ? String(line.uomId) : undefined,
          satuan: line.satuan ? String(line.satuan) : undefined,
        }, uomsCache);
        qtyRemainingBase = 'error' in base ? null : base.qtyBase;
      } else if (remaining === 0) {
        qtyRemainingBase = 0;
      }
      poItems.push({ ...line, qtyRemainingBase });
    }
    const tolerancePct = await getPoOverReceiveTolerancePct(db, tid, session);
    overReceiveTolerancePct = tolerancePct;
    const overErr = await assertGrnWithinPo(db, session, {
      tenantId: tid,
      noPO,
      grnItems: itemsFull,
      poItems,
      tolerancePct,
      overReceiveReason: control?.overReceiveReason,
      actorRole: actor?.role,
      match: (poLine, grnLines, used) => findMatchingGrnLine(
        poLine as Parameters<typeof findMatchingGrnLine>[0],
        grnLines as Parameters<typeof findMatchingGrnLine>[1],
        used,
      ) as JsonObject,
      approvedOver: overReceiveLines,
    });
    if (overErr) return { error: overErr };
  }
  const overReceive = overReceiveLines.length
    ? {
      reason: String(control?.overReceiveReason || '').trim().slice(0, 500),
      approvedBy: actor ? { userId: actor.userId, userName: actor.userName, role: actor.role } : null,
      tolerancePct: overReceiveTolerancePct,
      lines: overReceiveLines,
    }
    : null;

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
    if (!grnHasLots) await reserveGrnLotsForPlan(db, session, {
      tenantId: tid,
      noPO: grn.noPO,
      lots: lotDocs.map((lot) => ({
        id: lot.id,
        lotNo: lot.lotNo,
        productId: lot.productId,
        warehouseKode: lot.warehouseKode,
        qty: lot.qty,
        grnId: lot.grnId,
        noGRN: lot.noGRN,
      })),
    });
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

  if (noPO) {
    const synced = await syncCpoOnGrnPosted(db, {
      ...grn,
      tenantId: tid,
      items: itemsFull,
    } as JsonObject, session);
    if (synced.action === 'skipped' && synced.reason === 'concurrent_conflict') {
      return { error: `PO ${noPO} berubah bersamaan — ulangi penerimaan` };
    }
    if (synced.action === 'skipped' && synced.reason === 'unit_unconvertible') {
      const lines = 'lines' in synced && Array.isArray(synced.lines) ? synced.lines.join(', ') : '';
      return { error: `Satuan terima tidak bisa dikonversi ke satuan PO ${noPO}${lines ? ` (${lines})` : ''} — lengkapi konversi satuan produk dulu` };
    }
  }

  const receivedTotal = itemsFull.reduce((s, it) => {
    const qty = parseFloat(String(it.qtyReceived)) || 0;
    const harga = parseInt(String(it.harga || it.hargaSatuan || 0), 10);
    return s + Math.round(qty * harga);
  }, 0);

  return { itemsFull, receivedTotal, lokasiSet, lotDocs, overReceive };
}
