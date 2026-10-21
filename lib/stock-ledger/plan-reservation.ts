/**
 * Fase 3.3 — cadangan stok rencana.
 * GRN dari PO yang tertaut rencana mengunci lot itu untuk rencana tersebut.
 * Stok tersedia = stok − lot tertahan QC − cadangan rencana lain.
 * Flag `planStockReservation` hanya mengatur pembuatan cadangan. Cadangan yang
 * sudah ada tetap dihormati sampai rencana selesai/dibatalkan, atau hari masak
 * rencana sudah lewat (WIB) — supaya RPN kemarin tidak menahan RL hari ini.
 */

import type { ClientSession, Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';
import { txOpts } from '@/lib/api/transaction';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
import { isLotQcHeld, type IngredientLotDoc } from '@/lib/food-production/ingredient-lot';
import { planDayWindowWib } from '@/lib/food-production/production-keperluan';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { isZeroQty, roundStockQty } from '@/lib/stock-ledger/precision';

export const STOCK_ALLOCATIONS_COLLECTION = 'stock_allocations';

export type StockAllocationStatus = 'ACTIVE' | 'RELEASED' | 'CONSUMED';
export type StockAllocationReleaseReason = 'PLAN_COMPLETED' | 'PLAN_CANCELLED' | 'GRN_REVERSED' | 'QC_REJECTED';

export type StockAllocationDoc = {
  id: string;
  tenantId: string;
  productionPlanId: string;
  productionPlanNo?: string;
  productId: string;
  warehouseKode: string;
  lotId: string;
  lotNo?: string;
  grnId?: string;
  noGRN?: string;
  noPO?: string;
  qty: number;
  qtyRemaining: number;
  status: StockAllocationStatus;
  releasedReason?: StockAllocationReleaseReason;
  createdAt: Date;
  updatedAt: Date;
};

const CLOSED_PLAN = new Set(['COMPLETED', 'CANCELLED']);

export function reservationPairKey(productId: string, lokasiKode: string) {
  return `${productId}\u0000${lokasiKode}`;
}
const pairKey = reservationPairKey;

function opts(session?: ClientSession | null) {
  return txOpts(session || undefined);
}

/** Hari masak RPN sudah berakhir (setelah 23:59:59.999 WIB tanggal rencana). */
export function isPlanCookDayPast(planTanggal: string, asOf: Date = new Date()): boolean {
  const t = String(planTanggal || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  return planDayWindowWib(t).end.getTime() < asOf.getTime();
}

/** Cadangan RPN yang hari masaknya sudah lewat tidak mengunci stok RL lain. */
export function isReservationPlanBlocking(
  planTanggal: string | null | undefined,
  asOf: Date = new Date(),
): boolean {
  const t = String(planTanggal || '').trim();
  if (!t) return true; // tanpa tanggal: tetap kunci (aman)
  return !isPlanCookDayPast(t, asOf);
}

async function loadPlanTanggalById(
  db: Db,
  tenantId: string,
  planIds: string[],
  session?: ClientSession | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(planIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return out;
  const plans = await db.collection(PRODUCTION_PLANS_COLLECTION).find(
    { ...tenantIdMatchFilter(tenantId), id: { $in: ids } },
    { projection: { id: 1, tanggal: 1 }, ...opts(session) },
  ).toArray();
  for (const p of plans) {
    const id = String(p.id || '').trim();
    const tanggal = String(p.tanggal || '').slice(0, 10);
    if (id && tanggal) out.set(id, tanggal);
  }
  return out;
}

export function reservationBlockedMessage(input: {
  label: string;
  lokasiKode: string;
  need: number;
  usable: number;
  blocked: number;
  satuan?: string;
  /** Nomor RPN yang mengunci (rencana lain). */
  blockingPlanNos?: string[];
  /** Hanya Release Stok (RL) yang punya alur alasan + persetujuan ambil cadangan. */
  overrideAvailable?: boolean;
}): string {
  const satuan = input.satuan ? ` ${input.satuan}` : '';
  const plans = (input.blockingPlanNos || []).map((n) => String(n || '').trim()).filter(Boolean);
  const planBit = plans.length
    ? ` terkunci di ${plans.slice(0, 3).join(', ')}${plans.length > 3 ? ` (+${plans.length - 3})` : ''}`
    : ' cadangan rencana lain';
  return (
    `${input.label}: stok di ${input.lokasiKode} tidak cukup `
    + `(perlu ${input.need}${satuan}, bebas ${input.usable}${satuan}, `
    + `${input.blocked}${satuan}${planBit}). `
    + (input.overrideAvailable === false
      ? 'Keluarkan lewat Release Stok rencana pemiliknya, atau ajukan Release Stok dengan alasan ambil cadangan.'
      : 'Isi alasan ambil cadangan di baris ini, lalu minta persetujuan supervisor.')
  );
}

/** Label RPN yang mengunci (selain rencana sendiri). */
export function blockingPlanNosFromPool(
  pool: ReservationPool | undefined,
  ownPlanId?: string | null,
): string[] {
  if (!pool?.byPlan.size) return [];
  const out: string[] = [];
  for (const [id, qty] of pool.byPlan) {
    if (!(qty > 0)) continue;
    if (ownPlanId && id === ownPlanId) continue;
    const no = pool.planNoById.get(id) || id.slice(0, 8);
    out.push(no);
  }
  return out;
}

export function sanitizeReservationReason(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 300);
}

/** Alasan override wajib minimal 3 karakter bila baris mengambil cadangan rencana lain. */
export function reservationReasonOk(raw: unknown): boolean {
  return sanitizeReservationReason(raw).length >= 3;
}

type ReserveLot = {
  id: string;
  lotNo?: string;
  productId: string;
  warehouseKode: string;
  qty: number;
  grnId?: string;
  noGRN?: string;
};

/**
 * Kunci lot GRN untuk rencana pemilik PO. Tanpa flag, tanpa noPO, atau rencana
 * sudah selesai/batal: tidak membuat cadangan.
 */
export async function reserveGrnLotsForPlan(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; noPO?: string | null; lots: ReserveLot[] },
): Promise<void> {
  const tid = normalizeTenantId(input.tenantId);
  const noPO = String(input.noPO || '').trim();
  const lots = input.lots.filter((l) => l.id && l.productId && roundStockQty(l.qty) > 0);
  if (!noPO || !lots.length) return;
  if (!(await isTenantFeatureEnabled(db, tid, 'planStockReservation'))) return;

  const po = await db.collection('customer_purchase_orders').findOne(
    { ...tenantIdMatchFilter(tid), noPO },
    { projection: { productionPlanId: 1 }, ...opts(session) },
  );
  const planId = String(po?.productionPlanId || '').trim();
  if (!planId) return;

  // Tulis ke dokumen rencana: penutupan rencana yang bersamaan bentrok di sini dan diulang,
  // sehingga cadangan tidak pernah tercipta untuk rencana yang sudah selesai/batal.
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOneAndUpdate(
    { ...tenantIdMatchFilter(tid), id: planId, status: { $nin: [...CLOSED_PLAN] } },
    { $inc: { reservationSeq: 1 } },
    { projection: { id: 1, noDokumen: 1, status: 1 }, ...opts(session) },
  );
  if (!plan) return;

  const lotIds = lots.map((l) => l.id);
  const existing = await db.collection(STOCK_ALLOCATIONS_COLLECTION).find(
    { tenantId: tid, lotId: { $in: lotIds }, status: 'ACTIVE' },
    { projection: { lotId: 1 }, ...opts(session) },
  ).toArray();
  const taken = new Set(existing.map((r) => String(r.lotId)));
  const now = new Date();
  const docs: StockAllocationDoc[] = [];
  for (const lot of lots) {
    if (taken.has(lot.id)) continue;
    const qty = roundStockQty(lot.qty);
    docs.push({
      id: uuidv4(),
      tenantId: tid,
      productionPlanId: planId,
      productionPlanNo: plan.noDokumen ? String(plan.noDokumen) : undefined,
      productId: lot.productId,
      warehouseKode: lot.warehouseKode,
      lotId: lot.id,
      lotNo: lot.lotNo,
      grnId: lot.grnId,
      noGRN: lot.noGRN,
      noPO,
      qty,
      qtyRemaining: qty,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
  }
  if (docs.length) {
    await db.collection(STOCK_ALLOCATIONS_COLLECTION).insertMany(docs, opts(session));
  }
}

export type ReservationPool = {
  totalReleased: number;
  byPlan: Map<string, number>;
  /** productionPlanId → noDokumen / productionPlanNo untuk pesan UI. */
  planNoById: Map<string, string>;
};

/** Cadangan aktif pada lot yang sudah lolos QC (karantina tetap dihitung lewat guard QC). */
export async function loadReservationPools(
  db: Db,
  tenantId: string,
  pairs: Array<{ productId: string; lokasiKode: string }>,
  session?: ClientSession | null,
): Promise<Map<string, ReservationPool>> {
  const out = new Map<string, ReservationPool>();
  if (!pairs.length) return out;
  const rows = await db.collection<StockAllocationDoc>(STOCK_ALLOCATIONS_COLLECTION).find(
    {
      tenantId,
      status: 'ACTIVE',
      qtyRemaining: { $gt: 0 },
      $or: pairs.map((p) => ({ productId: p.productId, warehouseKode: p.lokasiKode })),
    },
    opts(session),
  ).toArray();
  if (!rows.length) return out;

  const planTanggalById = await loadPlanTanggalById(
    db,
    tenantId,
    rows.map((r) => String(r.productionPlanId)),
    session,
  );
  const asOf = new Date();

  const lots = await db.collection('ingredient_lots').find(
    { tenantId, id: { $in: [...new Set(rows.map((r) => r.lotId))] } },
    { projection: { id: 1, qcStatus: 1, qtyRemaining: 1 }, ...opts(session) },
  ).toArray() as unknown as IngredientLotDoc[];
  const lotById = new Map(lots.map((l) => [l.id, l]));

  for (const row of rows) {
    const planId = String(row.productionPlanId);
    if (!isReservationPlanBlocking(planTanggalById.get(planId), asOf)) continue;
    const lot = lotById.get(row.lotId);
    if (!lot || isLotQcHeld(lot)) continue;
    const lotQty = roundStockQty(lot.qtyRemaining);
    const qty = Math.min(roundStockQty(row.qtyRemaining), lotQty);
    if (!(qty > 0)) continue;
    const key = pairKey(row.productId, row.warehouseKode);
    const pool = out.get(key) || { totalReleased: 0, byPlan: new Map(), planNoById: new Map() };
    pool.totalReleased = roundStockQty(pool.totalReleased + qty);
    pool.byPlan.set(planId, roundStockQty((pool.byPlan.get(planId) || 0) + qty));
    const planNo = String(row.productionPlanNo || '').trim();
    if (planNo && !pool.planNoById.has(planId)) pool.planNoById.set(planId, planNo);
    out.set(key, pool);
  }
  return out;
}

/** Qty cadangan yang tidak boleh diambil baris ini. Override = 0. */
export function reservationBlockedQty(
  pool: ReservationPool | undefined,
  opts: { planId?: string | null; override?: boolean },
): number {
  if (!pool || opts.override) return 0;
  const own = opts.planId ? (pool.byPlan.get(opts.planId) || 0) : 0;
  return Math.max(0, roundStockQty(pool.totalReleased - own));
}

/** Kurangi pool setelah baris memakai sebagian cadangan, agar baris berikutnya melihat sisa. */
export function consumeReservationPool(
  pool: ReservationPool | undefined,
  takenFromReserved: number,
  planId?: string | null,
): void {
  if (!pool || !(takenFromReserved > 0)) return;
  let left = roundStockQty(takenFromReserved);
  pool.totalReleased = Math.max(0, roundStockQty(pool.totalReleased - left));
  if (planId && pool.byPlan.has(planId)) {
    const own = pool.byPlan.get(planId) || 0;
    const use = Math.min(own, left);
    pool.byPlan.set(planId, roundStockQty(own - use));
    left = roundStockQty(left - use);
  }
  if (left > 0) {
    for (const [id, qty] of pool.byPlan) {
      if (!(left > 0)) break;
      const use = Math.min(qty, left);
      pool.byPlan.set(id, roundStockQty(qty - use));
      left = roundStockQty(left - use);
    }
  }
}

export async function loadReservedQtyByOtherPlans(
  db: Db,
  tenantId: string,
  productIds: string[],
  lokasiKode: string,
  excludePlanId?: string | null,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!productIds.length) return out;
  const pools = await loadReservationPools(
    db,
    tenantId,
    productIds.map((productId) => ({ productId, lokasiKode })),
  );
  for (const id of productIds) {
    const blocked = reservationBlockedQty(pools.get(pairKey(id, lokasiKode)), { planId: excludePlanId });
    if (blocked > 0) out.set(id, blocked);
  }
  return out;
}

/**
 * Qty cadangan aktif per lot milik rencana lain (atau semua rencana, bila tanpa planId).
 * Hanya qty ini yang terkunci; sisa lot di atasnya tetap stok bebas, sama seperti guard stok.
 */
export async function reservedQtyByLot(
  db: Db,
  session: ClientSession | null | undefined,
  input: { tenantId: string; lotIds: string[]; planId?: string | null },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!input.lotIds.length) return out;
  const rows = await db.collection<StockAllocationDoc>(STOCK_ALLOCATIONS_COLLECTION).find(
    { tenantId: input.tenantId, lotId: { $in: input.lotIds }, status: 'ACTIVE', qtyRemaining: { $gt: 0 } },
    { projection: { lotId: 1, productionPlanId: 1, qtyRemaining: 1 }, ...opts(session) },
  ).toArray();
  if (!rows.length) return out;
  const planTanggalById = await loadPlanTanggalById(
    db,
    input.tenantId,
    rows.map((r) => String(r.productionPlanId)),
    session,
  );
  const asOf = new Date();
  for (const row of rows) {
    if (input.planId && row.productionPlanId === input.planId) continue;
    const planId = String(row.productionPlanId);
    if (!isReservationPlanBlocking(planTanggalById.get(planId), asOf)) continue;
    out.set(row.lotId, roundStockQty((out.get(row.lotId) || 0) + roundStockQty(row.qtyRemaining)));
  }
  return out;
}

export async function applyAllocationConsumption(
  db: Db,
  session: ClientSession | null | undefined,
  input: { tenantId: string; takes: Array<{ lotId: string; qty: number }>; at: Date },
): Promise<void> {
  for (const take of input.takes) {
    const qty = roundStockQty(take.qty);
    if (!(qty > 0) || !take.lotId) continue;
    const row = await db.collection<StockAllocationDoc>(STOCK_ALLOCATIONS_COLLECTION).findOne(
      { tenantId: input.tenantId, lotId: take.lotId, status: 'ACTIVE' },
      opts(session),
    );
    if (!row) continue;
    const after = Math.max(0, roundStockQty(row.qtyRemaining - qty));
    await db.collection(STOCK_ALLOCATIONS_COLLECTION).updateOne(
      { id: row.id, tenantId: input.tenantId, status: 'ACTIVE' },
      {
        $set: {
          qtyRemaining: after,
          status: isZeroQty(after) ? 'CONSUMED' : 'ACTIVE',
          updatedAt: input.at,
        },
      },
      opts(session),
    );
  }
}

/** Qty lot kembali (vendor menolak retur): buka lagi cadangan yang sempat terpakai, selama belum dilepas rencana. */
export async function applyAllocationRestore(
  db: Db,
  session: ClientSession | null | undefined,
  input: { tenantId: string; takes: Array<{ lotId: string; qty: number }>; at: Date },
): Promise<void> {
  for (const take of input.takes) {
    const qty = roundStockQty(take.qty);
    if (!(qty > 0) || !take.lotId) continue;
    const row = await db.collection<StockAllocationDoc>(STOCK_ALLOCATIONS_COLLECTION).findOne(
      { tenantId: input.tenantId, lotId: take.lotId, status: { $in: ['ACTIVE', 'CONSUMED'] } },
      opts(session),
    );
    if (!row) continue;
    const after = Math.min(roundStockQty(row.qty), roundStockQty(row.qtyRemaining + qty));
    if (!(after > row.qtyRemaining)) continue;
    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      { tenantId: input.tenantId, id: row.productionPlanId },
      { projection: { status: 1 }, ...opts(session) },
    );
    if (!plan || CLOSED_PLAN.has(String(plan.status || ''))) continue;
    await db.collection(STOCK_ALLOCATIONS_COLLECTION).updateOne(
      { id: row.id, tenantId: input.tenantId },
      { $set: { qtyRemaining: after, status: 'ACTIVE', updatedAt: input.at } },
      opts(session),
    );
  }
}

