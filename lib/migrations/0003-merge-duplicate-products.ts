import type { ClientSession, Db } from 'mongodb';
import type { Migration, MigrationContext } from '@/lib/migrations/types';
import { runInTransactionOnDb, txOpts } from '@/lib/api/transaction';
import { mergeProductStock, roundStockQty, type MergeProductStockResult } from '@/lib/stock-ledger';
import { writeAuditLog } from '@/lib/api/audit-log';
import { updateRecipeWithRevisionInTx, type RecipeWithState } from '@/lib/api/recipe-revisions';
import { isCasConflict } from '@/lib/api/cas';
import { RECIPES_COLLECTION, consolidateRecipeLines, type RecipeLine } from '@/lib/food-production/recipe';
import { normalizeRecipeSatuan } from '@/lib/food-production/recipe-uom';
import { evaluateRecipeLine } from '@/lib/api/recipe-conversion-review';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import {
  buildUomIdMap,
  countActiveDuplicateKode,
  ensureProductKodeUniqueIndex,
  normalizeBaseSatuan,
  refreshCanonicalAktif,
} from '@/lib/api/product-merge';

export const MERGE_DUPLICATE_PRODUCTS_ID = '0003-merge-duplicate-products';

type ProductRow = {
  id: string;
  kode: string;
  nama?: string;
  satuan?: string;
  aktif?: boolean;
  vendorAktif?: boolean;
  syncSource?: string;
  vendorTenantId?: string;
  vendorTenantName?: string;
  gudangKode?: string;
  hargaBeli?: number | string;
  stok?: number | string;
  createdAt?: Date | string;
  mergedInto?: string | null;
} & Record<string, unknown>;

export type MemberActivity = {
  kartu: number;
  stokQty: number;
  lots: number;
  recipes: number;
  releases: number;
  issues: number;
  mrps: number;
  cpos: number;
  grns: number;
};

export type GroupStatus =
  | 'READY'
  | 'NEEDS_DECISION'
  | 'DECISION_INVALID'
  | 'BLOCKED_SATUAN'
  | 'BLOCKED_GUDANG'
  | 'BLOCKED_RESEP'
  | 'MERGED'
  | 'CONFLICT'
  | 'FAILED';

type MemberReport = {
  id: string;
  nama: string;
  vendorTenantId: string | null;
  vendorTenantName: string | null;
  syncSource: string | null;
  aktif: boolean;
  satuan: string;
  gudangKode: string;
  stok: number;
  hargaBeli: number;
  hasActivity: boolean;
  activity: MemberActivity;
};

type RecipeResult = { recipeId: string; kode: string; nama: string; result: 'WOULD_UPDATE' | 'UPDATED' | 'CONFLICT' | 'SKIPPED' | 'BLOCKED'; error?: string };

export type GroupReport = {
  kode: string;
  nama: string;
  status: GroupStatus;
  canonicalId: string | null;
  canonicalBy: 'ACTIVITY' | 'DECISION' | 'DEFAULT' | null;
  reason?: string;
  members: MemberReport[];
  recipes: RecipeResult[];
  moved?: Array<{ fromId: string } & MergeProductStockResult>;
  documents?: Record<string, number>;
  hargaBeli?: { before: number; after: number };
};

/** Referensi produk di array dokumen lapisan persediaan (dokumen pembelian ke vendor sengaja tidak diubah). */
const ARRAY_REFS: Array<{ coll: string; path: string; field: string; uom?: boolean }> = [
  { coll: 'penyesuaian_stok', path: 'items', field: 'stokId', uom: true },
  { coll: 'transfer_stok', path: 'items', field: 'stokId', uom: true },
  { coll: 'transfer_stok', path: 'fefoRelocate', field: 'stokId' },
  { coll: 'transfer_stok', path: 'lotRelocate', field: 'stokId' },
  { coll: 'inventory_releases', path: 'items', field: 'stokId', uom: true },
  { coll: 'inventory_releases', path: 'fefoConsume', field: 'stokId' },
  { coll: 'inventory_releases', path: 'ingredientLotConsume', field: 'stokId' },
  { coll: 'inventory_releases', path: 'overIssue.lines', field: 'productId' },
  { coll: 'putaway_moves', path: 'lines', field: 'stokId' },
  { coll: 'material_issues', path: 'lines', field: 'productId', uom: true },
  { coll: 'material_issues', path: 'fefoConsume', field: 'stokId' },
  { coll: 'material_issues', path: 'shortageOverride.shortageLines', field: 'productId' },
  { coll: 'material_requirements', path: 'lines', field: 'productId' },
  { coll: 'purchase_requirements', path: 'lines', field: 'productId' },
  { coll: 'production_results', path: 'lines', field: 'finishedGoodProductId' },
  { coll: 'distribution_orders', path: 'lines', field: 'finishedGoodProductId' },
  { coll: 'distribution_orders', path: 'fefoConsume', field: 'stokId' },
  { coll: 'distribution_orders', path: 'fefoRestore', field: 'stokId' },
  { coll: 'kitchen_transfers', path: 'lines', field: 'productId' },
];

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Keputusan manual: `{ "KODE": "canonicalId" }` atau `[{ "kode": "...", "canonicalId": "..." }]`. */
export function parseMergeDecisions(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const src = raw && typeof raw === 'object' && 'decisions' in (raw as Record<string, unknown>)
    ? (raw as { decisions: unknown }).decisions
    : raw;
  if (Array.isArray(src)) {
    for (const d of src) {
      const kode = String((d as { kode?: unknown })?.kode || '').trim();
      const id = String((d as { canonicalId?: unknown })?.canonicalId || '').trim();
      if (kode && id) out.set(kode, id);
    }
  } else if (src && typeof src === 'object') {
    for (const [kode, id] of Object.entries(src as Record<string, unknown>)) {
      const k = kode.trim();
      const v = String(id || '').trim();
      if (k && v) out.set(k, v);
    }
  }
  return out;
}

