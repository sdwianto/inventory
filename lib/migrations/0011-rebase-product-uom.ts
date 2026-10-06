import type { ClientSession, Db } from 'mongodb';
import type { Migration } from '@/lib/migrations/types';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { productDenormFromBaseUom } from '@/lib/api/product-uom';
import { refreshProductsMasterStock } from '@/lib/stock-ledger/master';
import { ceilProcurementQty } from '@/lib/food-production/material-requirement';
import { normalizeRecipeSatuan, RECIPE_CUT_SATUAN } from '@/lib/food-production/recipe-uom';
import { recipeContentHash, recipeRevisionContent } from '@/lib/food-production/recipe-revision';
import type { RecipeLine } from '@/lib/food-production/recipe';
import { PRODUCT_UOM_COLLECTION, type ProductUom } from '@/lib/uom/types';

export const REBASE_PRODUCT_UOM_ID = '0011-rebase-product-uom';

/**
 * Satuan dasar `from` diganti satuan kemasan `to` yang sudah ada (1 `to` = `factor` `from`).
 * Semua qty satuan dasar dibagi `factor`, harga/biaya per satuan dasar dikali `factor`.
 */
export type RebaseSpec = { kode: string; from: string; to: string; factor: number; recipeCut: boolean };

/** Tempe/tahu dibeli per ALIR/BAK, dipotong di resep (sebelumnya basis PTG). */
export const DEFAULT_REBASE_SPECS: RebaseSpec[] = [
  { kode: 'B824159', from: 'PTG', to: 'ALIR', factor: 20, recipeCut: true },
  { kode: 'B509689', from: 'PTG', to: 'BAK', factor: 32, recipeCut: true },
];

const STOCK_DP = 4;
const QTY_DP = 6;

const CPO_FINAL = new Set(['CANCELLED', 'REJECTED', 'INVOICED', 'CLOSED', 'RECEIVED', 'COMPLETED']);
const GRN_FINAL = new Set(['POSTED', 'REVERSED', 'CANCELLED']);
const POSTING_FINAL = new Set(['POSTED', 'CANCELLED', 'REJECTED', 'REVERSED', 'VOID']);
const PBL_FINAL = new Set(['COMPLETED', 'CANCELLED']);

