// Satu-satunya pintu mutasi stok transaksional: stok_lokasi + stok_kartu + bin + lot bahan
// + products.stok + audit log, semuanya di sesi yang sama. Pemanggil yang memberi sesi wajib
// membatalkan transaksinya bila hasilnya { ok: false }.

import type { ClientSession, Db, MongoClient } from 'mongodb';
import {
  isNoTransactionSupportError,
  MongoTransactionsRequiredError,
  requiresMongoTransactions,
} from '@/lib/api/mongo-replica';
import { parseLokasiKode } from '@/lib/api/stok-lokasi';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';
import { txOpts } from '@/lib/api/transaction';
import { writeAuditLog } from '@/lib/api/audit-log';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';
import type { IngredientLotDoc } from '@/lib/food-production/ingredient-lot';
import { softConsumeBinOnWarehouseOut } from '@/lib/stock-ledger/bin-consume';
import { softPutawayBinOnWarehouseIn } from '@/lib/stock-ledger/bin-allocate';
import { applyLotPolicy, type StockLotPolicy, type StockLotCreateInput, type LotPostingResult } from '@/lib/stock-ledger/lot-policy';
import { roundStockQty, roundUnitCost, qtyLt } from '@/lib/stock-ledger/precision';
import { STOK_KARTU, STOK_LOKASI, applyLokasiDelta, recomputeProductStok } from '@/lib/stock-ledger/balance';
import {
  availableQtyAgainstLedger,
  ledgerSaldoForProducts,
  shouldEnforceLedgerOnOutbound,
} from '@/lib/stock-ledger/ledger-saldo';
import { stockPeriodLockError } from '@/lib/stock-ledger/period-guard';
import { buildKartuDoc, type StockActor, type StockCostSource } from '@/lib/stock-ledger/kartu';

export type StockSourceType =
  | 'RELEASE'
  | 'GRN'
  | 'VENDOR_RETURN'
  | 'VENDOR_RETURN_REJECTED'
  | 'PENYESUAIAN'
  | 'TRANSFER'
  | 'MASTER_PRODUK'
  | 'FP_ISSUE'
  | 'FP_RESULT'
  | 'FP_RESULT_WASTE'
  | 'FP_DIST'
  | 'FP_DIST_RETURN'
  | 'FP_ADJUST'
  | 'FP_XFER'
  | 'RELOKASI_GUDANG'
  | (string & {});

export interface StockMovementLine {
  /** Unik per dokumen sumber (dasar idempotensi kartu). */
  lineRef: string;
  productId: string;
  /** Kode gudang (GKERING / GBASAH / GJANITOR) atau string lokasi. */
  warehouseKode: string;
  /** Positif = masuk, negatif = keluar (satuan dasar). */
  deltaQtyBase: number;
  /** Harga per satuan dasar. Keluar tanpa harga memakai rata-rata produk (hargaBeli). */
  unitCost?: number;
  qtyEntered?: number;
  uomId?: string;
  satuan?: string;
  keterangan?: string;
  lokasiLabel?: string;
  /** SOFT (default): alokasi/konsumsi bin default tanpa menggagalkan posting. */
  binPolicy?: 'SOFT' | 'NONE';
  /** Default NONE. Lot bahan ikut dimutasi di sesi yang sama dengan saldo gudang. */
  lotPolicy?: StockLotPolicy;
  /** Field tambahan kartu (mis. fefoAllocations). Tidak bisa menimpa field inti. */
  kartuExtra?: Record<string, unknown>;
}

export interface PostStockMovementsInput {
  tenantId: string;
  sourceType: StockSourceType;
  /** Id dokumen sumber — bersama `lineRef` jadi kunci idempotensi kartu. */
  sourceId: string;
  noTransaksi: string;
  keterangan: string;
  /** Default: waktu server saat posting. */
  postingDate?: Date;
  actor?: StockActor | null;
  /** Default mengikuti sourceType (lihat shouldEnforceLedgerOnOutbound). */
  enforceLedger?: boolean;
  lines: StockMovementLine[];
}

export interface PostedStockLine {
  lineRef: string;
  productId: string;
  lokasiKode: string;
  deltaQtyBase: number;
  qtyLokasiAfter: number;
  unitCost: number;
  costSource: StockCostSource;
  kartuId: string;
  binKode?: string;
  binTakes?: Array<{ binKode: string; qty: number }>;
  lot?: LotPostingResult;
}

