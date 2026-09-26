// Replay kronologis kartu stok per produk dengan aturan rata-rata bergerak yang sama dengan posting
// (applyLineCost). Hanya baris berharga 0 / kosong yang diisi; harga historis yang sudah ada dipertahankan.

import type { AnyBulkWriteOperation, ClientSession, Db, Document, ObjectId } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { applyLineCost, isMemoCostItem, type AvgCostState, type StockCostSource } from '@/lib/stock-ledger/cost';
import { roundMoney, roundStockQty, roundUnitCost } from '@/lib/stock-ledger/precision';
import { STOK_KARTU, STOK_LOKASI } from '@/lib/stock-ledger/balance';

type KartuRow = {
  _id: ObjectId;
  sourceType?: string;
  masuk?: number | string;
  keluar?: number | string;
  hargaSatuan?: number | string;
  costSource?: string;
};

type ProductRow = { id: string; kode?: string; nama?: string; hargaBeli?: number | string; avgCost?: number; itemRole?: string };

export type StockCostBackfillPlan = {
  productId: string;
  kode?: string;
  nama?: string;
  memo: boolean;
  lines: number;
  fill: number;
  fillValue: number;
  unresolved: number;
  avgBefore: number | null;
  avgAfter: number;
  replayQty: number;
  ledgerQty: number;
  valueAtHargaBeli: number;
  valueAtAvg: number;
  updates: Array<{ _id: ObjectId; unitCost: number; costSource: StockCostSource }>;
};

function hasCost(row: KartuRow): boolean {
  return roundUnitCost(row.hargaSatuan) > 0;
}

export async function planStockCostBackfill(
  db: Db,
  tenantId: string,
  product: ProductRow,
  session?: ClientSession,
): Promise<StockCostBackfillPlan> {
  const rows = await db.collection(STOK_KARTU)
    .find({ tenantId, stokId: product.id }, txOpts(session))
    .project({ _id: 1, sourceType: 1, masuk: 1, keluar: 1, hargaSatuan: 1, costSource: 1 })
    .sort({ tanggal: 1, createdAt: 1, _id: 1 })
    .toArray() as unknown as KartuRow[];
  const [lok] = await db.collection(STOK_LOKASI).aggregate([
    { $match: { tenantId, stokId: product.id } },
    { $group: { _id: null, qty: { $sum: { $toDouble: { $ifNull: ['$qty', 0] } } } } },
  ], txOpts(session)).toArray() as Array<{ qty: number }>;

  const memo = isMemoCostItem(product);
  let state: AvgCostState = { qty: 0, avg: 0 };
  const updates: StockCostBackfillPlan['updates'] = [];
  let fillValue = 0;
  let unresolved = 0;
  for (const row of rows) {
    const delta = roundStockQty((Number(row.masuk) || 0) - (Number(row.keluar) || 0));
    if (delta === 0) continue;
    const costed = hasCost(row);
    const r = applyLineCost(state, {
      sourceType: String(row.sourceType || ''),
      delta,
      lineUnitCost: costed ? roundUnitCost(row.hargaSatuan) : undefined,
      hargaBeli: product.hargaBeli,
      itemRole: product.itemRole,
    });
    state = r.next;
    if (costed || memo) continue;
    if (r.unitCost > 0) {
      updates.push({ _id: row._id, unitCost: r.unitCost, costSource: r.costSource });
      fillValue += Math.abs(delta) * r.unitCost;
    } else {
      unresolved += 1;
    }
  }

  const ledgerQty = roundStockQty(lok?.qty ?? 0);
  const avgAfter = memo ? 0 : roundUnitCost(state.avg);
  return {
    productId: product.id,
    kode: product.kode,
    nama: product.nama,
    memo,
    lines: rows.length,
    fill: updates.length,
    fillValue: roundMoney(fillValue),
    unresolved,
    avgBefore: typeof product.avgCost === 'number' ? product.avgCost : null,
    avgAfter,
    replayQty: roundStockQty(state.qty),
    ledgerQty,
    valueAtHargaBeli: memo ? 0 : roundMoney(Math.max(0, ledgerQty) * roundUnitCost(product.hargaBeli)),
    valueAtAvg: roundMoney(Math.max(0, ledgerQty) * avgAfter),
    updates,
  };
}

/** Tulis harga baris yang diisi + products.avgCost. Idempoten: replay ulang tidak menemukan baris kosong. */
export async function applyStockCostBackfill(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  plan: StockCostBackfillPlan,
  meta: { now: Date; migrationId: string },
): Promise<void> {
  if (plan.updates.length) {
    const ops: AnyBulkWriteOperation<Document>[] = plan.updates.map((u) => ({
      updateOne: {
        filter: { _id: u._id, tenantId, $or: [{ hargaSatuan: { $in: [0, null] } }, { hargaSatuan: { $exists: false } }] },
        update: {
          $set: {
            hargaSatuan: u.unitCost,
            costSource: u.costSource,
            costBackfill: { migrationId: meta.migrationId, at: meta.now },
          },
        },
      },
    }));
    await db.collection(STOK_KARTU).bulkWrite(ops, { ordered: false, ...txOpts(session) });
  }
  if (!plan.memo && plan.avgAfter !== plan.avgBefore) {
    await db.collection('products').updateOne(
      { tenantId, id: plan.productId },
      { $set: { avgCost: plan.avgAfter, avgCostUpdatedAt: meta.now } },
      txOpts(session),
    );
  }
}

export async function listProductsWithKartu(db: Db, tenantId: string): Promise<ProductRow[]> {
  const ids = await db.collection(STOK_KARTU).distinct('stokId', { tenantId }) as string[];
  if (!ids.length) return [];
  return db.collection('products')
    .find({ tenantId, id: { $in: ids.map(String) } })
    .project({ _id: 0, id: 1, kode: 1, nama: 1, hargaBeli: 1, avgCost: 1, itemRole: 1 })
    .sort({ kode: 1 })
    .toArray() as unknown as Promise<ProductRow[]>;
}
