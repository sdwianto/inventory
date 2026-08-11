/**
 * Exception-driven attention surface — ADR-002 P1.
 * Reads owner domains; returns only items that need attention (not OK inventory).
 */

import type { Db } from 'mongodb';
import {
  TEMPERATURE_LOGS_COLLECTION,
  TEMP_STAGE_LABELS,
  type TemperatureLogDoc,
} from '@/lib/food-production/temperature-log';
import { QC_RESULTS_COLLECTION } from '@/lib/food-production/qc';
import {
  HACCP_RESULTS_COLLECTION,
  haccpDispositionMongoFilter,
} from '@/lib/food-production/haccp';
import { MAINTENANCE_SCHEDULES_COLLECTION } from '@/lib/maintenance/constants';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveQtyRemaining,
} from '@/lib/food-production/production-batch';
import {
  INGREDIENT_LOTS_COLLECTION,
  effectiveIngredientQtyRemaining,
} from '@/lib/food-production/ingredient-lot';
import { MATERIAL_ISSUES_COLLECTION } from '@/lib/food-production/material-issue';
import { DISTRIBUTION_ORDERS_COLLECTION } from '@/lib/food-production/distribution';
import { PRODUCTION_RESULTS_COLLECTION } from '@/lib/food-production/production-result';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import { KA_FOLLOW_UPS_COLLECTION } from '@/lib/kitchen-assurance/follow-up';
import { KA_OBSERVATIONS_COLLECTION } from '@/lib/kitchen-assurance/observation';
import { assetIdsForKitchen } from '@/lib/kitchen-assurance/kitchen-assets';
import {
  KA_PILLARS,
  KA_PILLAR_LABELS,
  toPillar,
  type KaPillar,
} from '@/lib/kitchen-assurance/categories';

export type KaAttentionLevel = 'ATTENTION' | 'CRITICAL';

export interface KaAttentionItem {
  key: string;
  pillar: KaPillar;
  level: KaAttentionLevel;
  label: string;
  detail?: string;
  href?: string;
  source: 'FOOD_PRODUCTION' | 'MAINTENANCE' | 'KITCHEN_ASSURANCE';
  kitchenId?: string;
}

export type KaPillarTraffic = 'GREEN' | 'YELLOW' | 'RED';