function norm(s: unknown): string {
  return normalizeRecipeSatuan(String(s ?? ''));
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(n: number, dp: number): number {
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}

function has(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
}

export function parseRebaseSpecs(raw: unknown): RebaseSpec[] | { error: string } {
  if (raw == null) return DEFAULT_REBASE_SPECS;
  const list = Array.isArray(raw) ? raw : (raw as { rebase?: unknown }).rebase;
  if (!Array.isArray(list) || !list.length) return { error: 'Spesifikasi rebase kosong' };
  const out: RebaseSpec[] = [];
  for (const r of list as Array<Record<string, unknown>>) {
    const kode = String(r.kode || '').trim();
    const from = norm(r.from);
    const to = norm(r.to);
    const factor = Number(r.factor);
    if (!kode || !from || !to || from === to) return { error: `Spesifikasi ${kode || '?'}: kode/from/to wajib dan berbeda` };
    if (!Number.isInteger(factor) || factor < 2) return { error: `Spesifikasi ${kode}: factor harus bilangan bulat ≥ 2` };
    out.push({ kode, from, to, factor, recipeCut: r.recipeCut !== false });
  }
  return out;
}

type Ctx = { ids: Set<string>; spec: RebaseSpec; blockers: string[]; label: string };

/** qty basis lama → baru. Kolom stok wajib habis dibagi pada presisi stok. */
function divStock(v: unknown, c: Ctx, where: string): number {
  const raw = num(v) / c.spec.factor;
  const r = round(raw, STOCK_DP);
  if (Math.abs(raw - r) > 1e-9) c.blockers.push(`${where}: ${num(v)} ${c.spec.from} tidak habis dibagi ${c.spec.factor}`);
  return r;
}

function div(v: unknown, c: Ctx): number {
  return round(num(v) / c.spec.factor, QTY_DP);
}

function mul(v: unknown, c: Ctx): number {
  return round(num(v) * c.spec.factor, 4);
}

type Scale = { stock?: string[]; qty?: string[]; cost?: string[]; satuan?: string[] };

function scaleObject<T extends Record<string, unknown>>(obj: T, scale: Scale, c: Ctx, where: string): T {
  const out: Record<string, unknown> = { ...obj };
  for (const f of scale.stock || []) if (has(out[f])) out[f] = divStock(out[f], c, `${where}.${f}`);
  for (const f of scale.qty || []) if (has(out[f])) out[f] = div(out[f], c);
  for (const f of scale.cost || []) if (has(out[f])) out[f] = mul(out[f], c);
  for (const f of scale.satuan || []) if (out[f] != null) out[f] = c.spec.to;
  return out as T;
}

export type LineEra = 'OLD' | 'NEW' | 'UNKNOWN';

/**
 * Baris dokumen stok/pembelian: OLD = qty basis masih satuan lama, NEW = sudah satuan baru
 * (dibuat setelah sync satuan dari sales.app). Dibedakan dari satuan entri vs rasio qty basis.
 */
export function classifyLineEra(
  line: Record<string, unknown>,
  spec: Pick<RebaseSpec, 'from' | 'to' | 'factor'>,
  base: unknown,
  entered: unknown,
): LineEra {
  const satuan = norm(line.satuan);
  if (satuan === spec.from) return 'OLD';
  if (satuan !== spec.to) return 'UNKNOWN';
  if (has(line.factorToBase)) {
    const fb = num(line.factorToBase);
    if (fb === spec.factor) return 'OLD';
    if (fb === 1) return 'NEW';
  }
  const b = num(base);
  const e = num(entered);
  if (b > 0 && e > 0) {
    if (Math.abs(b / e - spec.factor) < 1e-6) return 'OLD';
    if (Math.abs(b / e - 1) < 1e-6) return 'NEW';
  }
  return 'UNKNOWN';
}

/**
 * Baris resep: satuan dapur lama `from` → POTONG (n potong per `to`), qty dapur tetap.
 * null = baris bukan produk ini atau sudah berbasis `to`.
 */
export function rebaseRecipeLine(line: RecipeLine, spec: RebaseSpec): RecipeLine | null {
  if (norm(line.baseSatuan) === spec.to) return null;
  const kitchen = norm(line.satuan || line.baseSatuan || spec.from);
  const baseBesar = has(line.qtyBaseBesar) ? num(line.qtyBaseBesar) : num(line.qtyBesar);
  const baseKecil = has(line.qtyBaseKecil) ? num(line.qtyBaseKecil) : num(line.qtyKecil);
  const f = spec.factor;
  const q = (n: number) => round(n / f, QTY_DP);
  if (kitchen === spec.from && spec.recipeCut) {
    return {
      ...line,
      satuan: RECIPE_CUT_SATUAN,
      uomId: undefined,
      potongPerBase: f,
      qtyBaseBesar: q(baseBesar),
      qtyBaseKecil: q(baseKecil),
      factorToBase: round(1 / f, 12),
      baseSatuan: spec.to,
      factorSource: 'CUT',
    };
  }
  if (kitchen === spec.to) {
    return {
      ...line,
      qtyBaseBesar: num(line.qtyBesar),
      qtyBaseKecil: num(line.qtyKecil),
      factorToBase: 1,
      baseSatuan: spec.to,
      factorSource: 'IDENTITY',
    };
  }
  const factor = has(line.factorToBase) ? num(line.factorToBase) : 1;
  return {
    ...line,
    qtyBaseBesar: q(baseBesar),
    qtyBaseKecil: q(baseKecil),
    factorToBase: round(factor / f, 12),
    baseSatuan: spec.to,
  };
}

type ProductRow = Record<string, unknown> & { id: string; kode?: string; satuan?: string };

type ProductPlan = {
  spec: RebaseSpec;
  product: ProductRow;
  state: 'TODO' | 'DONE';
  blockers: string[];
  notes: string[];
  uoms: ProductUom[];
  baseRowId: string | null;
};

type Write = { coll: string; filter: Record<string, unknown>; set: Record<string, unknown>; unset?: string[] };

type Plan = {
  products: ProductPlan[];
  writes: Write[];
  counts: Record<string, number>;
  blockers: string[];
};

/** Salinan dokumen setelah `$set` (mendukung kunci bertitik seperti `summary.x`). */
function applySet(doc: Record<string, unknown>, set: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...doc };
  for (const [k, v] of Object.entries(set)) {
    const parts = k.split('.');
    let o = out;
    for (const p of parts.slice(0, -1)) {
      const next = o[p] && typeof o[p] === 'object' ? { ...(o[p] as Record<string, unknown>) } : {};
      o[p] = next;
      o = next;
    }
    o[parts[parts.length - 1]] = v;
  }
  return out;
}

function getPath(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), doc);
}

const ALLOC_SCALE: Scale = { stock: ['qty'] };
const CONSUME_SCALE: Scale = { stock: ['needQty', 'allocated', 'shortfall', 'qty'] };

/** Baris array dokumen yang menyimpan qty satuan dasar produk. */
type ArrayRef = {
  coll: string;
  path: string;
  keys: string[];
  scale: Scale;
  nested?: Array<{ path: string; scale: Scale }>;
  /** Cek era baris: qty basis dan qty entri. */
  era?: { base: string; entered: string; stockCritical: boolean };
  /** Baris berlabel satuan dasar: label `to` berarti sudah dikonversi. */
  labelEra?: boolean;
  openGuard?: (doc: Record<string, unknown>, line: Record<string, unknown>, spec: RebaseSpec) => string | null;
  /** Hitung ulang qty pengadaan setelah dibagi (dokumen aktif). */
  ceil?: { fields: string[]; activeStatuses: Set<string> | 'NOT_CANCELLED' };
  summary?: Array<[summaryField: string, lineField: string]>;
};

