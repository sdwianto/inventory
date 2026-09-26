// Normalisasi float dust saldo lama (sebelum pembulatan terpusat): nilai yang berbeda dari pembulatan 4 dp
// hanya sebatas galat representasi (≤ STOCK_QTY_EPS). Selisih lebih besar bukan dust dan hanya dilaporkan.

import { ObjectId, type ClientSession, type Db } from 'mongodb';
import { txOpts } from '@/lib/api/transaction';
import { STOK_BIN_COLLECTION } from '@/lib/stock-ledger/bin';
import { STOK_LOKASI } from '@/lib/stock-ledger/balance';
import { refreshProductsMasterStock } from '@/lib/stock-ledger/master';
import { roundStockQty, STOCK_QTY_DP, STOCK_QTY_EPS } from '@/lib/stock-ledger/precision';

const INGREDIENT_LOTS = 'ingredient_lots';

export type StockDustTarget = { collection: string; field: string };

export const STOCK_DUST_TARGETS: readonly StockDustTarget[] = [
  { collection: STOK_LOKASI, field: 'qty' },
  { collection: STOK_BIN_COLLECTION, field: 'qty' },
  { collection: INGREDIENT_LOTS, field: 'qty' },
  { collection: INGREDIENT_LOTS, field: 'qtyRemaining' },
];

export type StockDustRow = {
  collection: string;
  field: string;
  docId: string;
  productId: string;
  raw: number;
  rounded: number;
  /** true = galat representasi (≤ EPS), aman dibulatkan; false = selisih nyata, perlu dokumen koreksi. */
  dust: boolean;
};

function notRoundedExpr(field: string) {
  return {
    $and: [
      { $isNumber: `$${field}` },
      { $ne: [`$${field}`, { $round: [`$${field}`, STOCK_QTY_DP] }] },
    ],
  };
}

/** Read-only: semua saldo yang belum dibulatkan 4 dp per tenant. */
export async function planStockDust(db: Db, tenantId: string, session?: ClientSession): Promise<StockDustRow[]> {
  const out: StockDustRow[] = [];
  for (const t of STOCK_DUST_TARGETS) {
    const rows = await db.collection(t.collection)
      .find({ tenantId, $expr: notRoundedExpr(t.field) }, txOpts(session))
      .project({ _id: 1, stokId: 1, productId: 1, [t.field]: 1 })
      .toArray();
    for (const r of rows) {
      const raw = Number(r[t.field]);
      const rounded = roundStockQty(raw);
      out.push({
        collection: t.collection,
        field: t.field,
        docId: String(r._id),
        productId: String(r.stokId || r.productId || ''),
        raw,
        rounded,
        dust: Math.abs(raw - rounded) <= STOCK_QTY_EPS,
      });
    }
  }
  const products = await db.collection('products')
    .find({ tenantId, $expr: notRoundedExpr('stok') }, txOpts(session))
    .project({ _id: 1, id: 1, stok: 1 })
    .toArray();
  for (const p of products) {
    const raw = Number(p.stok);
    const rounded = roundStockQty(raw);
    out.push({
      collection: 'products',
      field: 'stok',
      docId: String(p._id),
      productId: String(p.id || ''),
      raw,
      rounded,
      dust: Math.abs(raw - rounded) <= STOCK_QTY_EPS,
    });
  }
  return out;
}

/**
 * Bulatkan baris dust (compare-and-set pada nilai mentah yang dibaca) lalu hitung ulang master produk
 * terdampak dari Σ stok_lokasi. Dipanggil di dalam transaksi.
 */
export async function applyStockDustNormalize(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  rows: StockDustRow[],
): Promise<{ normalized: number; skipped: number; masterUpdated: number }> {
  const dust = rows.filter((r) => r.dust);
  let normalized = 0;
  let skipped = 0;
  for (const r of dust) {
    if (r.collection === 'products') continue;
    const _id = ObjectId.isValid(r.docId) ? new ObjectId(r.docId) : r.docId;
    const res = await db.collection(r.collection).updateOne(
      { _id: _id as ObjectId, tenantId, [r.field]: r.raw },
      { $set: { [r.field]: r.rounded, updatedAt: new Date() } },
      txOpts(session),
    );
    if (res.modifiedCount === 1) normalized += 1; else skipped += 1;
  }
  const productIds = [...new Set(dust.map((r) => r.productId).filter(Boolean))];
  const master = await refreshProductsMasterStock(db, tenantId, productIds, session);
  return { normalized, skipped, masterUpdated: master.updated };
}