export interface KaKitchenStatusPillar {
  pillar: KaPillar;
  label: string;
  traffic: KaPillarTraffic;
  attentionCount: number;
  items: KaAttentionItem[];
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function isScheduleDue(nextDueDate: unknown, today: string): boolean {
  if (!nextDueDate) return false;
  const due = String(nextDueDate).slice(0, 10);
  return due <= today;
}

function isScheduleDueSoon(nextDueDate: unknown, leadDays: number, today: string): boolean {
  if (!nextDueDate || leadDays <= 0) return false;
  const due = new Date(String(nextDueDate).slice(0, 10) + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return false;
  const diff = (due.getTime() - t.getTime()) / (24 * 3600 * 1000);
  return diff > 0 && diff <= leadDays;
}

export async function collectAttentions(
  db: Db,
  scope: { tenantId: string; kitchenId?: string },
): Promise<KaAttentionItem[]> {
  const { tenantId, kitchenId } = scope;
  const out: KaAttentionItem[] = [];
  const today = todayYmd();

  // ── Food: Cold Chain (latest per kitchen+stage; only WARN+) ──
  const tempFilter: Record<string, unknown> = {
    tenantId,
    alertStatus: { $in: ['WARN', 'OUT_OF_RANGE', 'CRITICAL'] },
  };
  if (kitchenId) tempFilter.kitchenId = kitchenId;

  const tempLogs = await db
    .collection(TEMPERATURE_LOGS_COLLECTION)
    .find(tempFilter)
    .sort({ recordedAt: -1 })
    .limit(80)
    .toArray() as unknown as TemperatureLogDoc[];

  const seenTemp = new Set<string>();
  for (const log of tempLogs) {
    const bucket = `${log.kitchenId || 'all'}:${log.stage}`;
    if (seenTemp.has(bucket)) continue;
    seenTemp.add(bucket);
    const critical = log.alertStatus === 'CRITICAL' || log.alertStatus === 'OUT_OF_RANGE';
    out.push({
      key: `temp:${bucket}`,
      pillar: 'FOOD',
      level: critical ? 'CRITICAL' : 'ATTENTION',
      label: `${TEMP_STAGE_LABELS[log.stage] || log.stage}${log.kitchenNama ? ` · ${log.kitchenNama}` : ''}`,
      detail: `${log.suhuC}°C (${log.alertStatus})`,
      href: '/food-production/cold-chain',
      source: 'FOOD_PRODUCTION',
      kitchenId: log.kitchenId,
    });
  }

  // ── Food: QC FAIL findings ──
  const qcFilter: Record<string, unknown> = {
    tenantId,
    'summary.failCount': { $gt: 0 },
  };
  if (kitchenId) qcFilter.kitchenId = kitchenId;
  const qcRows = await db
    .collection(QC_RESULTS_COLLECTION)
    .find(qcFilter)
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  for (const row of qcRows) {
    const r = row as Record<string, unknown>;
    const summary = (r.summary || {}) as { failCount?: number };
    const fails = Number(summary.failCount || 0);
    if (fails <= 0) continue;
    out.push({
      key: `qc:${String(r.id)}`,
      pillar: 'FOOD',
      level: fails >= 2 ? 'CRITICAL' : 'ATTENTION',
      label: `QC finding · ${String(r.noDokumen || r.id)}`,
      detail: `${fails} temuan FAIL`,
      href: '/food-production/qc',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Food: Expired production batches ──
  const batchFilter: Record<string, unknown> = {
    tenantId,
    $or: [
      { status: 'EXPIRED' },
      { status: 'ACTIVE', expiryDate: { $lt: today } },
    ],
  };
  if (kitchenId) batchFilter.kitchenId = kitchenId;
  const expiredBatches = await db
    .collection(PRODUCTION_BATCHES_COLLECTION)
    .find(batchFilter)
    .sort({ expiryDate: 1 })
    .limit(20)
    .toArray();
  for (const row of expiredBatches) {
    const r = row as Record<string, unknown>;
    const rem = effectiveQtyRemaining({
      qty: Number(r.qty || 0),
      qtyRemaining: r.qtyRemaining as number | undefined,
      status: String(r.status || 'ACTIVE') as 'ACTIVE' | 'EXPIRED' | 'CONSUMED',
    });
    out.push({
      key: `batch-exp:${String(r.id)}`,
      pillar: 'FOOD',
      level: 'CRITICAL',
      label: `Expired material · ${String(r.batchNo || r.id)}`,
      detail: rem > 0
        ? `Expiry ${String(r.expiryDate || '').slice(0, 10)} · remaining ${rem}`
        : `Expiry ${String(r.expiryDate || '').slice(0, 10)}`,
      href: '/food-production/batch',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Food: Expired / expiring ingredient lots (W2-5) ──
  const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const ingredientLots = await db
    .collection(INGREDIENT_LOTS_COLLECTION)
    .find({
      tenantId,
      status: { $in: ['ACTIVE', 'EXPIRED'] },
      expiryDate: { $lte: soon },
    })
    .sort({ expiryDate: 1 })
    .limit(20)
    .toArray();
  for (const row of ingredientLots) {
    const r = row as Record<string, unknown>;
    const rem = effectiveIngredientQtyRemaining({
      qty: Number(r.qty || 0),
      qtyRemaining: r.qtyRemaining as number | undefined,
      status: String(r.status || 'ACTIVE') as 'ACTIVE' | 'EXPIRED' | 'CONSUMED',
    });
    if (!(rem > 0)) continue;
    const exp = String(r.expiryDate || '').slice(0, 10);
    const past = exp < today;
    out.push({
      key: `ilot-exp:${String(r.id)}`,
      pillar: 'FOOD',
      level: past ? 'CRITICAL' : 'ATTENTION',
      label: `${past ? 'Expired' : 'Expiring'} ingredient · ${String(r.lotNo || r.productKode || r.id)}`,
      detail: `${String(r.productNama || r.productKode || '')} · expiry ${exp} · remaining ${rem}`,
      href: '/penerimaan',
      source: 'FOOD_PRODUCTION',
    });
  }

  // ── Food: Issue FEFO shortfall (W2-9) ──
  const issueSfFilter: Record<string, unknown> = {
    tenantId,
    status: 'COMPLETED',
    fefoConsume: {
      $elemMatch: {
        shortfall: { $gt: 0 },
        skippedNoLots: { $ne: true },
      },
    },
  };
  if (kitchenId) issueSfFilter.kitchenId = kitchenId;
  const issueShortfalls = await db
    .collection(MATERIAL_ISSUES_COLLECTION)
    .find(issueSfFilter)
    .sort({ updatedAt: -1 })
    .limit(15)
    .toArray();
  for (const row of issueShortfalls) {
    const r = row as Record<string, unknown>;
    const consume = Array.isArray(r.fefoConsume) ? r.fefoConsume : [];
    let shortfallSum = 0;
    let lineCount = 0;
    for (const c of consume) {
      const line = c as { shortfall?: number; skippedNoLots?: boolean };
      if (line.skippedNoLots) continue;
      const sf = Number(line.shortfall || 0);
      if (sf > 0.001) {
        shortfallSum += sf;
        lineCount += 1;
      }
    }
    if (!(shortfallSum > 0)) continue;
    out.push({
      key: `issue-fefo-sf:${String(r.id)}`,
      pillar: 'FOOD',
      level: 'ATTENTION',
      label: `Issue FEFO shortfall · ${String(r.noDokumen || r.id)}`,
      detail: `${lineCount} line(s) · shortfall qty ${shortfallSum}`,
      href: '/food-production/issue',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Food: Dist FEFO shortfall (W2-10) ──
  const distSfFilter: Record<string, unknown> = {
    tenantId,
    status: { $in: ['PROCESSING', 'COMPLETED'] },
    fefoConsume: {
      $elemMatch: {
        shortfall: { $gt: 0 },
        skippedNoBatches: { $ne: true },
      },
    },
  };
  if (kitchenId) distSfFilter.kitchenId = kitchenId;
  const distShortfalls = await db
    .collection(DISTRIBUTION_ORDERS_COLLECTION)
    .find(distSfFilter)
    .sort({ updatedAt: -1 })
    .limit(15)
    .toArray();
  for (const row of distShortfalls) {
    const r = row as Record<string, unknown>;
    const consume = Array.isArray(r.fefoConsume) ? r.fefoConsume : [];
    let shortfallSum = 0;
    let lineCount = 0;
    for (const c of consume) {
      const line = c as { shortfall?: number; skippedNoBatches?: boolean };
      if (line.skippedNoBatches) continue;
      const sf = Number(line.shortfall || 0);
      if (sf > 0.001) {
        shortfallSum += sf;
        lineCount += 1;
      }
    }
    if (!(shortfallSum > 0)) continue;
    out.push({
      key: `dist-fefo-sf:${String(r.id)}`,
      pillar: 'FOOD',
      level: 'ATTENTION',
      label: `Dist FEFO shortfall · ${String(r.noDokumen || r.id)}`,
      detail: `${lineCount} line(s) · shortfall qty ${shortfallSum}`,
      href: '/food-production/distribution',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Food: Dist return FEFO restore shortfall (W2-14) ──
  const distReturnSfFilter: Record<string, unknown> = {
    tenantId,
    status: 'COMPLETED',
    fefoRestore: {
      $elemMatch: {
        shortfall: { $gt: 0 },
      },
    },
  };
  if (kitchenId) distReturnSfFilter.kitchenId = kitchenId;
  const distReturnShortfalls = await db
    .collection(DISTRIBUTION_ORDERS_COLLECTION)
    .find(distReturnSfFilter)
    .sort({ updatedAt: -1 })
    .limit(15)
    .toArray();
  for (const row of distReturnShortfalls) {
    const r = row as Record<string, unknown>;
    const restore = Array.isArray(r.fefoRestore) ? r.fefoRestore : [];
    let shortfallSum = 0;
    let lineCount = 0;
    for (const c of restore) {
      const line = c as { shortfall?: number };
      const sf = Number(line.shortfall || 0);
      if (sf > 0.001) {
        shortfallSum += sf;
        lineCount += 1;
      }
    }
    if (!(shortfallSum > 0)) continue;
    out.push({
      key: `dist-return-fefo-sf:${String(r.id)}`,
      pillar: 'FOOD',
      level: 'ATTENTION',
      label: `Dist return FEFO shortfall · ${String(r.noDokumen || r.id)}`,
      detail: `${lineCount} line(s) · restore shortfall qty ${shortfallSum}`,
      href: '/food-production/distribution',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Food: HSL waste unposted (W2-15) ──
  const hslWasteFilter: Record<string, unknown> = {
    tenantId,
    status: 'COMPLETED',
    'summary.wastePorsiTotal': { $gt: 0 },
    wasteStockPostedAt: { $exists: false },
  };
  if (kitchenId) hslWasteFilter.kitchenId = kitchenId;
  const hslWasteRows = await db
    .collection(PRODUCTION_RESULTS_COLLECTION)
    .find(hslWasteFilter)
    .sort({ updatedAt: -1 })
    .limit(15)
    .toArray();
  for (const row of hslWasteRows) {
    const r = row as Record<string, unknown>;
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const hasFgWaste = lines.some((l) => {
      const line = l as { finishedGoodProductId?: string; wastePorsi?: number };
      return Boolean(String(line.finishedGoodProductId || '').trim()) && Number(line.wastePorsi || 0) > 0;
    });
    if (!hasFgWaste) continue;
    const waste = Number((r.summary as { wastePorsiTotal?: number } | undefined)?.wastePorsiTotal || 0);
    out.push({
      key: `hsl-waste:${String(r.id)}`,
      pillar: 'FOOD',
      level: 'ATTENTION',
      label: `HSL waste unposted · ${String(r.noDokumen || r.id)}`,
      detail: `waste ${waste} captured without FP_RESULT_WASTE`,
      href: '/food-production/result',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Food: Release FEFO shortfall (W2-11) — tenant-wide (no kitchenId on RL) ──
  if (!kitchenId) {
    const releaseShortfalls = await db
      .collection('inventory_releases')
      .find({
        tenantId,
        status: 'POSTED',
        fefoConsume: {
          $elemMatch: {
            shortfall: { $gt: 0 },
            skippedNoBatches: { $ne: true },
          },
        },
      })
      .sort({ updatedAt: -1 })
      .limit(15)
      .toArray();
    for (const row of releaseShortfalls) {
      const r = row as Record<string, unknown>;
      const consume = Array.isArray(r.fefoConsume) ? r.fefoConsume : [];
      let shortfallSum = 0;
      let lineCount = 0;
      for (const c of consume) {
        const line = c as { shortfall?: number; skippedNoBatches?: boolean };
        if (line.skippedNoBatches) continue;
        const sf = Number(line.shortfall || 0);
        if (sf > 0.001) {
          shortfallSum += sf;
          lineCount += 1;
        }
      }
      if (!(shortfallSum > 0)) continue;
      out.push({
        key: `release-fefo-sf:${String(r.id)}`,
        pillar: 'FOOD',
        level: 'ATTENTION',
        label: `Release FEFO shortfall · ${String(r.noRelease || r.id)}`,
        detail: `${lineCount} line(s) · shortfall qty ${shortfallSum}`,
        href: '/stok/release',
        source: 'FOOD_PRODUCTION',
      });
    }
  }

  // ── Food: HACCP FAIL (disposition, bukan failCount mentah) ──
  // ADR-004 P0B: item non-wajib yang FAIL tidak menentukan disposition; attention
  // harus selaras supaya termometer-belum-kalibrasi tidak jadi CRITICAL palsu.
  const haccpFilter: Record<string, unknown> = {
    tenantId,
    ...haccpDispositionMongoFilter('FAIL'),
  };
  if (kitchenId) haccpFilter.kitchenId = kitchenId;
  const haccpRows = await db
    .collection(HACCP_RESULTS_COLLECTION)
    .find(haccpFilter)
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  for (const row of haccpRows) {
    const r = row as Record<string, unknown>;
    const summary = (r.summary || {}) as { requiredFailCount?: number; failCount?: number };
    const fails = Number(summary.requiredFailCount || summary.failCount || 0);
    out.push({
      key: `haccp:${String(r.id)}`,
      pillar: 'FOOD',
      level: 'CRITICAL',
      label: `HACCP · ${String(r.noDokumen || r.id)}`,
      detail: fails > 0 ? `${fails} CCP wajib FAIL` : 'Disposition FAIL',
      href: '/food-production/haccp',
      source: 'FOOD_PRODUCTION',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Equipment: PM overdue / due soon (kitchen-scoped via asset) ──
  const pmFilter: Record<string, unknown> = { tenantId, status: 'ACTIVE' };
  let runPm = true;
  if (kitchenId) {
    const assetIds = await assetIdsForKitchen(db, tenantId, kitchenId);
    if (!assetIds?.length) runPm = false;
    else pmFilter.assetId = { $in: assetIds };
  }
  if (runPm) {
    const pmRows = await db
      .collection(MAINTENANCE_SCHEDULES_COLLECTION)
      .find(pmFilter)
      .sort({ nextDueDate: 1 })
      .limit(40)
      .toArray();
    for (const row of pmRows) {
      const r = row as Record<string, unknown>;
      const overdue = isScheduleDue(r.nextDueDate, today);
      const dueSoon = !overdue && isScheduleDueSoon(r.nextDueDate, Number(r.leadDays || 0), today);
      if (!overdue && !dueSoon) continue;
      const judul = String(r.judul || r.assetNama || 'PM');
      out.push({
        key: `pm:${String(r.id)}`,
        pillar: 'EQUIPMENT',
        level: overdue ? 'CRITICAL' : 'ATTENTION',
        label: overdue ? `Unsafe · ${judul}` : `Attention · ${judul}`,
        detail: overdue
          ? `Maintenance overdue · ${String(r.nextDueDate || '').slice(0, 10)}`
          : `Maintenance due soon · ${String(r.nextDueDate || '').slice(0, 10)}`,
        href: '/maintenance/jadwal',
        source: 'MAINTENANCE',
        kitchenId,
      });
    }
  }

  // ── Open observations (light — not Observation Management) ──
  const obsFilter: Record<string, unknown> = {
    tenantId,
    status: 'OPEN',
    signalStatus: { $ne: 'OK' },
  };
  if (kitchenId) obsFilter.kitchenId = kitchenId;
  const observations = await db
    .collection(KA_OBSERVATIONS_COLLECTION)
    .find(obsFilter)
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  for (const row of observations) {
    const r = row as Record<string, unknown>;
    const pillar = toPillar(String(r.category));
    out.push({
      key: `obs:${String(r.id)}`,
      pillar,
      level: String(r.signalStatus) === 'BREACH' ? 'CRITICAL' : 'ATTENTION',
      label: String(r.signalLabel || r.noDokumen || 'Observation'),
      detail: `Open observation · ${String(r.noDokumen || '')}`,
      href: r.href ? String(r.href) : '/kitchen-assurance/monitoring',
      source: 'KITCHEN_ASSURANCE',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Open KA issues/cases ──
  const caseFilter: Record<string, unknown> = {
    tenantId,
    status: { $in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'] },
  };
  if (kitchenId) caseFilter.kitchenId = kitchenId;
  const cases = await db
    .collection(KA_SAFETY_CASES_COLLECTION)
    .find(caseFilter)
    .sort({ createdAt: -1 })
    .limit(40)
    .toArray();
  for (const row of cases) {
    const r = row as Record<string, unknown>;
    const pillar = toPillar(String(r.category));
    out.push({
      key: `case:${String(r.id)}`,
      pillar,
      level: String(r.severity) === 'CRITICAL' || String(r.severity) === 'HIGH' ? 'CRITICAL' : 'ATTENTION',
      label: `${String(r.title || 'Issue')} · ${String(r.noDokumen || '')}`,
      detail: `Issue ${String(r.status)}`,
      href: '/kitchen-assurance/cases',
      source: 'KITCHEN_ASSURANCE',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // ── Open / needs-verify follow-ups ──
  const fuFilter: Record<string, unknown> = {
    tenantId,
    status: { $in: ['OPEN', 'DONE'] },
  };
  if (kitchenId) fuFilter.kitchenId = kitchenId;
  const followUps = await db
    .collection(KA_FOLLOW_UPS_COLLECTION)
    .find(fuFilter)
    .sort({ dueAt: 1, createdAt: -1 })
    .limit(40)
    .toArray();
  for (const row of followUps) {
    const r = row as Record<string, unknown>;
    const due = r.dueAt ? String(r.dueAt).slice(0, 10) : '';
    const overdue = Boolean(due && due < today && r.status === 'OPEN');
    const needsVerify = r.status === 'DONE';
    const pillar = toPillar(String(r.category));
    out.push({
      key: `fu:${String(r.id)}`,
      pillar,
      level: overdue || needsVerify ? 'CRITICAL' : 'ATTENTION',
      label: `${String(r.title || 'Follow-up')} · ${String(r.noDokumen || '')}`,
      detail: needsVerify
        ? 'Menunggu verifikasi'
        : overdue
          ? `Overdue ${due}`
          : due
            ? `Due ${due}`
            : `Open follow-up${r.safetyCaseNo ? ` · ${String(r.safetyCaseNo)}` : ''}`,
      href: r.safetyCaseId
        ? `/kitchen-assurance/follow-up?caseId=${encodeURIComponent(String(r.safetyCaseId))}`
        : '/kitchen-assurance/follow-up',
      source: 'KITCHEN_ASSURANCE',
      kitchenId: r.kitchenId ? String(r.kitchenId) : undefined,
    });
  }

  // Sort: CRITICAL first, then by pillar order
  const pillarOrder = Object.fromEntries(KA_PILLARS.map((p, i) => [p, i])) as Record<string, number>;
  out.sort((a, b) => {
    if (a.level !== b.level) return a.level === 'CRITICAL' ? -1 : 1;
    return (pillarOrder[a.pillar] ?? 9) - (pillarOrder[b.pillar] ?? 9);
  });

  return out;
}

export function buildKitchenStatus(attentions: KaAttentionItem[]): KaKitchenStatusPillar[] {
  return KA_PILLARS.map((pillar) => {
    const items = attentions.filter((a) => a.pillar === pillar);
    const hasCritical = items.some((i) => i.level === 'CRITICAL');
    const traffic: KaPillarTraffic = !items.length ? 'GREEN' : hasCritical ? 'RED' : 'YELLOW';
    return {
      pillar,
      label: KA_PILLAR_LABELS[pillar],
      traffic,
      attentionCount: items.length,
      items,
    };
  });
}
