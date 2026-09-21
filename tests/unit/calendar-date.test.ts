import { describe, expect, it } from 'vitest';
import {
  calendarDateAtUtcNoon,
  calendarDateKey,
  parseCalendarDateInput,
} from '@/lib/calendar-date';
import { resolveProcureArrivalDate } from '@/lib/food-production/production-plan';
import { resolveTanggalKedatanganForWrite } from '@/lib/api/po-arrival-date';

describe('calendarDateKey', () => {
  it('keeps YYYY-MM-DD prefix from ISO midnight UTC (no local shift)', () => {
    expect(calendarDateKey('2026-09-20T00:00:00.000Z')).toBe('2026-09-20');
    expect(calendarDateKey('2026-09-20')).toBe('2026-09-20');
    expect(calendarDateKey(new Date('2026-09-20T00:00:00.000Z'))).toBe('2026-09-20');
    expect(calendarDateKey(new Date('2026-09-20T12:00:00.000Z'))).toBe('2026-09-20');
  });

  it('stores calendar dates at UTC noon', () => {
    const d = calendarDateAtUtcNoon('2026-09-20');
    expect(d.toISOString()).toBe('2026-09-20T12:00:00.000Z');
    expect(parseCalendarDateInput('2026-09-20')?.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });
});

describe('resolveProcureArrivalDate', () => {
  it('always uses H-1 of menu date — client override cannot drift kedatangan', () => {
    expect(resolveProcureArrivalDate('2026-09-21')).toBe('2026-09-20');
    expect(resolveProcureArrivalDate('2026-09-21', '2026-09-21')).toBe('2026-09-20');
    expect(resolveProcureArrivalDate('2026-09-21', '2026-09-18')).toBe('2026-09-20');
  });
});

describe('resolveTanggalKedatanganForWrite', () => {
  it('snaps plan-linked PO to H-1 even if body sends another day', async () => {
    const db = {
      collection: () => ({
        findOne: async () => ({ tanggal: '2026-09-21' }),
      }),
    };
    const out = await resolveTanggalKedatanganForWrite(db as never, {
      productionPlanId: 'plan-1',
      raw: '2026-09-18',
    });
    expect(out).toMatchObject({ ok: true, iso: '2026-09-20', fromPlan: true });
    if (out.ok) expect(out.date.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });

  it('parses ad-hoc PO date as calendar day', async () => {
    const db = { collection: () => ({ findOne: async () => null }) };
    const out = await resolveTanggalKedatanganForWrite(db as never, {
      raw: '2026-09-18T00:00:00.000Z',
    });
    expect(out).toMatchObject({ ok: true, iso: '2026-09-18', fromPlan: false });
  });
});