const ARRAY_REFS: ArrayRef[] = [
  {
    coll: 'goods_receipts', path: 'items', keys: ['localStokId', 'stockProductId'],
    scale: { stock: ['qtyBase', 'qtyReceivedBase', 'qtyRejectedBase'], qty: ['factorToBase'], cost: ['hargaBeliBaru'] },
    era: { base: 'qtyReceivedBase', entered: 'qtyReceived', stockCritical: true },
    openGuard: (doc) => (GRN_FINAL.has(String(doc.status)) ? null : `GRN ${doc.noGRN || doc.id} masih ${doc.status}`),
  },
  ...['customer_purchase_orders', 'local_purchase_orders'].map((coll): ArrayRef => ({
    coll, path: 'items', keys: ['localStokId'],
    scale: { qty: ['factorToBase', 'qtyBase', 'qtyReceivedBase', 'qtyShippedBase'], cost: ['hargaBeliReferensi'] },
    era: { base: 'qtyBase', entered: 'qty', stockCritical: false },
    openGuard: (doc, line, spec) => {
      if (CPO_FINAL.has(String(doc.status)) || line.cancelled === true) return null;
      return norm(line.satuan) === spec.from
        ? `PO ${doc.noPO || doc.id} (${doc.status}) masih memesan ${line.qty} ${spec.from} — ubah ke ${spec.to} atau batalkan dulu`
        : null;
    },
  })),
  {
    coll: 'inventory_releases', path: 'items', keys: ['stokId'],
    scale: { stock: ['qtyBase'], cost: ['hargaBeli'] },
    era: { base: 'qtyBase', entered: 'qtyEntered', stockCritical: true },
    openGuard: (doc) => (POSTING_FINAL.has(String(doc.status)) ? null : `RL ${doc.noRelease || doc.id} masih ${doc.status}`),
  },
  { coll: 'inventory_releases', path: 'fefoConsume', keys: ['stokId'], scale: CONSUME_SCALE, nested: [{ path: 'allocations', scale: ALLOC_SCALE }] },
  { coll: 'inventory_releases', path: 'ingredientLotConsume', keys: ['stokId'], scale: CONSUME_SCALE, nested: [{ path: 'allocations', scale: ALLOC_SCALE }] },
  {
    coll: 'inventory_releases', path: 'overIssue.lines', keys: ['productId'], labelEra: true,
    scale: { qty: ['acuanQty', 'consumedBefore', 'qtyRelease', 'qtyAfter', 'limitQty', 'overQty'], satuan: ['satuan'] },
  },
  {
    coll: 'transfer_stok', path: 'items', keys: ['stokId'],
    scale: { stock: ['qtyBase'], cost: ['hargaBeli'] },
    openGuard: (doc) => (POSTING_FINAL.has(String(doc.status)) ? null : `Transfer ${doc.noTransfer || doc.id} masih ${doc.status}`),
  },
  { coll: 'transfer_stok', path: 'fefoRelocate', keys: ['stokId'], scale: CONSUME_SCALE, nested: [{ path: 'allocations', scale: ALLOC_SCALE }] },
  { coll: 'transfer_stok', path: 'lotRelocate', keys: ['stokId'], scale: CONSUME_SCALE, nested: [{ path: 'allocations', scale: ALLOC_SCALE }] },
  {
    coll: 'penyesuaian_stok', path: 'items', keys: ['stokId'],
    scale: { stock: ['qtySistem', 'qtyAktual', 'selisih', 'qtySistemPosting', 'qtyBefore', 'qtyAfter'], cost: ['hargaBeli', 'hargaSatuan', 'unitCost'] },
    openGuard: (doc) => (POSTING_FINAL.has(String(doc.status)) ? null : `Penyesuaian ${doc.noDokumen || doc.id} masih ${doc.status}`),
  },
  {
    coll: 'putaway_moves', path: 'lines', keys: ['stokId'], scale: { stock: ['qtyBase', 'qty'] },
    openGuard: (doc) => (!doc.status || POSTING_FINAL.has(String(doc.status)) ? null : `Putaway ${doc.id} masih ${doc.status}`),
  },
  {
    coll: 'vendor_returns', path: 'items', keys: ['stokId', 'localStokId'],
    scale: { stock: ['qtyBase'], qty: ['factorToBase'], cost: ['hargaBeli'] },
    openGuard: (doc) => (POSTING_FINAL.has(String(doc.status)) ? null : `Retur ${doc.noRetur || doc.id} masih ${doc.status}`),
  },
  { coll: 'stock_reversals', path: 'lines', keys: ['stokId'], scale: { stock: ['deltaQtyBase'], cost: ['unitCost'] } },
  {
    coll: 'material_issues', path: 'lines', keys: ['productId'], labelEra: true,
    scale: {
      qty: ['qtyPlanned', 'qtyIssued', 'acuanQty', 'poQtyOrdered', 'poQtyReceived', 'rlPosted', 'pblPosted', 'sisa', 'qtyGross', 'qtyNet'],
      satuan: ['satuan'],
    },
    openGuard: (doc) => (PBL_FINAL.has(String(doc.status)) ? null : `PBL ${doc.noDokumen || doc.id} masih ${doc.status}`),
    summary: [['qtyPlannedTotal', 'qtyPlanned'], ['qtyIssuedTotal', 'qtyIssued'], ['sisaTotal', 'sisa']],
  },
  { coll: 'material_issues', path: 'fefoConsume', keys: ['stokId'], scale: CONSUME_SCALE, nested: [{ path: 'allocations', scale: ALLOC_SCALE }] },
  {
    coll: 'material_issues', path: 'shortageOverride.shortageLines', keys: ['productId'], labelEra: true,
    scale: { qty: ['qtyGross', 'qtyOnHand', 'qtyNet', 'poQtyOrdered', 'poQtyReceived'], satuan: ['satuan'] },
  },
  {
    coll: 'material_requirements', path: 'lines', keys: ['productId'], labelEra: true,
    scale: { qty: ['qtyGross', 'qtyOnHand', 'qtyNet', 'poQtyOrdered', 'poQtyReceived'], satuan: ['satuan'] },
    nested: [{ path: 'sources', scale: { qty: ['qty'] } }],
    ceil: { fields: ['qtyGross', 'qtyNet'], activeStatuses: 'NOT_CANCELLED' },
    summary: [['qtyGrossTotal', 'qtyGross'], ['qtyNetTotal', 'qtyNet']],
  },
  {
    coll: 'purchase_requirements', path: 'lines', keys: ['productId'], labelEra: true,
    scale: { qty: ['qtyNet', 'qtyGross', 'qtyOnHand'], satuan: ['satuan'] },
    ceil: { fields: ['qtyNet', 'qtyGross'], activeStatuses: 'NOT_CANCELLED' },
    summary: [['qtyNetTotal', 'qtyNet'], ['qtyGrossTotal', 'qtyGross']],
  },
  {
    coll: 'production_plans', path: 'materialOverrides', keys: ['productId'], labelEra: true,
    scale: { qty: ['qty'], satuan: ['satuan'] },
  },
  { coll: 'kitchen_transfers', path: 'lines', keys: ['productId'], scale: { stock: ['qty'] } },
  { coll: 'kitchen_transfers', path: 'fefoRelocate', keys: ['stokId'], scale: CONSUME_SCALE, nested: [{ path: 'allocations', scale: ALLOC_SCALE }] },
];