/** Kanonik tanpa aktivitas di grup: yang aktif → master lokal → paling awal dibuat → id. */
export function pickDefaultCanonical<T extends Pick<ProductRow, 'id' | 'aktif' | 'syncSource' | 'createdAt'>>(members: T[]): T {
  return [...members].sort((a, b) => {
    const aa = a.aktif !== false ? 0 : 1;
    const ba = b.aktif !== false ? 0 : 1;
    if (aa !== ba) return aa - ba;
    const al = a.syncSource === 'sales.app' ? 1 : 0;
    const bl = b.syncSource === 'sales.app' ? 1 : 0;
    if (al !== bl) return al - bl;
    const at = a.createdAt ? new Date(a.createdAt).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

export function hasActivity(a: MemberActivity): boolean {
  return a.kartu > 0 || a.stokQty > 0 || a.lots > 0 || a.recipes > 0 || a.releases > 0
    || a.issues > 0 || a.mrps > 0 || a.cpos > 0 || a.grns > 0;
}

/** Hitung dokumen per id produk pada field array (satu dokumen dihitung sekali per id). */
async function countDocsByArrayField(db: Db, coll: string, tenantId: string, path: string, ids: string[]): Promise<Map<string, number>> {
  const rows = await db.collection(coll).aggregate([
    { $match: { tenantId, [path]: { $in: ids } } },
    { $project: { v: `$${path}` } },
    { $unwind: '$v' },
    { $match: { v: { $in: ids } } },
    { $group: { _id: { v: '$v', d: '$_id' } } },
    { $group: { _id: '$_id.v', n: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map((r) => [String(r._id), Number(r.n)]));
}

type StockPlacement = { lokasi: Map<string, Array<{ wh: string; qty: number }>>; lots: Map<string, Array<{ wh: string; qty: number }>>; bins: Map<string, Array<{ wh: string; qty: number }>> };

async function loadActivity(db: Db, tenantId: string, ids: string[]): Promise<{ activity: Map<string, MemberActivity>; placement: StockPlacement }> {
  const [kartu, lokasiRows, lotRows, binRows, recipes, releases, issues, mrps, cpos, grns] = await Promise.all([
    db.collection('stok_kartu').aggregate([
      { $match: { tenantId, stokId: { $in: ids } } },
      { $group: { _id: '$stokId', n: { $sum: 1 } } },
    ]).toArray(),
    db.collection('stok_lokasi').find({ tenantId, stokId: { $in: ids } }).project({ stokId: 1, lokasiKode: 1, qty: 1 }).toArray(),
    db.collection('ingredient_lots').find({ tenantId, productId: { $in: ids } }).project({ productId: 1, warehouseKode: 1, qtyRemaining: 1 }).toArray(),
    db.collection('stok_bin').find({ tenantId, stokId: { $in: ids } }).project({ stokId: 1, warehouseKode: 1, qty: 1 }).toArray(),
    countDocsByArrayField(db, RECIPES_COLLECTION, tenantId, 'lines.productId', ids),
    countDocsByArrayField(db, 'inventory_releases', tenantId, 'items.stokId', ids),
    countDocsByArrayField(db, 'material_issues', tenantId, 'lines.productId', ids),
    countDocsByArrayField(db, 'material_requirements', tenantId, 'lines.productId', ids),
    countDocsByArrayField(db, 'customer_purchase_orders', tenantId, 'items.localStokId', ids),
    countDocsByArrayField(db, 'goods_receipts', tenantId, 'items.localStokId', ids),
  ]);
  const kartuBy = new Map(kartu.map((r) => [String(r._id), Number(r.n)]));
  const placement: StockPlacement = { lokasi: new Map(), lots: new Map(), bins: new Map() };
  const push = (m: Map<string, Array<{ wh: string; qty: number }>>, id: string, wh: string, qty: number) => {
    if (!(qty > 0)) return;
    m.set(id, [...(m.get(id) || []), { wh, qty }]);
  };
  for (const r of lokasiRows) push(placement.lokasi, String(r.stokId), String(r.lokasiKode || ''), roundStockQty(r.qty));
  for (const r of lotRows) push(placement.lots, String(r.productId), String(r.warehouseKode || ''), roundStockQty(r.qtyRemaining));
  for (const r of binRows) push(placement.bins, String(r.stokId), String(r.warehouseKode || ''), roundStockQty(r.qty));
  const lotsBy = new Map<string, number>();
  for (const r of lotRows) lotsBy.set(String(r.productId), (lotsBy.get(String(r.productId)) || 0) + 1);

  const activity = new Map<string, MemberActivity>();
  for (const id of ids) {
    activity.set(id, {
      kartu: kartuBy.get(id) || 0,
      stokQty: roundStockQty((placement.lokasi.get(id) || []).reduce((s, r) => s + r.qty, 0)),
      lots: lotsBy.get(id) || 0,
      recipes: recipes.get(id) || 0,
      releases: releases.get(id) || 0,
      issues: issues.get(id) || 0,
      mrps: mrps.get(id) || 0,
      cpos: cpos.get(id) || 0,
      grns: grns.get(id) || 0,
    });
  }
  return { activity, placement };
}

type RecipePlan = { recipe: RecipeWithState; lines: RecipeLine[]; finishedGoodProductId?: string; error?: string };

/** Baris resep produk sumber → item kanonik; baris yang tersentuh dihitung ulang dengan konversi ketat. */
export function planRecipeMerge(
  recipe: RecipeWithState,
  sourceIds: Set<string>,
  canon: ProductRow,
  uomIdMap: Map<string, string>,
): RecipePlan {
  const touched = new Set<number>();
  const mapped: RecipeLine[] = (recipe.lines || []).map((line) => {
    if (!sourceIds.has(String(line.productId))) return line;
    const next: RecipeLine = { ...line, productId: canon.id, productKode: canon.kode, productNama: canon.nama };
    const uom = line.uomId ? uomIdMap.get(String(line.uomId)) : undefined;
    if (uom) next.uomId = uom;
    else delete next.uomId;
    return next;
  });
  const canonLines = mapped.filter((l) => l.productId === canon.id);
  const satuans = new Set(canonLines.map((l) => normalizeRecipeSatuan(l.satuan)).filter(Boolean));
  if (satuans.size > 1) {
    return {
      recipe,
      lines: recipe.lines || [],
      error: `baris ${canon.kode} memakai satuan dapur berbeda (${[...satuans].join(' vs ')}) — satukan di resep lebih dulu`,
    };
  }
  const lines = canonLines.length > 1 ? consolidateRecipeLines(mapped) : mapped;
  lines.forEach((l, i) => {
    if (l.productId !== canon.id) return;
    const fromSource = (recipe.lines || []).some((o) => sourceIds.has(String(o.productId)));
    if (fromSource) touched.add(i);
  });
  const out = [...lines];
  for (const i of touched) {
    const row = evaluateRecipeLine(recipe, out[i], i, canon as unknown as Parameters<typeof evaluateRecipeLine>[3]);
    if (row.status === 'INVALID') {
      return { recipe, lines: recipe.lines || [], error: `baris ${canon.kode}: ${row.error || 'konversi tidak valid'}` };
    }
    if (row.nextLine) out[i] = row.nextLine;
  }
  const fg = recipe.finishedGoodProductId && sourceIds.has(String(recipe.finishedGoodProductId)) ? canon.id : undefined;
  return { recipe, lines: out, ...(fg ? { finishedGoodProductId: fg } : {}) };
}

async function rewriteArrayRef(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  ref: (typeof ARRAY_REFS)[number],
  fromId: string,
  toId: string,
  uomIdMap: Map<string, string>,
): Promise<number> {
  const { coll, path, field } = ref;
  if (ref.uom) {
    for (const [oldUom, newUom] of uomIdMap) {
      await db.collection(coll).updateMany(
        { tenantId, [path]: { $elemMatch: { [field]: fromId, uomId: oldUom } } },
        { $set: { [`${path}.$[m].uomId`]: newUom } },
        { arrayFilters: [{ [`m.${field}`]: fromId, 'm.uomId': oldUom }], ...txOpts(session) },
      );
    }
  }
  const r = await db.collection(coll).updateMany(
    { tenantId, [`${path}.${field}`]: fromId },
    { $set: { [`${path}.$[m].${field}`]: toId } },
    { arrayFilters: [{ [`m.${field}`]: fromId }], ...txOpts(session) },
  );
  return r.modifiedCount;
}

/** Referensi tunggal/berkunci unik: override rencana, pengecualian porsi, buku harga pemasok, KA, penanda barcode. */
async function rewriteKeyedRefs(
  db: Db,
  session: ClientSession | undefined,
  tenantId: string,
  fromId: string,
  toId: string,
  now: Date,
): Promise<Record<string, number>> {
  const opts = txOpts(session);
  const counts: Record<string, number> = {};

  const plans = await db.collection('production_plans')
    .find({ tenantId, 'materialOverrides.productId': fromId }, opts)
    .project({ id: 1, materialOverrides: 1 })
    .toArray();
  for (const plan of plans) {
    const list = (plan.materialOverrides || []) as Array<{ recipeId?: string; productId?: string }>;
    const keep = new Map<string, Record<string, unknown>>();
    for (const o of list) {
      const productId = o.productId === fromId ? toId : o.productId;
      const key = `${o.recipeId || ''}::${productId || ''}`;
      // Override yang sudah ditulis untuk item kanonik menang atas override salinan vendor.
      if (keep.has(key) && o.productId === fromId) continue;
      keep.set(key, { ...o, productId });
    }
    await db.collection('production_plans').updateOne({ tenantId, id: plan.id }, { $set: { materialOverrides: [...keep.values()] } }, opts);
  }
  counts.production_plans = plans.length;

  const rpeCanon = await db.collection('recipe_portion_exceptions').countDocuments({ tenantId, productId: toId }, opts);
  if (rpeCanon) {
    const del = await db.collection('recipe_portion_exceptions').deleteMany({ tenantId, productId: fromId }, opts);
    counts.recipe_portion_exceptions_dropped = del.deletedCount;
  } else {
    const r = await db.collection('recipe_portion_exceptions').updateMany({ tenantId, productId: fromId }, { $set: { productId: toId, updatedAt: now } }, opts);
    counts.recipe_portion_exceptions = r.modifiedCount;
  }

  const spb = await db.collection('supplier_price_book')
    .find({ tenantId, productId: fromId }, opts)
    .project({ id: 1, supplierId: 1, aktif: 1, effectiveFrom: 1 })
    .toArray();
  let spbDeactivated = 0;
  for (const row of spb) {
    if (row.aktif === true) {
      const other = await db.collection('supplier_price_book').findOne(
        { tenantId, supplierId: row.supplierId, productId: toId, aktif: true },
        { projection: { id: 1, effectiveFrom: 1 }, ...opts },
      );
      if (other) {
        const loserId = String(other.effectiveFrom || '') >= String(row.effectiveFrom || '') ? row.id : other.id;
        await db.collection('supplier_price_book').updateOne({ tenantId, id: loserId }, { $set: { aktif: false, updatedAt: now } }, opts);
        spbDeactivated += 1;
      }
    }
    await db.collection('supplier_price_book').updateOne({ tenantId, id: row.id }, { $set: { productId: toId, updatedAt: now } }, opts);
  }
  counts.supplier_price_book = spb.length;
  if (spbDeactivated) counts.supplier_price_book_deactivated = spbDeactivated;

  const ka = await db.collection('ka_safety_cases').updateMany({ tenantId, productId: fromId }, { $set: { productId: toId } }, opts);
  counts.ka_safety_cases = ka.modifiedCount;
  const alias = await db.collection('material_issues').updateMany(
    { tenantId, 'lines.productIds': fromId },
    { $set: { 'lines.$[l].productIds.$[p]': toId } },
    { arrayFilters: [{ 'l.productIds': fromId }, { p: fromId }], ...opts },
  );
  counts.material_issue_aliases = alias.modifiedCount;
  const bc = await db.collection('products').updateMany({ tenantId, barcodeDuplicateOf: fromId }, { $set: { barcodeDuplicateOf: toId } }, opts);
  counts.products_barcode_ref = bc.modifiedCount;
  return counts;
}

function memberReport(p: ProductRow, a: MemberActivity): MemberReport {
  return {
    id: p.id,
    nama: String(p.nama || ''),
    vendorTenantId: p.vendorTenantId ? String(p.vendorTenantId) : null,
    vendorTenantName: p.vendorTenantName ? String(p.vendorTenantName) : null,
    syncSource: p.syncSource ? String(p.syncSource) : null,
    aktif: p.aktif !== false,
    satuan: normalizeBaseSatuan(p.satuan),
    gudangKode: resolveProductGudangKode(p),
    stok: roundStockQty(p.stok),
    hargaBeli: Math.round(num(p.hargaBeli)),
    hasActivity: hasActivity(a),
    activity: a,
  };
}

type GroupPlan = {
  report: GroupReport;
  members: ProductRow[];
  canon?: ProductRow;
  sources: ProductRow[];
};

function classifyGroup(
  kode: string,
  members: ProductRow[],
  activity: Map<string, MemberActivity>,
  placement: StockPlacement,
  decisions: Map<string, string>,
): GroupPlan {
  const reports = members.map((m) => memberReport(m, activity.get(m.id)!));
  const base: GroupReport = {
    kode,
    nama: String(members.find((m) => m.aktif !== false)?.nama || members[0]?.nama || ''),
    status: 'READY',
    canonicalId: null,
    canonicalBy: null,
    members: reports,
    recipes: [],
  };
  const plan = (report: GroupReport, canon?: ProductRow): GroupPlan => ({
    report,
    members,
    canon,
    sources: canon ? members.filter((m) => m.id !== canon.id) : [],
  });

  const satuans = new Set(members.map((m) => normalizeBaseSatuan(m.satuan)).filter(Boolean));
  if (satuans.size > 1) {
    return plan({
      ...base,
      status: 'BLOCKED_SATUAN',
      reason: `Satuan dasar berbeda (${[...satuans].join(', ')}) — samakan satuan dasar master di sales.app, lalu jalankan ulang`,
    });
  }

  const decided = decisions.get(kode);
  let canon: ProductRow | undefined;
  let by: GroupReport['canonicalBy'] = null;
  if (decided) {
    canon = members.find((m) => m.id === decided);
    if (!canon) {
      return plan({ ...base, status: 'DECISION_INVALID', reason: `canonicalId ${decided} bukan anggota kode ${kode}` });
    }
    by = 'DECISION';
  } else {
    const active = members.filter((m) => reports.find((r) => r.id === m.id)?.hasActivity);
    if (active.length > 1) {
      return plan({
        ...base,
        status: 'NEEDS_DECISION',
        reason: `${active.length} produk sama-sama punya aktivitas — pilih produk kanonik di file keputusan (--decisions)`,
      });
    }
    canon = active[0] || pickDefaultCanonical(members);
    by = active.length ? 'ACTIVITY' : 'DEFAULT';
  }

  const home = resolveProductGudangKode(canon);
  for (const src of members) {
    if (src.id === canon.id) continue;
    const places = [
      ...(placement.lokasi.get(src.id) || []),
      ...(placement.lots.get(src.id) || []),
      ...(placement.bins.get(src.id) || []),
    ];
    const other = places.find((p) => p.wh && p.wh !== home);
    if (other) {
      return plan({
        ...base,
        canonicalId: canon.id,
        canonicalBy: by,
        status: 'BLOCKED_GUDANG',
        reason: `Stok ${src.id} ada di gudang ${other.wh}, item kanonik di ${home} — pindahkan stok (transfer) atau pilih kanonik lain`,
      }, canon);
    }
  }
  return plan({ ...base, canonicalId: canon.id, canonicalBy: by }, canon);
}

async function loadRecipesTouching(db: Db, tenantId: string, ids: string[]): Promise<RecipeWithState[]> {
  if (!ids.length) return [];
  return db.collection(RECIPES_COLLECTION)
    .find({ tenantId, $or: [{ 'lines.productId': { $in: ids } }, { finishedGoodProductId: { $in: ids } }] })
    .project({ _id: 0 })
    .toArray() as unknown as Promise<RecipeWithState[]>;
}

async function planRecipesForGroup(
  db: Db,
  tenantId: string,
  g: GroupPlan,
  uomMaps: Map<string, Map<string, string>>,
): Promise<RecipePlan[]> {
  if (!g.canon) return [];
  const sourceIds = new Set(g.sources.map((s) => s.id));
  const merged = new Map<string, string>();
  for (const m of uomMaps.values()) for (const [k, v] of m) merged.set(k, v);
  const recipes = await loadRecipesTouching(db, tenantId, [...sourceIds]);
  return recipes.map((r) => planRecipeMerge(r, sourceIds, g.canon!, merged));
}

function weightedHargaBeli(members: ProductRow[], canon: ProductRow, activity: Map<string, MemberActivity>): number {
  let qty = 0;
  let value = 0;
  for (const m of members) {
    const q = activity.get(m.id)?.stokQty || 0;
    const h = num(m.hargaBeli);
    if (q > 0 && h > 0) {
      qty += q;
      value += q * h;
    }
  }
  if (qty > 0) return Math.round(value / qty);
  const own = Math.round(num(canon.hargaBeli));
  if (own > 0) return own;
  return Math.round(Math.max(0, ...members.map((m) => num(m.hargaBeli))));
}

async function applyGroup(
  ctx: MigrationContext,
  g: GroupPlan,
  activity: Map<string, MemberActivity>,
  actor: { userId: string; userName: string },
): Promise<void> {
  const { db, tenantId, now } = ctx;
  const canon = g.canon!;
  const ids = g.members.map((m) => m.id);
  const fresh = await db.collection('products')
    .find({ tenantId, id: { $in: ids } })
    .project({ id: 1, mergedInto: 1 })
    .toArray();
  if (fresh.length !== ids.length || fresh.some((p) => p.mergedInto)) {
    g.report.status = 'CONFLICT';
    g.report.reason = 'Produk grup berubah sejak laporan dibuat — jalankan ulang';
    return;
  }

  const uomsBy = await listProductUomsByProductIds(db, tenantId, ids);
  const canonUoms = uomsBy.get(canon.id) || [];
  const uomMaps = new Map(g.sources.map((s) => [s.id, buildUomIdMap(uomsBy.get(s.id) || [], canonUoms)]));

  const recipePlans = await planRecipesForGroup(db, tenantId, g, uomMaps);
  const blocked = recipePlans.filter((p) => p.error);
  if (blocked.length) {
    g.report.status = 'BLOCKED_RESEP';
    g.report.reason = blocked.map((b) => `${b.recipe.kode}: ${b.error}`).join('; ');
    g.report.recipes = blocked.map((b) => ({ recipeId: b.recipe.id, kode: String(b.recipe.kode || ''), nama: String(b.recipe.nama || ''), result: 'BLOCKED', error: b.error }));
    return;
  }
  const hargaAfter = weightedHargaBeli(g.members, canon, activity);
  const moved: Array<{ fromId: string } & MergeProductStockResult> = [];
  const documents: Record<string, number> = {};
  let conflictRecipe: RecipePlan['recipe'] | null = null;
  const txError = await runInTransactionOnDb(db, async ({ db: txDb, session }) => {
    const opts = txOpts(session);
    moved.length = 0;
    for (const k of Object.keys(documents)) delete documents[k];
    for (const p of recipePlans) {
      conflictRecipe = p.recipe;
      await updateRecipeWithRevisionInTx(
        txDb,
        session,
        p.recipe,
        { lines: p.lines, ...(p.finishedGoodProductId ? { finishedGoodProductId: p.finishedGoodProductId } : {}), updatedAt: now },
        {
          reason: 'PRODUCT_MERGE',
          actor,
          now,
          audit: (revisions) => ({
            tenantId,
            action: 'PRODUCT_MERGE',
            entityType: 'recipe',
            entityId: p.recipe.id,
            summary: `Resep ${p.recipe.kode}: bahan kode ${g.report.kode} dipindah ke item persediaan ${canon.id}`,
            metadata: {
              migration: MERGE_DUPLICATE_PRODUCTS_ID,
              kode: g.report.kode,
              canonicalId: canon.id,
              sourceIds: g.sources.map((s) => s.id),
              revisions: revisions.map((r) => ({ id: r.id, revision: r.revision, reason: r.reason })),
            },
            ...actor,
          }),
        },
      );
    }
    conflictRecipe = null;
    for (const src of g.sources) {
      const uomIdMap = uomMaps.get(src.id) || new Map();
      const res = await mergeProductStock(txDb, session, { tenantId, fromId: src.id, toId: canon.id, uomIdMap, now });
      moved.push({ fromId: src.id, ...res });
      for (const ref of ARRAY_REFS) {
        const n = await rewriteArrayRef(txDb, session, tenantId, ref, src.id, canon.id, uomIdMap);
        if (n) documents[`${ref.coll}.${ref.path}`] = (documents[`${ref.coll}.${ref.path}`] || 0) + n;
      }
      const keyed = await rewriteKeyedRefs(txDb, session, tenantId, src.id, canon.id, now);
      for (const [k, n] of Object.entries(keyed)) if (n) documents[k] = (documents[k] || 0) + n;

      const upd = await txDb.collection('products').updateOne(
        { tenantId, id: src.id, mergedInto: null },
        {
          $set: {
            mergedInto: canon.id,
            mergedAt: now,
            mergedBy: actor.userName,
            mergeSource: 'MIGRATION_0003',
            ...(src.syncSource === 'sales.app' ? { vendorAktif: src.vendorAktif ?? (src.aktif !== false) } : {}),
            updatedAt: now,
          },
        },
        opts,
      );
      if (upd.matchedCount !== 1) throw new Error(`Produk ${src.id} berubah saat migrasi`);
      await txDb.collection('products').updateMany({ tenantId, mergedInto: src.id }, { $set: { mergedInto: canon.id, updatedAt: now } }, opts);
    }
    await txDb.collection('products').updateOne(
      { tenantId, id: canon.id, mergedInto: null },
      {
        $set: {
          hargaBeli: hargaAfter,
          ...(canon.syncSource === 'sales.app' ? { vendorAktif: canon.vendorAktif ?? (canon.aktif !== false) } : {}),
          updatedAt: now,
        },
      },
      opts,
    );
    await refreshCanonicalAktif(txDb, tenantId, [canon.id], session);
    await writeAuditLog(txDb, {
      tenantId,
      action: 'PRODUCT_MERGE',
      entityType: 'product',
      entityId: canon.id,
      summary: `Kode ${g.report.kode}: ${g.sources.length} salinan digabung ke item persediaan ${canon.id}`,
      metadata: {
        migration: MERGE_DUPLICATE_PRODUCTS_ID,
        kode: g.report.kode,
        canonicalBy: g.report.canonicalBy,
        sources: g.sources.map((s) => ({ id: s.id, vendorTenantId: s.vendorTenantId || null, stok: roundStockQty(s.stok), hargaBeli: num(s.hargaBeli) })),
        hargaBeli: { before: num(canon.hargaBeli), after: hargaAfter },
        moved,
        documents,
      },
      ...actor,
    }, session);
  }).then(() => null, (e: unknown) => e);
  if (txError) {
    if (!isCasConflict(txError) || !conflictRecipe) throw txError;
    const r = conflictRecipe as RecipePlan['recipe'];
    g.report.status = 'CONFLICT';
    g.report.reason = `Resep ${r.kode} diubah pengguna saat migrasi — jalankan ulang`;
    g.report.recipes = recipePlans.map((p) => ({
      recipeId: p.recipe.id,
      kode: String(p.recipe.kode || ''),
      nama: String(p.recipe.nama || ''),
      result: p.recipe.id === r.id ? 'CONFLICT' : 'SKIPPED',
    }));
    return;
  }
  g.report.recipes = recipePlans.map((p) => ({
    recipeId: p.recipe.id,
    kode: String(p.recipe.kode || ''),
    nama: String(p.recipe.nama || ''),
    result: 'UPDATED',
  }));
  g.report.status = 'MERGED';
  g.report.moved = moved;
  g.report.documents = documents;
  g.report.hargaBeli = { before: Math.round(num(canon.hargaBeli)), after: hargaAfter };
}

/**
 * Gabung kode produk ganda ke satu item persediaan per kode. Produk lain di kode yang sama menjadi
 * sumber vendor (`mergedInto`), stok/lot/kartu/resep/dokumen persediaan dipindah dalam transaksi,
 * lalu index unik kode aktif dibuat bila tidak ada kode ganda tersisa. Aman dijalankan ulang (--force)
 * setelah keputusan manual (--decisions) atau perbaikan master.
 */
export const mergeDuplicateProductsMigration: Migration = {
  id: MERGE_DUPLICATE_PRODUCTS_ID,
  description: 'Gabung kode produk ganda ke satu item persediaan (sumber vendor mergedInto) + index unik kode aktif',
  async run(ctx) {
    const { db, tenantId } = ctx;
    const actorName = ctx.actor || 'system';
    const actor = { userId: `migration:${actorName}`, userName: `Migrasi (${actorName})` };
    const decisions = parseMergeDecisions(ctx.options?.decisions);

    const products = await db.collection('products')
      .find({ tenantId, mergedInto: null, kode: { $gt: '' } })
      .project({ _id: 0 })
      .toArray() as unknown as ProductRow[];
    const byKode = new Map<string, ProductRow[]>();
    for (const p of products) byKode.set(p.kode, [...(byKode.get(p.kode) || []), p]);
    const groups = [...byKode.entries()].filter(([, list]) => list.length > 1).sort(([a], [b]) => a.localeCompare(b));
    const memberIds = groups.flatMap(([, list]) => list.map((p) => p.id));

    const chainFix = await db.collection('products').aggregate([
      { $match: { tenantId, mergedInto: { $type: 'string' } } },
      { $lookup: { from: 'products', let: { t: '$mergedInto' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$id', '$$t'] }, { $eq: ['$tenantId', tenantId] }] } } }, { $project: { mergedInto: 1 } }], as: 'target' } },
      { $match: { 'target.0.mergedInto': { $type: 'string' } } },
      { $project: { id: 1, mergedInto: 1, finalTarget: { $arrayElemAt: ['$target.mergedInto', 0] } } },
    ]).toArray();

    const kodeMismatch = await db.collection('products').aggregate([
      { $match: { tenantId, mergedInto: { $type: 'string' } } },
      { $lookup: { from: 'products', let: { t: '$mergedInto' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$id', '$$t'] }, { $eq: ['$tenantId', tenantId] }] } } }, { $project: { kode: 1 } }], as: 'target' } },
      { $project: { _id: 0, id: 1, kode: 1, vendorTenantId: 1, mergedInto: 1, canonicalKode: { $arrayElemAt: ['$target.kode', 0] } } },
      { $match: { $expr: { $ne: ['$kode', '$canonicalKode'] } } },
    ]).toArray();

    const before = {
      products: products.length,
      duplicateKodeGroups: groups.length,
      activeDuplicateKode: await countActiveDuplicateKode(db, tenantId),
      mergedChains: chainFix.length,
      mergedKodeMismatch: kodeMismatch.length,
      decisions: decisions.size,
    };

    const { activity, placement } = memberIds.length
      ? await loadActivity(db, tenantId, memberIds)
      : { activity: new Map<string, MemberActivity>(), placement: { lokasi: new Map(), lots: new Map(), bins: new Map() } as StockPlacement };
    const plans = groups.map(([kode, list]) => classifyGroup(kode, list, activity, placement, decisions));

    for (const g of plans) {
      if (g.report.status !== 'READY' || !g.canon) continue;
      if (ctx.dryRun) {
        const uomsBy = await listProductUomsByProductIds(db, tenantId, g.members.map((m) => m.id));
        const canonUoms = uomsBy.get(g.canon.id) || [];
        const uomMaps = new Map(g.sources.map((s) => [s.id, buildUomIdMap(uomsBy.get(s.id) || [], canonUoms)]));
        const recipePlans = await planRecipesForGroup(db, tenantId, g, uomMaps);
        g.report.recipes = recipePlans.map((p) => ({
          recipeId: p.recipe.id,
          kode: String(p.recipe.kode || ''),
          nama: String(p.recipe.nama || ''),
          result: p.error ? 'BLOCKED' : 'WOULD_UPDATE',
          ...(p.error ? { error: p.error } : {}),
        }));
        const blocked = recipePlans.filter((p) => p.error);
        if (blocked.length) {
          g.report.status = 'BLOCKED_RESEP';
          g.report.reason = blocked.map((b) => `${b.recipe.kode}: ${b.error}`).join('; ');
        }
        continue;
      }
      try {
        await applyGroup(ctx, g, activity, actor);
      } catch (e) {
        g.report.status = 'FAILED';
        g.report.reason = e instanceof Error ? e.message : String(e);
      }
    }

    let chainsFixed = 0;
    if (!ctx.dryRun) {
      for (const c of chainFix) {
        const r = await db.collection('products').updateOne(
          { tenantId, id: c.id, mergedInto: c.mergedInto },
          { $set: { mergedInto: c.finalTarget, updatedAt: ctx.now } },
        );
        chainsFixed += r.modifiedCount;
      }
    }

    const merged = plans.filter((g) => g.report.status === 'MERGED');
    let index: { created: boolean; error?: string } = { created: false };
    const remaining = await countActiveDuplicateKode(db, tenantId);
    if (!ctx.dryRun) {
      if (merged.length) await invalidateDashboardSnapshot(db, tenantId);
      if (remaining === 0) {
        const res = await ensureProductKodeUniqueIndex(db);
        index = res.ok ? { created: true } : { created: false, error: res.error };
      } else {
        index = { created: false, error: `${remaining} kode ganda aktif tersisa di tenant ini` };
      }
    }

    const countBy = (s: GroupStatus) => plans.filter((g) => g.report.status === s).length;
    const statusCounts = Object.fromEntries(
      (['READY', 'MERGED', 'NEEDS_DECISION', 'DECISION_INVALID', 'BLOCKED_SATUAN', 'BLOCKED_GUDANG', 'BLOCKED_RESEP', 'CONFLICT', 'FAILED'] as GroupStatus[])
        .map((s) => [s, countBy(s)])
        .filter(([, n]) => Number(n) > 0),
    );
    const manual = plans.filter((g) => ['NEEDS_DECISION', 'DECISION_INVALID', 'BLOCKED_SATUAN', 'BLOCKED_GUDANG', 'BLOCKED_RESEP', 'CONFLICT', 'FAILED'].includes(g.report.status));
    const verbReady = ctx.dryRun ? `${countBy('READY')} siap digabung` : `${countBy('MERGED')} digabung`;
    return {
      summary: `${groups.length} kode ganda: ${verbReady}, ${manual.length} perlu keputusan/perbaikan`
        + `; kode ganda aktif ${before.activeDuplicateKode} → ${ctx.dryRun ? `(dry-run)` : remaining}`
        + (ctx.dryRun ? '' : `; index unik kode ${index.created ? 'aktif' : `belum dibuat (${index.error})`}`)
        + (manual.length ? ' — isi file keputusan lalu jalankan ulang dengan --force' : ''),
      before,
      after: {
        statusCounts,
        activeDuplicateKode: ctx.dryRun ? null : remaining,
        uniqueIndex: ctx.dryRun ? null : index,
        chainsFixed: ctx.dryRun ? 0 : chainsFixed,
        decisionTemplate: Object.fromEntries(
          manual
            .filter((g) => g.report.status === 'NEEDS_DECISION' || g.report.status === 'DECISION_INVALID')
            .map((g) => [g.report.kode, g.report.members.filter((m) => m.hasActivity).map((m) => m.id).join(' | ')]),
        ),
        manual: manual.map((g) => g.report),
        // Salinan vendor yang kodenya berbeda dari item kanoniknya (rename kode di sales.app belum tuntas).
        mergedKodeMismatch: kodeMismatch,
        groups: plans.map((g) => g.report),
      },
      changed: merged.length + chainsFixed,
    };
  },
};
