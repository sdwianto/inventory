/**
 * Kontrol RL melebihi acuan rencana (Fase 1.3, flag `rlFromPoReference`).
 * Per produk: RL POSTED + PBL bermutasi + qty RL ini dibanding acuan × (1 + toleransi).
 * Baris yang melebihi wajib punya alasan, dan penyetuju harus pengguna lain.
 */

import type { ClientSession, Db } from 'mongodb';
import { withTenantFilter } from '@/lib/api/tenant-master';
import {
  loadPlanReference,
  type PlanReference,
  type PlanReferenceLine,
  type PlanReferenceMrpLine,
  type PlanReferencePlan,
} from '@/lib/food-production/plan-reference';
import { qtyGt, roundQty } from '@/lib/stock-ledger/precision';

type ScopeAuth = Parameters<typeof withTenantFilter>[0];

export const RL_OVER_REASON_MAX_LENGTH = 300;
export const RL_OVER_TOLERANCE_MAX_PCT = 100;
export const RL_OVER_TOLERANCE_SETTING = 'rlOverIssueTolerancePct';

/** Nilai toleransi valid 0..100 (2 desimal); `null` bila bukan angka dalam rentang. */
export function normalizeRlOverIssueTolerancePct(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > RL_OVER_TOLERANCE_MAX_PCT) return null;
  return Math.round(n * 100) / 100;
}

export async function getRlOverIssueTolerancePct(db: Db, tenantId: string): Promise<number> {
  const row = await db.collection('tenant_settings').findOne(
    { tenantId },
    { projection: { [RL_OVER_TOLERANCE_SETTING]: 1 } },
  ) as Record<string, unknown> | null;
  return normalizeRlOverIssueTolerancePct(row?.[RL_OVER_TOLERANCE_SETTING]) ?? 0;
}

export function sanitizeOverReason(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, RL_OVER_REASON_MAX_LENGTH);
}

export interface RlOverIssueInputLine {
  stokId: string;
  qtyBase: number;
  kode?: string;
  nama?: string;
  overReason?: string;
}

export type RlOverIssueSource = PlanReferenceLine['sumber'] | 'DI_LUAR_ACUAN';

export interface RlOverIssueLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  /** Satuan dasar; semua qty baris ini dalam satuan ini. */
  satuan?: string;
  sumber: RlOverIssueSource;
  /** Indeks baris item RL (0-based) yang termasuk produk ini. */
  lineIndexes: number[];
  acuanQty: number;
  /** RL POSTED tertaut + PBL bermutasi stok sebelum RL ini. */
  consumedBefore: number;
  qtyRelease: number;
  qtyAfter: number;
  limitQty: number;
  /** qtyAfter − acuanQty. */
  overQty: number;
  reasons: string[];
  missingReason: boolean;
}

export interface RlOverIssueResult {
  productionPlanId: string;
  tolerancePct: number;
  lines: RlOverIssueLine[];
  overCount: number;
  missingReasonCount: number;
}

/**
 * Cocok hanya lewat id produk / salinan katalog (kode + satuan dasar sama, dari `probeProductIds`).
 * Kode saja tidak cukup: satuan dasar bisa berbeda sehingga qty tidak sebanding.
 */
function indexReference(reference: PlanReference) {
  const byId = new Map<string, PlanReferenceLine>();
  for (const line of reference.lines) {
    for (const id of [...line.productIds, ...(line.aliasProductIds || [])]) byId.set(id, line);
  }
  return (item: RlOverIssueInputLine): PlanReferenceLine | undefined => byId.get(item.stokId);
}

/**
 * Hanya mengembalikan produk yang melebihi batas. Baris RL untuk produk yang sama digabung,
 * produk di luar acuan rencana diperlakukan acuan 0.
 */
