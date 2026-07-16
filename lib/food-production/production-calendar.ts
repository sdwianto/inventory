/**
 * Production Calendar — ADR-001 Phase 4.
 * Pure aggregation of plans into day cells (from/to inclusive).
 */

export interface CalendarPlanRef {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  status: string;
  totalTargetPorsi?: number;
}

export interface CalendarDayCell {
  tanggal: string;
  planCount: number;
  totalTargetPorsi: number;
  byStatus: Record<string, number>;
  plans: CalendarPlanRef[];
}

export interface ProductionCalendar {
  from: string;
  to: string;
  kitchenId?: string;
  days: CalendarDayCell[];
  summary: {
    dayCount: number;
    planCount: number;
    totalTargetPorsi: number;
  };
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function eachIsoDate(from: string, to: string): string[] | { error: string } {
  if (!isIsoDate(from) || !isIsoDate(to)) return { error: 'from/to wajib YYYY-MM-DD' };
  if (from > to) return { error: 'from tidak boleh setelah to' };
  const out: string[] = [];
  const cur = new Date(`${from}T12:00:00.000Z`);
  const end = new Date(`${to}T12:00:00.000Z`);
  let guard = 0;
  while (cur <= end && guard < 400) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
  }
  return out;
}

export function buildProductionCalendar(input: {
  from: string;
  to: string;
  kitchenId?: string;
  plans: CalendarPlanRef[];
}): ProductionCalendar | { error: string } {
  const dates = eachIsoDate(input.from, input.to);
  if ('error' in dates) return dates;

  const byDay = new Map<string, CalendarPlanRef[]>();
  for (const d of dates) byDay.set(d, []);

  for (const p of input.plans) {
    if (!byDay.has(p.tanggal)) continue;
    if (input.kitchenId && p.kitchenId !== input.kitchenId) continue;
    byDay.get(p.tanggal)!.push(p);
  }

  const days: CalendarDayCell[] = dates.map((tanggal) => {
    const plans = byDay.get(tanggal) || [];
    const byStatus: Record<string, number> = {};
    let totalTargetPorsi = 0;
    for (const p of plans) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      totalTargetPorsi += Number(p.totalTargetPorsi) || 0;
    }
    return {
      tanggal,
      planCount: plans.length,
      totalTargetPorsi,
      byStatus,
      plans,
    };
  });

  return {
    from: input.from,
    to: input.to,
    kitchenId: input.kitchenId,
    days,
    summary: {
      dayCount: days.length,
      planCount: days.reduce((s, d) => s + d.planCount, 0),
      totalTargetPorsi: days.reduce((s, d) => s + d.totalTargetPorsi, 0),
    },
  };
}
