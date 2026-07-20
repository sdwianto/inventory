/**
 * Kitchen Assurance Analytics + AI Recommendation — ADR-002 P5.
 * Rule-based recommendations (not prediction / ML suite).
 */

import type { Db } from 'mongodb';
import {
  KA_PILLARS,
  KA_PILLAR_LABELS,
  toPillar,
  type KaPillar,
} from '@/lib/kitchen-assurance/categories';
import { KA_SAFETY_CASES_COLLECTION } from '@/lib/kitchen-assurance/safety-case';
import { KA_FOLLOW_UPS_COLLECTION } from '@/lib/kitchen-assurance/follow-up';
import { TEMPERATURE_LOGS_COLLECTION } from '@/lib/food-production/temperature-log';
import { collectAttentions, type KaAttentionItem } from '@/lib/kitchen-assurance/attention';

export interface KaTrendPoint {
  tanggal: string;
  issuesOpened: number;
  issuesClosed: number;
  tempAlerts: number;
  followUpsOpened: number;
}

export interface KaRecommendation {
  id: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  pillar: KaPillar | 'ALL';
  title: string;
  rationale: string;
  href?: string;
}

export interface KaAnalyticsSnapshot {
  generatedAt: string;
  from: string;
  to: string;
  kitchenId?: string;
  trend: KaTrendPoint[];
  byPillarOpen: Array<{ pillar: KaPillar; label: string; openIssues: number; activeFollowUps: number }>;
  recommendations: KaRecommendation[];
  attentionsSample: KaAttentionItem[];
}

