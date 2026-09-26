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
import { loadLotQcHeld, lotQcBlockedMessage, lotQcHeldTotal, type LotQcHeldInfo } from '@/lib/stock-ledger/lot-qc';
import {
  consumeReservationPool,
  loadReservationPools,
  reservationBlockedMessage,
  reservationBlockedQty,
} from '@/lib/stock-ledger/plan-reservation';
import { buildKartuDoc, type StockActor, type StockCostSource } from '@/lib/stock-ledger/kartu';
import { applyLineCost, legacyLineCost, type AvgCostState } from '@/lib/stock-ledger/cost';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';

export type StockSourceType =
  | 'RELEASE'
  | 'GRN'
  | 'GRN_REVERSAL'
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
  | 'STOCK_REVERSAL'
  | (string & {});

export interface StockMovementLine {
  /** Unik per dokumen sumber (dasar idempotensi kartu). */
  lineRef: string;
  productId: string;
  /** Kode gudang (GKERING / GBASAH / GJANITOR) atau string lokasi. */
  warehouseKode: string;
  /** Positif = masuk, negatif = keluar (satuan dasar). */
  deltaQtyBase: number;
  /**
   * Harga per satuan dasar. costingV2 mati: keluar tanpa harga memakai hargaBeli. costingV2 aktif:
   * hanya masuk berbiaya dan pembalik pembelian yang memakai harga ini; sisanya rata-rata bergerak.
   */
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
  avgCost?: number | null;
  itemRole?: string | null;
  mergedInto?: string | null;
  deletedAt?: Date | null;
  shelfLifeDays?: number | null;
  satuan?: string;
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

/**
 * Keluar dari (produk, gudang) yang punya lot tertahan QC; `held` dikurangi agar baris berikutnya
 * pada pasangan yang sama melihat sisa yang benar. Null = boleh.
 * - VARIANCE (hitung fisik): lot lolos dulu, sisanya memang hilang dari qty tertahan — tidak diblokir.
 * - FEFO_CONSUME + qcHeld PREFERRED: lot tertahan bernomor preferredLotNo boleh keluar (RTV/pemusnahan);
 *   preferredLotNo yang bukan lot tertahan diperiksa seperti keluar biasa (stok lolos QC).
 */
function consumeQcHeldAllowance(
  held: LotQcHeldInfo,
  line: PreparedLine,
  need: number,
  onHand: number,
  available: number,
): { releasedAvailable: number; preferredShort?: boolean; preferredLotNo?: string } | null {
  const heldTotal = lotQcHeldTotal(held);
  const policy = line.lotPolicy;
  const takeHeld = (qty: number, status: 'QUARANTINE' | 'REJECTED' | 'ANY') => {
    let left = qty;
    const order: Array<'rejected' | 'quarantine'> = status === 'QUARANTINE' ? ['quarantine'] : status === 'REJECTED' ? ['rejected'] : ['rejected', 'quarantine'];
    for (const k of order) {
      const t = Math.min(left, held[k]);
      held[k] = roundStockQty(held[k] - t);
      left = roundStockQty(left - t);
    }
  };

  if (policy?.mode === 'VARIANCE') {
    const fromHeld = roundStockQty(need - Math.max(0, roundStockQty(onHand - heldTotal)));
    if (fromHeld > 0) takeHeld(fromHeld, 'ANY');
    return null;
  }

  if (policy?.mode === 'FEFO_CONSUME' && policy.qcHeld === 'PREFERRED') {
    const pref = String(policy.preferredLotNo || '').trim();
    const prefLot = pref ? held.byLotNo.get(pref) : undefined;
    if (prefLot) {
      if (qtyLt(prefLot.qty, need)) {
        return { releasedAvailable: prefLot.qty, preferredShort: true, preferredLotNo: pref || undefined };
      }
      prefLot.qty = roundStockQty(prefLot.qty - need);
      takeHeld(need, prefLot.qcStatus === 'QUARANTINE' ? 'QUARANTINE' : 'REJECTED');
      return null;
    }
  }
  const releasedAvailable = roundStockQty(available - heldTotal);
  if (qtyLt(releasedAvailable, need)) return { releasedAvailable };
  return null;
}

/**
 * Status rata-rata bergerak sebelum posting: qty = Σ stok_lokasi semua gudang, avg = products.avgCost.
 * Produk yang belum pernah punya avgCost (sebelum migrasi backfill) memakai hargaBeli sebagai titik awal.
 */
async function loadAvgCostState(
  db: Db,
  tenantId: string,
  ids: string[],
  productById: Map<string, ProductRow>,
  session: ClientSession | undefined,
): Promise<Map<string, AvgCostState>> {
  const rows = await db.collection(STOK_LOKASI).aggregate<{ _id: string; qty: number }>([
    { $match: { tenantId, stokId: { $in: ids } } },
    { $group: { _id: '$stokId', qty: { $sum: { $toDouble: { $ifNull: ['$qty', 0] } } } } },
  ], txOpts(session)).toArray();
  const qtyById = new Map(rows.map((r) => [String(r._id), roundStockQty(r.qty)]));
  const state = new Map<string, AvgCostState>();
  for (const id of ids) {
    const p = productById.get(id);
    const avg = typeof p?.avgCost === 'number' ? roundUnitCost(p.avgCost) : Math.max(0, roundUnitCost(p?.hargaBeli));
    state.set(id, { qty: qtyById.get(id) ?? 0, avg });
  }
  return state;
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
    .project<ProductRow>({ id: 1, kode: 1, nama: 1, gudangKode: 1, hargaBeli: 1, avgCost: 1, itemRole: 1, mergedInto: 1, deletedAt: 1, shelfLifeDays: 1, satuan: 1 })
    .toArray();
  const productById = new Map(products.map((p) => [String(p.id), p]));

  const prepared: PreparedLine[] = [];
  for (const line of input.lines) {
    const product = productById.get(line.productId);
    if (!product) return fail(`Produk ${line.productId} tidak ditemukan`, line.lineRef);
    if (product.mergedInto) {
      return fail(
        `Produk ${product.kode || line.productId} sudah digabung ke item persediaan lain — muat ulang dokumen lalu pilih item yang aktif`,
        line.lineRef,
      );
    }
    if (product.deletedAt) {
      return fail(`Produk ${product.kode || line.productId} sudah dihapus — mutasi stok ditolak`, line.lineRef);
    }
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
    // Fase 3.2 — lot karantina/ditolak QC adalah stok fisik yang tidak boleh keluar.
    const qcHeld = await loadLotQcHeld(db, tid, pairs.map((l) => ({ productId: l.productId, lokasiKode: l.lokasiKode })), session);
    const reserved = await loadReservationPools(db, tid, pairs.map((l) => ({ productId: l.productId, lokasiKode: l.lokasiKode })), session);

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
        const available = enforceLedger ? availableQtyAgainstLedger(onHand, info) : onHand;
        if (enforceLedger && qtyLt(available, need)) {
          return fail(
            `${label}: Stok di lokasi ${l.lokasiKode} tidak cukup (sisa: ${available} — dibatasi saldo kartu stok)`,
            l.lineRef,
          );
        }
        const held = qcHeld.get(key);
        if (held && lotQcHeldTotal(held) > 0) {
          const heldErr = consumeQcHeldAllowance(held, l, need, onHand, available);
          if (heldErr?.preferredShort) {
            const satuan = l.product.satuan ? ` ${l.product.satuan}` : '';
            const which = heldErr.preferredLotNo ? `Lot ${heldErr.preferredLotNo}` : 'Lot yang diminta';
            return fail(
              `${label}: ${which} tidak cukup untuk keluar (sisa tertahan ${heldErr.releasedAvailable}${satuan}). `
              + 'Retur dan pemusnahan QC hanya boleh mengambil lot ditolak itu sendiri.',
              l.lineRef,
            );
          }
          if (heldErr) {
            return fail(lotQcBlockedMessage({
              label,
              lokasiKode: l.lokasiKode,
              need,
              releasedAvailable: heldErr.releasedAvailable,
              held,
              satuan: l.product.satuan,
            }), l.lineRef);
          }
        }
        const pool = reserved.get(key);
        const policy = l.lotPolicy;
        const variance = policy?.mode === 'VARIANCE';
        const preferred = policy?.mode === 'FEFO_CONSUME' && policy.qcHeld === 'PREFERRED';
        if (pool && pool.totalReleased > 0 && !preferred) {
          const planId = policy?.mode === 'FEFO_CONSUME' ? policy.reservationPlanId : undefined;
          const override = policy?.mode === 'FEFO_CONSUME' && policy.reservationOverride === true;
          const heldNow = lotQcHeldTotal(qcHeld.get(key));
          const releasedStock = Math.max(0, roundStockQty(available - heldNow));
          const blocked = reservationBlockedQty(pool, { planId, override: override || variance });
          const usable = roundStockQty(releasedStock - blocked);
          if (!variance && !override && qtyLt(usable, need)) {
            return fail(reservationBlockedMessage({
              label,
              lokasiKode: l.lokasiKode,
              need,
              usable,
              blocked,
              satuan: l.product.satuan,
              overrideAvailable: input.sourceType === 'RELEASE',
            }), l.lineRef);
          }
          const unreserved = Math.max(0, roundStockQty(releasedStock - pool.totalReleased));
          const fromReserved = Math.min(pool.totalReleased, Math.max(0, roundStockQty(need - unreserved)));
          consumeReservationPool(pool, fromReserved, planId);
        }
      } else if (l.lotPolicy?.mode === 'CREATE' && (l.lotPolicy.lot.qcStatus === 'QUARANTINE' || l.lotPolicy.lot.qcStatus === 'REJECTED')) {
        const held = qcHeld.get(key) || { quarantine: 0, rejected: 0, byLotNo: new Map() };
        if (l.lotPolicy.lot.qcStatus === 'QUARANTINE') held.quarantine = roundStockQty(held.quarantine + l.delta);
        else held.rejected = roundStockQty(held.rejected + l.delta);
        qcHeld.set(key, held);
      }
      if (lokasiQty.has(key)) lokasiQty.set(key, roundStockQty(onHand + l.delta));
      if (info) {
        ledger.set(l.productId, { saldo: roundStockQty(info.saldo + l.delta), hasActivity: true });
      }
    }
  }

  const costingV2 = await isTenantFeatureEnabled(db, tid, 'costingV2');
  const costState = await loadAvgCostState(db, tid, ids, productById, session);
  const avgBefore = new Map([...costState].map(([id, s]) => [id, s.avg]));

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

    const costInput = {
      sourceType: String(input.sourceType),
      delta: l.delta,
      lineUnitCost: l.unitCost,
      hargaBeli: l.product.hargaBeli,
      itemRole: l.product.itemRole,
    };
    const moving = applyLineCost(costState.get(l.productId)!, costInput);
    costState.set(l.productId, moving.next);
    const { unitCost, costSource }: { unitCost: number; costSource: StockCostSource } = costingV2
      ? moving
      : legacyLineCost(costInput);

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
    const avg = costState.get(id)!.avg;
    const stored = productById.get(id)?.avgCost;
    if (avg !== avgBefore.get(id) || typeof stored !== 'number') {
      await db.collection('products').updateOne(
        productsFilter(tid, [id]),
        { $set: { avgCost: avg, avgCostUpdatedAt: postingDate } },
        txOpts(session),
      );
    }
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