export type { StockLotPolicy, StockLotCreateInput, LotPostingResult, FefoAllocation, IngredientLotDoc };

export type PostStockMovementsResult =
  | { ok: true; lines: PostedStockLine[]; productStok: Record<string, number> }
  | { ok: false; error: string; lineRef?: string };

type ProductRow = {
  id: string;
  kode?: string;
  nama?: string;
  gudangKode?: string | null;
  hargaBeli?: number | string;
};

type PreparedLine = StockMovementLine & {
  delta: number;
  lokasiKode: string;
  product: ProductRow;
};

function productsFilter(tenantId: string, ids: string[]) {
  if (tenantId === 'default') {
    return {
      id: { $in: ids },
      $or: [
        { tenantId: 'default' },
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    };
  }
  return { tenantId, id: { $in: ids } };
}

function pairKey(productId: string, lokasiKode: string) {
  return `${productId}\u0000${lokasiKode}`;
}

function fail(error: string, lineRef?: string): PostStockMovementsResult {
  return { ok: false, error, ...(lineRef ? { lineRef } : {}) };
}

class PostingAborted extends Error {
  constructor(readonly result: PostStockMovementsResult) {
    super('posting aborted');
  }
}

/**
 * Tanpa `session`, posting dijalankan dalam transaksi sendiri sehingga kegagalan di baris mana pun
 * (termasuk posting ganda yang tertangkap index unik) tidak meninggalkan saldo setengah jadi.
 * Dengan `session`, pemanggil wajib membatalkan transaksinya bila hasil `ok: false`.
 */
export async function postStockMovements(
  db: Db,
  session: ClientSession | undefined,
  input: PostStockMovementsInput,
): Promise<PostStockMovementsResult> {
  if (session) return postInSession(db, session, input);
  const client = (db as unknown as { client?: MongoClient }).client;
  if (!client?.startSession) return postInSession(db, undefined, input);

  const own = client.startSession();
  try {
    let result!: PostStockMovementsResult;
    await own.withTransaction(async () => {
      result = await postInSession(db, own, input);
      if (!result.ok) throw new PostingAborted(result);
    });
    return result;
  } catch (e) {
    if (e instanceof PostingAborted) return e.result;
    if (isNoTransactionSupportError(e)) {
      if (requiresMongoTransactions()) throw new MongoTransactionsRequiredError();
      return postInSession(db, undefined, input);
    }
    throw e;
  } finally {
    await own.endSession();
  }
}

async function postInSession(
  db: Db,
  session: ClientSession | undefined,
  input: PostStockMovementsInput,
): Promise<PostStockMovementsResult> {
  const tid = input.tenantId || 'default';
  const noTransaksi = String(input.noTransaksi || '').trim();
  if (!noTransaksi) return fail('noTransaksi wajib');
  if (!input.sourceType) return fail('sourceType wajib');
  const sourceId = String(input.sourceId || '').trim();
  if (!sourceId) return fail('sourceId wajib');
  if (!input.lines?.length) return fail('Tidak ada baris mutasi stok');

  const postingDate = input.postingDate ?? new Date();
  if (Number.isNaN(postingDate.getTime())) return fail('Tanggal posting tidak valid');

  const seenRefs = new Set<string>();
  const productIds = new Set<string>();
  for (const line of input.lines) {
    const ref = String(line.lineRef || '').trim();
    if (!ref) return fail('lineRef wajib di setiap baris mutasi');
    if (seenRefs.has(ref)) return fail(`lineRef ganda dalam satu posting: ${ref}`, ref);
    seenRefs.add(ref);
    if (!line.productId) return fail('productId wajib', ref);
    const delta = roundStockQty(line.deltaQtyBase);
    if (!Number.isFinite(Number(line.deltaQtyBase)) || delta === 0) {
      return fail('Qty mutasi stok tidak valid', ref);
    }
    const mode = line.lotPolicy?.mode ?? 'NONE';
    if ((mode === 'FEFO_CONSUME' || mode === 'RELOCATE') && delta > 0) {
      return fail(`lotPolicy ${mode} hanya untuk mutasi keluar`, ref);
    }
    if ((mode === 'RESTORE' || mode === 'CREATE') && delta < 0) {
      return fail(`lotPolicy ${mode} hanya untuk mutasi masuk`, ref);
    }
    productIds.add(line.productId);
  }

  const lockErr = await stockPeriodLockError(db, tid, postingDate, session);
  if (lockErr) return fail(lockErr);

  const already = await db.collection(STOK_KARTU).findOne(
    {
      tenantId: tid,
      sourceType: String(input.sourceType),
      // Predikat partial filter diulang agar planner memakai uniq_stok_kartu_source_line.
      sourceId: { $eq: sourceId, $type: 'string', $gt: '' },
      lineRef: { $in: [...seenRefs], $type: 'string', $gt: '' },
    },
    { projection: { lineRef: 1 }, ...txOpts(session) },
  );
  if (already) {
    return fail(`Dokumen ${noTransaksi} sudah diposting ke kartu stok (posting ganda ditolak)`, String(already.lineRef));
  }

  const ids = [...productIds];
  const products = await db.collection<ProductRow>('products')
    .find(productsFilter(tid, ids), txOpts(session))
    .project<ProductRow>({ id: 1, kode: 1, nama: 1, gudangKode: 1, hargaBeli: 1 })
    .toArray();
  const productById = new Map(products.map((p) => [String(p.id), p]));

  const prepared: PreparedLine[] = [];
  for (const line of input.lines) {
    const product = productById.get(line.productId);
    if (!product) return fail(`Produk ${line.productId} tidak ditemukan`, line.lineRef);
    const lokasiKode = parseLokasiKode(line.warehouseKode);
    const whErr = assertProductWarehouse(product, lokasiKode);
    if (whErr) return fail(whErr.error, line.lineRef);
    prepared.push({ ...line, delta: roundStockQty(line.deltaQtyBase), lokasiKode, product });
  }

  // Validasi kecukupan di memori sebelum menulis apa pun (baris berurutan pada SKU yang sama
  // saling memengaruhi). Guard atomik di applyLokasiDelta tetap menjadi penentu akhir.
  const enforceLedger = input.enforceLedger ?? shouldEnforceLedgerOnOutbound(input.sourceType);
  const outbound = prepared.filter((l) => l.delta < 0);
  if (outbound.length) {
    const pairs = [...new Map(outbound.map((l) => [pairKey(l.productId, l.lokasiKode), l])).values()];
    const rows = await db.collection<{ stokId: string; lokasiKode: string; qty?: number | string }>(STOK_LOKASI)
      .find({
        tenantId: tid,
        $or: pairs.map((l) => ({ stokId: l.productId, lokasiKode: l.lokasiKode })),
      }, txOpts(session))
      .project<{ stokId: string; lokasiKode: string; qty?: number | string }>({ stokId: 1, lokasiKode: 1, qty: 1 })
      .toArray();
    const lokasiQty = new Map(pairs.map((l) => [pairKey(l.productId, l.lokasiKode), 0]));
    for (const r of rows) lokasiQty.set(pairKey(r.stokId, r.lokasiKode), roundStockQty(r.qty));
    const ledger = enforceLedger
      ? await ledgerSaldoForProducts(db, tid, [...new Set(outbound.map((l) => l.productId))], session)
      : new Map();

    for (const l of prepared) {
      const key = pairKey(l.productId, l.lokasiKode);
      const onHand = lokasiQty.get(key) ?? 0;
      const info = ledger.get(l.productId);
      if (l.delta < 0) {
        const need = -l.delta;
        const label = l.product.nama || l.product.kode || l.productId;
        if (qtyLt(onHand, need)) {
          return fail(`${label}: Stok di lokasi ${l.lokasiKode} tidak cukup (sisa: ${Math.max(0, onHand)})`, l.lineRef);
        }
        if (enforceLedger) {
          const available = availableQtyAgainstLedger(onHand, info);
          if (qtyLt(available, need)) {
            return fail(
              `${label}: Stok di lokasi ${l.lokasiKode} tidak cukup (sisa: ${available} — dibatasi saldo kartu stok)`,
              l.lineRef,
            );
          }
        }
      }
      if (lokasiQty.has(key)) lokasiQty.set(key, roundStockQty(onHand + l.delta));
      if (info) {
        ledger.set(l.productId, { saldo: roundStockQty(info.saldo + l.delta), hasActivity: true });
      }
    }
  }

  const posted: PostedStockLine[] = [];
  const kartuDocs: Record<string, unknown>[] = [];
  for (const l of prepared) {
    const adj = await applyLokasiDelta(db, tid, l.productId, l.lokasiKode, l.delta, postingDate, session);
    if ('error' in adj) {
      const label = l.product.nama || l.product.kode || l.productId;
      return fail(`${label}: ${adj.error} (sisa: ${Math.max(0, adj.current)})`, l.lineRef);
    }

    let binKode: string | undefined;
    let binTakes: Array<{ binKode: string; qty: number }> | undefined;
    if (l.binPolicy !== 'NONE') {
      if (l.delta < 0) {
        const bin = await softConsumeBinOnWarehouseOut(db, tid, l.productId, l.lokasiKode, -l.delta, session);
        if (bin.takes.length) binTakes = bin.takes;
      } else {
        const bin = await softPutawayBinOnWarehouseIn(db, tid, l.productId, l.lokasiKode, l.delta, session);
        if (bin.allocated > 0 && bin.binKode) binKode = bin.binKode;
      }
    }

    let lot: LotPostingResult | undefined;
    if (l.lotPolicy && l.lotPolicy.mode !== 'NONE') {
      const applied = await applyLotPolicy(db, session, {
        tenantId: tid,
        sourceType: String(input.sourceType),
        sourceId,
        noTransaksi,
        postingDate,
        productId: l.productId,
        product: l.product,
        lokasiKode: l.lokasiKode,
        delta: l.delta,
        policy: l.lotPolicy,
        satuan: l.satuan,
      });
      if ('error' in applied) return fail(applied.error, l.lineRef);
      lot = applied;
    }

    let unitCost = 0;
    let costSource: StockCostSource = 'NONE';
    if (l.unitCost !== undefined && l.unitCost !== null && Number.isFinite(Number(l.unitCost))) {
      unitCost = roundUnitCost(l.unitCost);
      costSource = 'LINE';
    } else if (l.delta < 0) {
      const avg = roundUnitCost(l.product.hargaBeli);
      if (avg > 0) {
        unitCost = avg;
        costSource = 'PRODUCT_AVG';
      }
    }

    const kartu = buildKartuDoc({
      tenantId: tid,
      stokId: l.productId,
      lokasiKode: l.lokasiKode,
      lokasiLabel: l.lokasiLabel,
      postingDate,
      noTransaksi,
      sourceType: String(input.sourceType),
      sourceId,
      lineRef: l.lineRef,
      keterangan: l.keterangan || input.keterangan,
      deltaQtyBase: l.delta,
      unitCost,
      costSource,
      qtyEntered: l.qtyEntered,
      uomId: l.uomId,
      satuan: l.satuan,
      binKode,
      actor: input.actor,
      extra: {
        ...(l.kartuExtra || {}),
        ...(binTakes ? { binTakes } : {}),
        ...(lot ? lot.kartuFields : {}),
      },
    });
    kartuDocs.push(kartu);
    posted.push({
      lineRef: l.lineRef,
      productId: l.productId,
      lokasiKode: l.lokasiKode,
      deltaQtyBase: l.delta,
      qtyLokasiAfter: adj.qty,
      unitCost,
      costSource,
      kartuId: kartu.id,
      ...(binKode ? { binKode } : {}),
      ...(binTakes ? { binTakes } : {}),
      ...(lot ? { lot } : {}),
    });
  }

  try {
    await db.collection(STOK_KARTU).insertMany(kartuDocs, txOpts(session));
  } catch (e) {
    if ((e as { code?: number })?.code === 11000) {
      return fail(`Dokumen ${noTransaksi} sudah diposting ke kartu stok (posting ganda ditolak)`);
    }
    throw e;
  }

  const productStok: Record<string, number> = {};
  for (const id of ids) {
    productStok[id] = await recomputeProductStok(db, tid, id, session);
  }

  await writeAuditLog(db, {
    tenantId: tid,
    action: 'STOCK_POSTING',
    entityType: String(input.sourceType),
    entityId: sourceId,
    summary: `${noTransaksi}: ${posted.length} mutasi stok ${input.sourceType}`,
    userId: input.actor?.userId || 'system',
    userName: input.actor?.userName || 'System',
    metadata: {
      noTransaksi,
      postingDate,
      lines: posted.map((p) => ({
        lineRef: p.lineRef,
        productId: p.productId,
        lokasiKode: p.lokasiKode,
        deltaQtyBase: p.deltaQtyBase,
        qtyLokasiAfter: p.qtyLokasiAfter,
        kartuId: p.kartuId,
      })),
    },
  }, session);

  return { ok: true, lines: posted, productStok };
}