/** Dokumen satu-produk (kunci di level dokumen). */
const DOC_REFS: Array<{ coll: string; key: string; scale: Scale; nested?: Array<{ path: string; scale: Scale }>; era?: 'KARTU' | 'LOT' }> = [
  { coll: 'stok_lokasi', key: 'stokId', scale: { stock: ['qty', 'qtyReserved'] } },
  { coll: 'stok_bin', key: 'stokId', scale: { stock: ['qty'] } },
  {
    coll: 'stok_kartu', key: 'stokId', era: 'KARTU',
    scale: { stock: ['masuk', 'keluar'], cost: ['hargaSatuan'] },
    nested: [
      { path: 'ingredientLotAllocations', scale: ALLOC_SCALE },
      { path: 'fefoAllocations', scale: ALLOC_SCALE },
      { path: 'binTakes', scale: ALLOC_SCALE },
    ],
  },
  { coll: 'ingredient_lots', key: 'productId', era: 'LOT', scale: { stock: ['qty', 'qtyRemaining'], cost: ['unitCost', 'hargaSatuan'], satuan: ['satuan'] } },
  { coll: 'stock_allocations', key: 'productId', scale: { stock: ['qty', 'qtyRemaining'] } },
  {
    coll: 'lot_inspections', key: 'productId', era: 'LOT',
    scale: { stock: ['qtyInspected', 'qtyPassed', 'qtyFailed', 'qtyRejected', 'qtyHold'], satuan: ['satuan'] },
  },
  { coll: 'supplier_price_book', key: 'productId', scale: { satuan: ['satuan'] } },
];

function scaleNested(obj: Record<string, unknown>, nested: ArrayRef['nested'], c: Ctx, where: string): Record<string, unknown> {
  if (!nested) return obj;
  const out = { ...obj };
  for (const n of nested) {
    const arr = out[n.path];
    if (Array.isArray(arr)) out[n.path] = arr.map((x, i) => scaleObject(x as Record<string, unknown>, n.scale, c, `${where}.${n.path}[${i}]`));
  }
  return out;
}

