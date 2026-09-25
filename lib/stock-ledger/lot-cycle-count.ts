/**
 * W2-8 — sync ingredient_lots when cycle count (penyesuaian) changes stock.
 * Mirror of syncBatchesOnVariance for FG (W2-4).
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import {
  INGREDIENT_LOTS_COLLECTION,
  LOT_QC_RELEASED_FILTER,
  buildPenyesuaianLotNo,
  resolveLotExpiry,
  businessDateIso,
  effectiveIngredientQtyRemaining,
  isIngredientExpired,
  type IngredientLotDoc,
} from '@/lib/food-production/ingredient-lot';
import { consumeIngredientLotsFefo } from '@/lib/stock-ledger/lot-consume';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { isZeroQty, roundStockQty } from '@/lib/stock-ledger/precision';

export type CycleCountLotResult = {
  stokId: string;
  warehouseKode: string;
  deltaQty: number;
  skippedNoLots: boolean;
  consumed?: number;
  increased?: number;
  createdLotId?: string;
  shortfall?: number;
};

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

/**
 * Count down → FEFO consume lots (allow expired).
 * Count up → increase newest lot qtyRemaining (+ qty cap).
 * Count up + no lots → buat lot baru sumber PENYESUAIAN (asal Panduan Release); kedaluwarsa dari
 * masa simpan master, ditolak bila flag lotExpiryRequired aktif dan masa simpan kosong.
 */