export function evaluateRlOverIssue(
  reference: PlanReference,
  items: RlOverIssueInputLine[],
  tolerancePct: number,
): RlOverIssueResult {
  const find = indexReference(reference);
  const factor = 1 + (Math.max(0, tolerancePct) / 100);
  const groups = new Map<string, RlOverIssueLine>();

  items.forEach((item, idx) => {
    const qty = roundQty(Number(item.qtyBase) || 0);
    if (!(qty > 0)) return;
    const ref = find(item);
    const key = ref ? `ref:${ref.productId}:${ref.satuan || ''}` : `id:${item.stokId}`;
    let g = groups.get(key);
    if (!g) {
      const acuanQty = ref?.acuanQty ?? 0;
      const consumedBefore = ref ? roundQty(ref.rlPosted + ref.pblPosted) : 0;
      g = {
        productId: ref?.productId || item.stokId,
        productKode: ref?.productKode || item.kode,
        productNama: ref?.productNama || item.nama,
        satuan: ref?.satuan,
        sumber: ref && ref.sumber !== 'NONE' ? ref.sumber : 'DI_LUAR_ACUAN',
        lineIndexes: [],
        acuanQty,
        consumedBefore,
        qtyRelease: 0,
        qtyAfter: consumedBefore,
        limitQty: roundQty(acuanQty * factor),
        overQty: 0,
        reasons: [],
        missingReason: false,
      };
      groups.set(key, g);
    }
    g.lineIndexes.push(idx);
    g.qtyRelease = roundQty(g.qtyRelease + qty);
    g.qtyAfter = roundQty(g.consumedBefore + g.qtyRelease);
    const reason = sanitizeOverReason(item.overReason);
    if (reason) g.reasons.push(reason);
    else g.missingReason = true;
  });

  const lines = [...groups.values()]
    .filter((g) => qtyGt(g.qtyAfter, g.limitQty))
    .map((g) => ({ ...g, overQty: roundQty(g.qtyAfter - g.acuanQty), reasons: [...new Set(g.reasons)] }));
  return {
    productionPlanId: reference.productionPlanId,
    tolerancePct,
    lines,
    overCount: lines.length,
    missingReasonCount: lines.filter((l) => l.missingReason).length,
  };
}

export async function computeRlOverIssue(
  db: Db,
  scopeAuth: ScopeAuth,
  opts: {
    plan: PlanReferencePlan;
    items: RlOverIssueInputLine[];
    fallbackMrpLines?: PlanReferenceMrpLine[];
    session?: ClientSession;
  },
): Promise<RlOverIssueResult> {
  const [reference, tolerancePct] = await Promise.all([
    loadPlanReference(db, scopeAuth, opts.plan, {
      fallbackMrpLines: opts.fallbackMrpLines,
      session: opts.session,
      probeProductIds: opts.items.map((it) => it.stokId),
    }),
    getRlOverIssueTolerancePct(db, opts.plan.tenantId),
  ]);
  return evaluateRlOverIssue(reference, opts.items, tolerancePct);
}

function fmt(n: number): string {
  return roundQty(n).toLocaleString('id-ID', { maximumFractionDigits: 4 });
}

export function describeRlOverIssueLine(l: RlOverIssueLine): string {
  const sat = l.satuan ? ` ${l.satuan}` : '';
  const name = l.productNama || l.productKode || l.productId;
  if (l.sumber === 'DI_LUAR_ACUAN') {
    return `${name}: ${fmt(l.qtyRelease)}${sat} di luar acuan rencana`;
  }
  return `${name}: total ${fmt(l.qtyAfter)}${sat} > batas ${fmt(l.limitQty)}${sat}`
    + ` (acuan ${l.sumber} ${fmt(l.acuanQty)}, sudah keluar ${fmt(l.consumedBefore)})`;
}

/** Pesan tolak bila ada baris melebihi acuan tanpa alasan. */
export function rlOverIssueMissingReasonMessage(result: RlOverIssueResult): string | null {
  const missing = result.lines.filter((l) => l.missingReason);
  if (!missing.length) return null;
  return `Melebihi acuan rencana (toleransi ${fmt(result.tolerancePct)}%) — isi alasan per baris: `
    + missing.map(describeRlOverIssueLine).join('; ');
}

/** Snapshot ringkas untuk disimpan di dokumen RL / audit. */
export function rlOverIssueSnapshot(result: RlOverIssueResult, checkedAt: Date) {
  return {
    productionPlanId: result.productionPlanId,
    tolerancePct: result.tolerancePct,
    checkedAt,
    lines: result.lines.map((l) => ({
      productId: l.productId,
      productKode: l.productKode,
      productNama: l.productNama,
      satuan: l.satuan,
      sumber: l.sumber,
      acuanQty: l.acuanQty,
      consumedBefore: l.consumedBefore,
      qtyRelease: l.qtyRelease,
      qtyAfter: l.qtyAfter,
      limitQty: l.limitQty,
      overQty: l.overQty,
      reasons: l.reasons,
    })),
  };
}

export type RlOverIssueSnapshot = ReturnType<typeof rlOverIssueSnapshot>;