async function loadProducts(db: Db, tenantId: string, specs: RebaseSpec[], session?: ClientSession) {
  const rows = await db.collection('products')
    .find({ tenantId, kode: { $in: specs.map((s) => s.kode) } }, txOpts(session))
    .toArray() as unknown as ProductRow[];
  const uoms = await db.collection(PRODUCT_UOM_COLLECTION)
    .find({ tenantId, productId: { $in: rows.map((r) => r.id) } }, txOpts(session))
    .toArray() as unknown as ProductUom[];
  return { rows, uoms };
}

function planProduct(spec: RebaseSpec, product: ProductRow, uoms: ProductUom[]): ProductPlan {
  const blockers: string[] = [];
  const label = `${product.kode} (${product.id.slice(0, 8)})`;
  const markers = Array.isArray(product.uomRebase) ? product.uomRebase as Array<Record<string, unknown>> : [];
  if (markers.some((m) => norm(m.from) === spec.from && norm(m.to) === spec.to)) {
    return { spec, product, state: 'DONE', blockers, notes: [], uoms, baseRowId: null };
  }
  const satuan = norm(product.satuan);
  const pending = product.uomRebasePending as { from?: string; to?: string } | undefined;
  if (pending?.from && (norm(pending.from) !== spec.from || norm(pending.to) !== spec.to)) {
    blockers.push(`${label}: tanda sync ${pending.from} → ${pending.to} tidak cocok dengan spesifikasi ${spec.from} → ${spec.to}`);
  }
  const active = uoms.filter((u) => u.aktif !== false);
  const toRow = active.find((u) => norm(u.satuan) === spec.to);
  if (satuan !== spec.from && satuan !== spec.to) {
    blockers.push(`${label}: satuan dasar ${satuan || '-'} bukan ${spec.from}/${spec.to}`);
  } else if (!toRow) {
    blockers.push(`${label}: baris satuan ${spec.to} tidak ada di product_uom`);
  } else if (satuan === spec.from && num(toRow.factorToBase) !== spec.factor) {
    blockers.push(`${label}: faktor ${spec.to} = ${toRow.factorToBase} ${spec.from}, spesifikasi ${spec.factor}`);
  } else if (satuan === spec.to && !(toRow.isBase && num(toRow.factorToBase) === 1)) {
    blockers.push(`${label}: satuan dasar ${spec.to} tetapi baris UOM-nya bukan basis faktor 1`);
  }
  if (satuan === spec.from) {
    for (const u of active) {
      const s = norm(u.satuan);
      if (s === spec.from || s === spec.to) continue;
      if (num(u.factorToBase) % spec.factor !== 0) {
        blockers.push(`${label}: satuan ${u.satuan} (faktor ${u.factorToBase}) tidak habis dibagi ${spec.factor}`);
      }
    }
  }
  return { spec, product, state: 'TODO', blockers, notes: [], uoms, baseRowId: toRow?.id ?? null };
}