export async function syncLotsOnVariance(
  db: Db,
  input: {
    tenantId: string;
    stokId: string;
    warehouseKode: string;
    deltaQty: number;
    asOf?: Date;
    noDokumen?: string;
    penyesuaianId?: string;
    productKode?: string;
    productNama?: string;
    shelfLifeDays?: number | null;
    satuan?: string;
  },
  session?: ClientSession | null,
): Promise<CycleCountLotResult | { error: string }> {
  const delta = roundStockQty(input.deltaQty);
  const base: CycleCountLotResult = {
    stokId: input.stokId,
    warehouseKode: input.warehouseKode,
    deltaQty: delta,
    skippedNoLots: true,
  };
  if (!Number.isFinite(delta) || delta === 0 || !input.stokId || !input.warehouseKode) {
    return base;
  }

  const now = input.asOf ?? new Date();

  if (delta < 0) {
    const fefo = await consumeIngredientLotsFefo(
      db,
      {
        tenantId: input.tenantId,
        stokId: input.stokId,
        warehouseKode: input.warehouseKode,
        needQty: Math.abs(delta),
        asOf: now,
        allowExpired: true,
        noDokumen: input.noDokumen,
        qcHeld: 'LAST',
      },
      session,
    );
    return {
      ...base,
      skippedNoLots: fefo.skippedNoLots,
      consumed: fefo.allocated,
      shortfall: fefo.shortfall,
    };
  }

  // Selisih kurang memakai lot karantina paling akhir (qcHeld LAST); selisih lebih mengembalikan qty itu
  // ke lot karantina dulu, supaya hitung turun lalu naik tidak meloloskan barang tanpa inspeksi.
  const heldRows = await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find(
      {
        tenantId: input.tenantId,
        productId: input.stokId,
        warehouseKode: input.warehouseKode,
        status: { $in: ['ACTIVE', 'EXPIRED', 'CONSUMED'] },
        qcStatus: 'QUARANTINE',
      },
      txOpts(session),
    )
    .sort({ expiryDate: -1, receivedAt: -1 })
    .toArray() as unknown as IngredientLotDoc[];
  let left = delta;
  for (const lot of heldRows) {
    if (!(left > 0)) break;
    const rem = effectiveIngredientQtyRemaining(lot);
    const deficit = roundStockQty(Number(lot.qty || 0) - rem);
    if (!(deficit > 0)) continue;
    const add = roundStockQty(Math.min(deficit, left));
    const after = roundStockQty(rem + add);
    await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
      { id: lot.id, tenantId: input.tenantId },
      {
        $set: {
          qtyRemaining: after,
          status: isIngredientExpired(lot.expiryDate, now) ? 'EXPIRED' : 'ACTIVE',
          updatedAt: now,
          lastCycleCountBy: { noDokumen: input.noDokumen, delta: add, at: now },
        },
      },
      txOpts(session),
    );
    left = roundStockQty(left - add);
  }
  if (!(left > 0) || isZeroQty(left)) {
    return { ...base, skippedNoLots: false, increased: delta };
  }

  const rows = await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find(
      {
        tenantId: input.tenantId,
        productId: input.stokId,
        warehouseKode: input.warehouseKode,
        status: { $in: ['ACTIVE', 'EXPIRED', 'CONSUMED'] },
        // Selisih lebih tidak boleh menambah lot karantina/ditolak (akan ikut tertahan).
        ...LOT_QC_RELEASED_FILTER,
      },
      txOpts(session),
    )
    .sort({ expiryDate: -1, receivedAt: -1 })
    .limit(5)
    .toArray() as unknown as IngredientLotDoc[];

  if (!rows.length) {
    const receivedAt = businessDateIso(now);
    const expiry = resolveLotExpiry({
      receivedAt,
      shelfLifeDays: input.shelfLifeDays,
      required: await isTenantFeatureEnabled(db, input.tenantId, 'lotExpiryRequired'),
      label: String(input.productNama || input.productKode || input.stokId),
    });
    if ('error' in expiry) {
      return { error: `${expiry.error}. Stok bertambah tanpa lot: isi masa simpan di master produk atau terima lewat GRN` };
    }
    const noPS = String(input.noDokumen || '').trim();
    const lotId = uuidv4();
    const lot: IngredientLotDoc = {
      id: lotId,
      tenantId: input.tenantId,
      lotNo: buildPenyesuaianLotNo({
        noPenyesuaian: noPS || undefined,
        productKode: input.productKode,
        receivedAt,
      }),
      grnId: '',
      sourceType: 'PENYESUAIAN',
      ...(input.penyesuaianId ? { penyesuaianId: input.penyesuaianId } : {}),
      ...(noPS ? { noPenyesuaian: noPS } : {}),
      productId: input.stokId,
      productKode: input.productKode,
      productNama: input.productNama,
      satuan: input.satuan,
      warehouseKode: input.warehouseKode,
      receivedAt,
      expiryDate: expiry.expiryDate,
      expirySource: expiry.expirySource,
      qty: left,
      qtyRemaining: left,
      status: 'ACTIVE',
      lastCycleCountBy: {
        noDokumen: noPS || undefined,
        delta: left,
        at: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(INGREDIENT_LOTS_COLLECTION).insertOne(lot, txOpts(session));
    return {
      ...base,
      skippedNoLots: false,
      increased: delta,
      createdLotId: lotId,
    };
  }

  const target = rows.find((b) => b.status !== 'CONSUMED') || rows[0];
  const before = effectiveIngredientQtyRemaining(target);
  const after = roundStockQty(before + left);
  const qtyCap = Math.max(roundStockQty(target.qty), after);
  const expired = isIngredientExpired(target.expiryDate, now);
  const status = after <= 0 || isZeroQty(after) ? 'CONSUMED' : expired ? 'EXPIRED' : 'ACTIVE';

  await db.collection(INGREDIENT_LOTS_COLLECTION).updateOne(
    { id: target.id, tenantId: input.tenantId },
    {
      $set: {
        qty: qtyCap,
        qtyRemaining: after,
        status,
        updatedAt: now,
        lastCycleCountBy: {
          noDokumen: input.noDokumen,
          delta: left,
          at: now,
        },
      },
    },
    txOpts(session),
  );

  return {
    ...base,
    skippedNoLots: false,
    increased: delta,
  };
}