function emptyTrend(from: string, to: string): KaTrendPoint[] {
  const out: KaTrendPoint[] = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    out.push({
      tanggal: cur.toISOString().slice(0, 10),
      issuesOpened: 0,
      issuesClosed: 0,
      tempAlerts: 0,
      followUpsOpened: 0,
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function buildKaRecommendations(input: {
  attentions: KaAttentionItem[];
  openByPillar: Record<KaPillar, number>;
  activeFu: number;
  overdueFu: number;
  tempCritical: number;
  pmUnsafe: number;
  trendRising: boolean;
}): KaRecommendation[] {
  const recs: KaRecommendation[] = [];
  const { attentions, openByPillar, activeFu, overdueFu, tempCritical, pmUnsafe, trendRising } = input;

  if (tempCritical > 0) {
    recs.push({
      id: 'rec-cold-chain',
      priority: 'HIGH',
      pillar: 'FOOD',
      title: 'Periksa cold chain sekarang',
      rationale: `${tempCritical} alert suhu kritis/out-of-range aktif di Monitoring.`,
      href: '/food-production/cold-chain',
    });
  }

  if (openByPillar.FOOD >= 3) {
    recs.push({
      id: 'rec-food-issues',
      priority: 'HIGH',
      pillar: 'FOOD',
      title: 'Prioritaskan Issue Food Safety',
      rationale: `${openByPillar.FOOD} issue Food masih terbuka — Food Safety adalah prioritas #1 MBG.`,
      href: '/kitchen-assurance/cases?category=FOOD',
    });
  }

  if (pmUnsafe > 0) {
    recs.push({
      id: 'rec-equipment',
      priority: 'HIGH',
      pillar: 'EQUIPMENT',
      title: 'Jadwalkan perawatan peralatan Unsafe',
      rationale: `${pmUnsafe} jadwal PM overdue/due — status Equipment Unsafe/Attention.`,
      href: '/maintenance/jadwal',
    });
  }

  if (overdueFu > 0) {
    recs.push({
      id: 'rec-fu-overdue',
      priority: 'HIGH',
      pillar: 'OPERATION',
      title: 'Tutup follow-up yang terlambat',
      rationale: `${overdueFu} follow-up melewati due date — blokir tutup Issue sampai selesai.`,
      href: '/kitchen-assurance/follow-up?status=OPEN',
    });
  } else if (activeFu > 0) {
    recs.push({
      id: 'rec-fu-active',
      priority: 'MEDIUM',
      pillar: 'OPERATION',
      title: 'Selesaikan follow-up aktif',
      rationale: `${activeFu} follow-up masih OPEN/DONE — lengkapi evidence & verifikasi.`,
      href: '/kitchen-assurance/follow-up',
    });
  }

  if (openByPillar.PEOPLE > 0) {
    recs.push({
      id: 'rec-people',
      priority: 'MEDIUM',
      pillar: 'PEOPLE',
      title: 'Tinjau Issue People Safety',
      rationale: `${openByPillar.PEOPLE} issue terkait orang masih terbuka.`,
      href: '/kitchen-assurance/cases?category=PEOPLE',
    });
  }

  if (trendRising) {
    recs.push({
      id: 'rec-trend',
      priority: 'MEDIUM',
      pillar: 'ALL',
      title: 'Tren issue naik — tingkatkan monitoring harian',
      rationale: 'Jumlah Issue baru 3 hari terakhir lebih tinggi dari 3 hari sebelumnya.',
      href: '/kitchen-assurance/monitoring',
    });
  }

  const criticalAttn = attentions.filter((a) => a.level === 'CRITICAL').length;
  if (criticalAttn >= 5) {
    recs.push({
      id: 'rec-attn-burst',
      priority: 'HIGH',
      pillar: 'ALL',
      title: 'Banyak kondisi kritis bersamaan',
      rationale: `${criticalAttn} item Attention CRITICAL — fokusasikan kepala dapur sekarang.`,
      href: '/kitchen-assurance/monitoring',
    });
  }

  if (!recs.length && attentions.length === 0) {
    recs.push({
      id: 'rec-all-clear',
      priority: 'LOW',
      pillar: 'ALL',
      title: 'Pertahankan rutinitas harian',
      rationale: 'Tidak ada exception aktif. Lanjutkan log suhu, QC, dan PM sesuai jadwal owner domain.',
      href: '/kitchen-assurance',
    });
  }

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  recs.sort((a, b) => order[a.priority] - order[b.priority]);
  return recs.slice(0, 8);
}

export async function buildKaAnalytics(
  db: Db,
  scope: { tenantId: string; kitchenId?: string; from: string; to: string },
): Promise<KaAnalyticsSnapshot> {
  const { tenantId, kitchenId, from, to } = scope;
  const base: Record<string, unknown> = { tenantId };
  if (kitchenId) base.kitchenId = kitchenId;

  const trend = emptyTrend(from, to);
  const byDate = Object.fromEntries(trend.map((t) => [t.tanggal, t])) as Record<string, KaTrendPoint>;

  const [cases, closedCases, fus, tempLogs, attentions] = await Promise.all([
    db.collection(KA_SAFETY_CASES_COLLECTION)
      .find({ ...base, tanggal: { $gte: from, $lte: to } })
      .project({ tanggal: 1, status: 1, category: 1 })
      .limit(3000)
      .toArray(),
    db.collection(KA_SAFETY_CASES_COLLECTION)
      .find({
        ...base,
        status: 'CLOSED',
        updatedAt: {
          $gte: new Date(from + 'T00:00:00.000Z'),
          $lte: new Date(to + 'T23:59:59.999Z'),
        },
      })
      .project({ updatedAt: 1 })
      .limit(3000)
      .toArray(),
    db.collection(KA_FOLLOW_UPS_COLLECTION)
      .find({
        tenantId,
        ...(kitchenId ? { kitchenId } : {}),
        createdAt: {
          $gte: new Date(from + 'T00:00:00.000Z'),
          $lte: new Date(to + 'T23:59:59.999Z'),
        },
      })
      .project({ createdAt: 1, dueAt: 1, status: 1, category: 1 })
      .limit(3000)
      .toArray(),
    db.collection(TEMPERATURE_LOGS_COLLECTION)
      .find({
        tenantId,
        ...(kitchenId ? { kitchenId } : {}),
        tanggal: { $gte: from, $lte: to },
        alertStatus: { $in: ['WARN', 'OUT_OF_RANGE', 'CRITICAL'] },
      })
      .project({ tanggal: 1, alertStatus: 1 })
      .limit(5000)
      .toArray(),
    collectAttentions(db, { tenantId, kitchenId }),
  ]);

  for (const row of cases) {
    const r = row as Record<string, unknown>;
    const d = String(r.tanggal || '').slice(0, 10);
    if (byDate[d]) byDate[d].issuesOpened += 1;
  }
  for (const row of closedCases) {
    const r = row as Record<string, unknown>;
    const d = r.updatedAt ? new Date(r.updatedAt as Date).toISOString().slice(0, 10) : '';
    if (byDate[d]) byDate[d].issuesClosed += 1;
  }
  for (const row of fus) {
    const r = row as Record<string, unknown>;
    const d = r.createdAt ? new Date(r.createdAt as Date).toISOString().slice(0, 10) : '';
    if (byDate[d]) byDate[d].followUpsOpened += 1;
  }
  for (const row of tempLogs) {
    const r = row as Record<string, unknown>;
    const d = String(r.tanggal || '').slice(0, 10);
    if (byDate[d]) byDate[d].tempAlerts += 1;
  }

  const openByPillar = Object.fromEntries(KA_PILLARS.map((p) => [p, 0])) as Record<KaPillar, number>;
  const fuByPillar = Object.fromEntries(KA_PILLARS.map((p) => [p, 0])) as Record<KaPillar, number>;

  const [openCasesAgg, activeFuAgg] = await Promise.all([
    db.collection(KA_SAFETY_CASES_COLLECTION).aggregate([
      {
        $match: {
          ...base,
          status: { $in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'] },
        },
      },
      { $group: { _id: '$category', n: { $sum: 1 } } },
    ]).toArray(),
    db.collection(KA_FOLLOW_UPS_COLLECTION).aggregate([
      {
        $match: {
          tenantId,
          ...(kitchenId ? { kitchenId } : {}),
          status: { $in: ['OPEN', 'DONE'] },
        },
      },
      { $group: { _id: '$category', n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  for (const row of openCasesAgg) {
    const p = toPillar(String((row as { _id: string })._id));
    openByPillar[p] = Number((row as { n: number }).n) || 0;
  }
  for (const row of activeFuAgg) {
    const p = toPillar(String((row as { _id: string })._id));
    fuByPillar[p] = Number((row as { n: number }).n) || 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const activeFuRows = await db.collection(KA_FOLLOW_UPS_COLLECTION)
    .find({
      tenantId,
      ...(kitchenId ? { kitchenId } : {}),
      status: { $in: ['OPEN', 'DONE'] },
    })
    .project({ dueAt: 1, status: 1 })
    .limit(500)
    .toArray();
  const activeFu = activeFuRows.length;
  const overdueFu = activeFuRows.filter((r) => {
    const due = (r as { dueAt?: unknown }).dueAt
      ? String((r as { dueAt: unknown }).dueAt).slice(0, 10)
      : '';
    return (r as { status?: string }).status === 'OPEN' && due && due < today;
  }).length;

  const tempCritical = attentions.filter(
    (a) => a.pillar === 'FOOD' && a.key.startsWith('temp:') && a.level === 'CRITICAL',
  ).length;
  const pmUnsafe = attentions.filter(
    (a) => a.pillar === 'EQUIPMENT' && a.level === 'CRITICAL',
  ).length;

  const half = Math.floor(trend.length / 2);
  const first = trend.slice(0, half).reduce((s, t) => s + t.issuesOpened, 0);
  const second = trend.slice(half).reduce((s, t) => s + t.issuesOpened, 0);
  const trendRising = trend.length >= 6 && second > first && second >= first + 2;

  const recommendations = buildKaRecommendations({
    attentions,
    openByPillar,
    activeFu,
    overdueFu,
    tempCritical,
    pmUnsafe,
    trendRising,
  });

  return {
    generatedAt: new Date().toISOString(),
    from,
    to,
    kitchenId,
    trend,
    byPillarOpen: KA_PILLARS.map((pillar) => ({
      pillar,
      label: KA_PILLAR_LABELS[pillar],
      openIssues: openByPillar[pillar],
      activeFollowUps: fuByPillar[pillar],
    })),
    recommendations,
    attentionsSample: attentions.slice(0, 8),
  };
}
