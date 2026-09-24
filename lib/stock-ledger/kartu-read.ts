import type { ClientSession, Db } from 'mongodb';
import { STOK_KARTU } from '@/lib/stock-ledger/balance';
import { roundMoney, roundStockQty } from '@/lib/stock-ledger/precision';
import type { StockSourceType } from '@/lib/stock-ledger/post-stock-movements';

export interface KartuOutboundCost {
  productId: string;
  /** Qty keluar bersih (keluar − masuk) dalam satuan dasar. */
  qtyOut: number;
  /** Σ qty × hargaSatuan kartu untuk baris berharga > 0. */
  amount: number;
  /** Qty keluar yang tercatat tanpa harga (hargaSatuan ≤ 0) — perlu harga cadangan. */
  zeroCostQty: number;
}

/**
 * Biaya keluar per produk dari stok_kartu untuk dokumen sumber tertentu (read-only).
 * Dipakai HPP aktual: nilai = harga yang benar-benar dibukukan saat stok keluar.
 */
export async function sumOutboundKartuBySource(
  db: Db,
  input: {
    tenantId: string;
    /** `docNos`: nomor dokumen untuk kartu lama tanpa sourceId (dicocokkan lewat noTransaksi). */
    sources: Array<{ sourceType: StockSourceType; sourceIds: string[]; docNos?: string[] }>;
    session?: ClientSession;
  },
): Promise<Map<string, KartuOutboundCost>> {
  const or: Record<string, unknown>[] = [];
  for (const s of input.sources) {
    const ids = [...new Set(s.sourceIds.filter(Boolean))];
    const nos = [...new Set((s.docNos || []).filter(Boolean))];
    if (ids.length) or.push({ sourceType: s.sourceType, sourceId: { $in: ids } });
    if (nos.length) {
      or.push({
        sourceType: s.sourceType,
        noTransaksi: { $in: nos },
        $or: [{ sourceId: { $exists: false } }, { sourceId: null }, { sourceId: '' }],
      });
    }
  }
  const out = new Map<string, KartuOutboundCost>();
  if (!or.length) return out;

  const rows = await db.collection(STOK_KARTU).aggregate<{
    _id: string;
    qtyOut: number;
    amount: number;
    zeroCostQty: number;
  }>([
    { $match: { tenantId: input.tenantId, $or: or } },
    {
      $project: {
        stokId: 1,
        net: { $subtract: [{ $ifNull: ['$keluar', 0] }, { $ifNull: ['$masuk', 0] }] },
        harga: { $ifNull: ['$hargaSatuan', 0] },
      },
    },
    {
      $group: {
        _id: '$stokId',
        qtyOut: { $sum: '$net' },
        amount: { $sum: { $cond: [{ $gt: ['$harga', 0] }, { $multiply: ['$net', '$harga'] }, 0] } },
        zeroCostQty: { $sum: { $cond: [{ $gt: ['$harga', 0] }, 0, '$net'] } },
      },
    },
  ], input.session ? { session: input.session } : {}).toArray();

  for (const r of rows) {
    const productId = String(r._id || '');
    if (!productId) continue;
    out.set(productId, {
      productId,
      qtyOut: roundStockQty(Number(r.qtyOut) || 0),
      amount: roundMoney(Number(r.amount) || 0),
      zeroCostQty: roundStockQty(Number(r.zeroCostQty) || 0),
    });
  }
  return out;
}