/**
 * Samakan cadangan aktif dengan qty lot yang masih boleh dipakai rencana.
 * Split/tolak QC mengecilkan lot; sisa cadangan di atas qty itu dilepas dari hitungan.
 */
export async function capActiveAllocationTo(
  db: Db,
  session: ClientSession | null | undefined,
  input: { tenantId: string; lotId: string; qty: number; at?: Date },
): Promise<void> {
  const qty = Math.max(0, roundStockQty(input.qty));
  const row = await db.collection<StockAllocationDoc>(STOCK_ALLOCATIONS_COLLECTION).findOne(
    { tenantId: input.tenantId, lotId: input.lotId, status: 'ACTIVE' },
    opts(session),
  );
  if (!row || !(roundStockQty(row.qtyRemaining) > qty)) return;
  await db.collection(STOCK_ALLOCATIONS_COLLECTION).updateOne(
    { id: row.id, tenantId: input.tenantId, status: 'ACTIVE' },
    {
      $set: {
        qtyRemaining: qty,
        qtyQcRejected: roundStockQty(Number(row.qtyRemaining) - qty),
        ...(isZeroQty(qty)
          ? { status: 'RELEASED', releasedReason: 'QC_REJECTED' }
          : { status: 'ACTIVE' }),
        updatedAt: input.at ?? new Date(),
      },
    },
    opts(session),
  );
}

export async function releasePlanReservations(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string | null | undefined; productionPlanId: string; reason: StockAllocationReleaseReason },
): Promise<number> {
  const now = new Date();
  const res = await db.collection(STOCK_ALLOCATIONS_COLLECTION).updateMany(
    { tenantId: normalizeTenantId(input.tenantId), productionPlanId: input.productionPlanId, status: 'ACTIVE' },
    { $set: { status: 'RELEASED', releasedReason: input.reason, updatedAt: now } },
    opts(session),
  );
  return res.modifiedCount;
}

/** Lepas cadangan aktif untuk lot tertentu (mis. GRN asalnya dibalik). */
export async function releaseLotReservations(
  db: Db,
  session: ClientSession | undefined,
  input: { tenantId: string; lotIds: string[]; reason: StockAllocationReleaseReason },
): Promise<number> {
  if (!input.lotIds.length) return 0;
  const res = await db.collection(STOCK_ALLOCATIONS_COLLECTION).updateMany(
    { tenantId: input.tenantId, lotId: { $in: input.lotIds }, status: 'ACTIVE' },
    { $set: { status: 'RELEASED', releasedReason: input.reason, updatedAt: new Date() } },
    opts(session),
  );
  return res.modifiedCount;
}