async function buildPlan(db: Db, tenantId: string, specs: RebaseSpec[], now: Date, session?: ClientSession): Promise<Plan> {
  const { rows, uoms } = await loadProducts(db, tenantId, specs, session);
  const products: ProductPlan[] = [];
  for (const spec of specs) {
    for (const p of rows.filter((r) => String(r.kode) === spec.kode)) {
      products.push(planProduct(spec, p, uoms.filter((u) => u.productId === p.id)));
    }
  }
  const writes: Write[] = [];
  const counts: Record<string, number> = {};
  const bump = (k: string) => { counts[k] = (counts[k] || 0) + 1; };
  // Satu dokumen bisa memuat beberapa produk yang di-rebase (resep tahu+tempe, MRP, GRN):
  // produk berikutnya harus membaca hasil produk sebelumnya, dan semuanya jadi satu $set.
  const overlay = new Map<string, { doc: Record<string, unknown>; write: Write }>();
  const docKey = (coll: string, d: Record<string, unknown>) => `${coll}|${String(d._id)}`;
  const current = (coll: string, d: Record<string, unknown>) => overlay.get(docKey(coll, d))?.doc ?? d;
  const pushDocWrite = (coll: string, d: Record<string, unknown>, set: Record<string, unknown>) => {
    const key = docKey(coll, d);
    const hit = overlay.get(key);
    const doc = applySet(hit?.doc ?? d, set);
    if (hit) {
      Object.assign(hit.write.set, set);
      hit.doc = doc;
      return;
    }
    const write: Write = { coll, filter: { tenantId, _id: d._id }, set: { ...set } };
    writes.push(write);
    overlay.set(key, { doc, write });
    bump(coll);
  };

  for (const pp of products.filter((x) => x.state === 'TODO')) {
    const { spec, product } = pp;
    const ids = new Set([product.id]);
    const c: Ctx = { ids, spec, blockers: pp.blockers, label: `${product.kode}` };
    const fromBase = norm(product.satuan) === spec.from;

    // products + product_uom
    const set: Record<string, unknown> = { updatedAt: now };
    if (has(product.minStok)) set.minStok = div(product.minStok, c);
    // Tanpa riwayat kartu, hargaBeli hanya isian manual yang satuannya tidak pasti — tidak diubah.
    const hasLedger = await db.collection('stok_kartu').countDocuments({ tenantId, stokId: product.id }, { limit: 1, ...txOpts(session) }) > 0;
    if (hasLedger) {
      if (has(product.hargaBeli)) set.hargaBeli = Math.round(num(product.hargaBeli) * spec.factor);
      if (has(product.avgCost)) set.avgCost = mul(product.avgCost, c);
    } else if (num(product.hargaBeli) > 0) {
      pp.notes.push(`${product.kode}: hargaBeli ${product.hargaBeli} tidak diubah (tanpa riwayat kartu) — pastikan sudah per ${spec.to}`);
    }
    if (fromBase) {
      for (const f of ['recipeBaseGrams', 'recipeBaseMl', 'isiPerKemasan']) if (has(product[f]) && num(product[f]) > 0) set[f] = mul(product[f], c);
    }
    if (spec.recipeCut) set.recipeCutEnabled = true;
    const toRow = pp.uoms.find((u) => u.id === pp.baseRowId);
    if (toRow) Object.assign(set, productDenormFromBaseUom({ ...toRow, isBase: true, factorToBase: 1 }));
    writes.push({
      coll: 'products',
      filter: { tenantId, id: product.id },
      set: {
        ...set,
        uomRebase: [
          ...(Array.isArray(product.uomRebase) ? product.uomRebase as unknown[] : []),
          { from: spec.from, to: spec.to, factor: spec.factor, migration: REBASE_PRODUCT_UOM_ID, at: now },
        ],
      },
      unset: ['uomRebasePending'],
    });
    bump('products');
    if (fromBase) {
      for (const u of pp.uoms.filter((x) => x.aktif !== false)) {
        const s = norm(u.satuan);
        const uset: Record<string, unknown> = s === spec.to
          ? { isBase: true, factorToBase: 1 }
          : s === spec.from
            ? { isBase: false, aktif: false, factorToBase: round(1 / spec.factor, 12) }
            : { factorToBase: num(u.factorToBase) / spec.factor };
        writes.push({ coll: PRODUCT_UOM_COLLECTION, filter: { tenantId, id: u.id }, set: { ...uset, updatedAt: now } });
        bump(PRODUCT_UOM_COLLECTION);
      }
    }

    // dokumen satu-produk
    for (const ref of DOC_REFS) {
      const docs = await db.collection(ref.coll).find({ tenantId, [ref.key]: product.id }, txOpts(session)).toArray();
      for (const raw of docs as Array<Record<string, unknown>>) {
        const d = current(ref.coll, raw);
        const where = `${ref.coll}:${d.id || d._id}`;
        if (ref.era === 'KARTU') {
          const qty = num(d.masuk) || num(d.keluar);
          const era = classifyLineEra(d, spec, qty, d.qtyEntered);
          if (era === 'NEW') { pp.blockers.push(`${where}: mutasi sudah dalam ${spec.to} (setelah sync) — konversi manual`); continue; }
          if (era === 'UNKNOWN' && qty !== 0) { pp.blockers.push(`${where}: satuan ${d.satuan || '-'} / qtyEntered tidak bisa dipastikan`); continue; }
        }
        if (ref.era === 'LOT') {
          const s = norm(d.satuan);
          if (s === spec.to) { pp.blockers.push(`${where}: sudah berlabel ${spec.to} (setelah sync) — konversi manual`); continue; }
        }
        const scaled = scaleNested(scaleObject(d, ref.scale, c, where), ref.nested, c, where);
        const docSet: Record<string, unknown> = {};
        for (const f of [...(ref.scale.stock || []), ...(ref.scale.qty || []), ...(ref.scale.cost || []), ...(ref.scale.satuan || [])]) {
          if (scaled[f] !== d[f]) docSet[f] = scaled[f];
        }
        for (const n of ref.nested || []) if (Array.isArray(d[n.path])) docSet[n.path] = scaled[n.path];
        if (ref.coll === 'ingredient_lots' && norm(d.satuan) !== spec.to && d.satuan != null && d.satuanLegacy == null) {
          docSet.satuanLegacy = d.satuan;
        }
        if (Object.keys(docSet).length) pushDocWrite(ref.coll, d, docSet);
      }
    }

    // dokumen berbaris
    for (const ref of ARRAY_REFS) {
      const filter = { tenantId, $or: ref.keys.map((k) => ({ [`${ref.path}.${k}`]: product.id })) };
      const docs = await db.collection(ref.coll).find(filter, txOpts(session)).toArray();
      for (const raw of docs as Array<Record<string, unknown>>) {
        const d = current(ref.coll, raw);
        const arr = getPath(d, ref.path);
        if (!Array.isArray(arr)) continue;
        const where = `${ref.coll}:${d.noDokumen || d.noPO || d.noGRN || d.noRelease || d.id}`;
        const status = String(d.status || '');
        let touched = false;
        const deltas = new Map<string, number>();
        const next = (arr as Array<Record<string, unknown>>).map((line, i) => {
          if (!ref.keys.some((k) => ids.has(String(line[k] || '')))) return line;
          const guard = ref.openGuard?.(d, line, spec);
          if (guard) { pp.blockers.push(guard); return line; }
          if (ref.labelEra && norm(line.satuan) === spec.to) return line;
          if (ref.era) {
            const era = classifyLineEra(line, spec, line[ref.era.base], line[ref.era.entered]);
            if (era === 'NEW') {
              if (ref.era.stockCritical) pp.blockers.push(`${where}[${i}]: baris sudah dalam ${spec.to} (setelah sync) — konversi manual`);
              return line;
            }
            if (era === 'UNKNOWN') {
              const hasBase = [...(ref.scale.stock || []), ...(ref.scale.qty || [])].some((f) => has(line[f]));
              if (hasBase) pp.blockers.push(`${where}[${i}]: era baris tidak bisa dipastikan (satuan ${line.satuan || '-'})`);
              return line;
            }
          }
          let out = scaleNested(scaleObject(line, ref.scale, c, `${where}[${i}]`), ref.nested, c, `${where}[${i}]`);
          if (ref.ceil && (ref.ceil.activeStatuses === 'NOT_CANCELLED' ? status !== 'CANCELLED' : ref.ceil.activeStatuses.has(status))) {
            const ceiled: Record<string, unknown> = { ...out };
            for (const f of ref.ceil.fields) if (has(ceiled[f])) ceiled[f] = ceilProcurementQty(num(ceiled[f]), spec.to);
            out = ceiled;
          }
          if (ref.coll === 'material_requirements' || ref.coll === 'purchase_requirements') {
            const { packCount: _p, procurementPackMl: _m, procurementPackLabel: _l, ...rest } = out;
            out = rest;
          }
          for (const [, lf] of ref.summary || []) {
            if (has(line[lf])) deltas.set(lf, (deltas.get(lf) || 0) + num(out[lf]) - num(line[lf]));
          }
          touched = true;
          return out;
        });
        if (!touched) continue;
        const set: Record<string, unknown> = { [ref.path]: next };
        const summary = d.summary as Record<string, unknown> | undefined;
        if (summary && ref.summary) {
          for (const [sf, lf] of ref.summary) {
            if (has(summary[sf]) && deltas.has(lf)) set[`summary.${sf}`] = round(num(summary[sf]) + (deltas.get(lf) || 0), QTY_DP);
          }
        }
        pushDocWrite(ref.coll, d, set);
      }
    }

    // resep + revisi
    for (const coll of ['recipes', 'recipe_revisions']) {
      const docs = await db.collection(coll).find({ tenantId, 'lines.productId': product.id }, txOpts(session)).toArray();
      for (const raw of docs as Array<Record<string, unknown>>) {
        const d = current(coll, raw);
        let touched = false;
        const lines = (d.lines as RecipeLine[]).map((l) => {
          if (l.productId !== product.id) return l;
          const r = rebaseRecipeLine(l, spec);
          if (!r) return l;
          touched = true;
          return r;
        });
        if (!touched) continue;
        const set: Record<string, unknown> = { lines };
        if (coll === 'recipe_revisions') set.contentHash = recipeContentHash(recipeRevisionContent({ ...d, lines } as never));
        pushDocWrite(coll, d, set);
      }
    }

    // dokumen yang belum ditangani otomatis
    for (const [coll, filter, msg] of [
      ['hutang', { tenantId, 'creditNotes.items.stokId': product.id }, 'nota kredit hutang'],
      ['grn_reversals', { tenantId, 'items.localStokId': product.id }, 'pembalikan GRN'],
    ] as Array<[string, Record<string, unknown>, string]>) {
      const n = await db.collection(coll).countDocuments(filter, txOpts(session));
      if (n) pp.blockers.push(`${product.kode}: ${n} ${msg} memuat produk ini — perlu konversi manual`);
    }
  }

  // revisionHash resep ikut revisi terkini yang dikonversi
  const revHash = new Map<string, string>();
  for (const w of writes) if (w.coll === 'recipe_revisions' && typeof w.set.contentHash === 'string') revHash.set(String(w.filter._id), w.set.contentHash);
  if (revHash.size) {
    const revs = await db.collection('recipe_revisions')
      .find({ tenantId, _id: { $in: writes.filter((w) => w.coll === 'recipe_revisions').map((w) => w.filter._id) as never[] } }, { projection: { _id: 1, id: 1 }, ...txOpts(session) })
      .toArray();
    const hashById = new Map(revs.map((r) => [String(r.id), revHash.get(String(r._id))!]));
    const recipes = await db.collection('recipes')
      .find({ tenantId, currentRevisionId: { $in: [...hashById.keys()] } }, { projection: { _id: 1, currentRevisionId: 1 }, ...txOpts(session) })
      .toArray();
    for (const r of recipes) {
      const h = hashById.get(String(r.currentRevisionId));
      if (!h) continue;
      const w = writes.find((x) => x.coll === 'recipes' && String(x.filter._id) === String(r._id));
      if (w) w.set.revisionHash = h;
      else writes.push({ coll: 'recipes', filter: { tenantId, _id: r._id }, set: { revisionHash: h } });
    }
  }

  const blockers = [...new Set(products.flatMap((p) => p.blockers))];
  return { products, writes, counts, blockers };
}

function describePlan(plan: Plan) {
  return {
    products: plan.products.map((p) => ({
      kode: p.product.kode,
      id: p.product.id,
      nama: p.product.nama,
      satuan: p.product.satuan,
      rebase: `${p.spec.from} → ${p.spec.to} (÷${p.spec.factor})`,
      state: p.state,
      stok: p.product.stok,
      hargaBeli: p.product.hargaBeli,
      avgCost: p.product.avgCost,
      blockers: p.blockers,
      notes: p.notes,
    })),
    counts: plan.counts,
    blockers: plan.blockers,
    sample: plan.writes.slice(0, 60).map((w) => ({ coll: w.coll, filter: String(w.filter.id || w.filter._id), set: w.set })),
  };
}

/**
 * Ganti satuan dasar produk (mis. Tempe PTG → ALIR, Tahu PTG → BAK) sambil mengonversi semua qty
 * basis (stok, kartu, lot, reservasi, GRN, RL, MRP, resep, …) dan biaya per basis. Dijalankan
 * setelah satuan dasar di master sales.app diubah; mutasi yang sudah dalam satuan baru menolak migrasi.
 * Satu transaksi + audit. Idempoten lewat penanda `products.uomRebase`.
 */
export const rebaseProductUomMigration: Migration = {
  id: REBASE_PRODUCT_UOM_ID,
  description: 'Ganti satuan dasar produk ke satuan kemasan (Tempe PTG→ALIR, Tahu PTG→BAK) + konversi seluruh qty basis',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actor = ctx.actor || 'system';
    const specs = parseRebaseSpecs(ctx.options?.decisions);
    if ('error' in specs) throw new Error(specs.error);
    const plan = await buildPlan(db, tenantId, specs, ctx.now);
    const before = describePlan(plan);
    const todo = plan.products.filter((p) => p.state === 'TODO').length;
    if (ctx.dryRun || !todo) {
      return {
        summary: plan.blockers.length
          ? `${todo} produk perlu rebase, DIBLOKIR ${plan.blockers.length} hal`
          : `${todo} produk akan di-rebase, ${plan.writes.length} dokumen berubah`,
        before,
        after: null,
        changed: 0,
      };
    }
    if (plan.blockers.length) {
      throw new Error(`Rebase diblokir: ${plan.blockers.slice(0, 10).join(' | ')}`);
    }
    const applied = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
      const fresh = await buildPlan(txDb, tenantId, specs, ctx.now, session);
      if (fresh.blockers.length) throw new Error(`Rebase diblokir: ${fresh.blockers.slice(0, 10).join(' | ')}`);
      let changed = 0;
      for (const w of fresh.writes) {
        const update = w.unset?.length
          ? { $set: w.set, $unset: Object.fromEntries(w.unset.map((f) => [f, ''])) }
          : { $set: w.set };
        const r = await txDb.collection(w.coll).updateOne(w.filter, update, txOpts(session));
        changed += r.modifiedCount;
      }
      await writeAuditLog(txDb, {
        tenantId,
        action: 'PRODUCT_UOM_REBASE',
        entityType: 'tenant',
        entityId: tenantId,
        summary: `Rebase satuan dasar: ${fresh.products.filter((p) => p.state === 'TODO').map((p) => `${p.product.kode} ${p.spec.from}→${p.spec.to}`).join(', ')}`,
        metadata: { migration: REBASE_PRODUCT_UOM_ID, counts: fresh.counts, specs },
        userId: `migration:${actor}`,
        userName: `Migrasi (${actor})`,
      }, session);
      return { changed, counts: fresh.counts, productIds: fresh.products.filter((p) => p.state === 'TODO').map((p) => p.product.id) };
    });
    await refreshProductsMasterStock(db, tenantId, applied.productIds);
    const remaining = await buildPlan(db, tenantId, specs, ctx.now);
    return {
      summary: `${applied.productIds.length} produk di-rebase, ${applied.changed} dokumen berubah`,
      before,
      after: { ...applied, remainingTodo: remaining.products.filter((p) => p.state === 'TODO').length },
      changed: applied.changed,
    };
  },
};
