import { describe, expect, it, vi } from 'vitest';
import {
  addInterval,
  countScheduleDueStats,
  formatIntervalLabel,
  isScheduleDue,
  isScheduleDueSoon,
  startOfDay,
} from '@/lib/api/maintenance-schedule-engine';

describe('maintenance-schedule-engine', () => {
  it('addInterval adds months correctly', () => {
    const base = startOfDay(new Date(2026, 0, 15));
    const next = addInterval(base, 'MONTHS', 1);
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(15);
  });

  it('isScheduleDue when date is today or past', () => {
    const today = startOfDay(new Date(2026, 5, 28));
    expect(isScheduleDue(new Date(2026, 5, 27), today)).toBe(true);
    expect(isScheduleDue(new Date(2026, 5, 28), today)).toBe(true);
    expect(isScheduleDue(new Date(2026, 5, 29), today)).toBe(false);
  });

  it('isScheduleDueSoon within lead window', () => {
    const today = startOfDay(new Date(2026, 5, 28));
    const due = new Date(2026, 6, 2);
    expect(isScheduleDueSoon(due, 7, today)).toBe(true);
    expect(isScheduleDueSoon(new Date(2026, 7, 1), 7, today)).toBe(false);
  });

  it('formatIntervalLabel', () => {
    expect(formatIntervalLabel('WEEKS', 2)).toContain('2 minggu');
  });

  it('countScheduleDueStats aggregates facet counts', async () => {
    const aggregate = vi.fn().mockReturnValue({
      toArray: vi.fn().mockResolvedValue([{
        active: [{ n: 5 }],
        overdue: [{ n: 2 }],
        dueSoon: [{ n: 1 }],
      }]),
    });
    const db = {
      collection: vi.fn().mockReturnValue({ aggregate }),
    };

    const today = startOfDay(new Date(2026, 5, 28));
    const stats = await countScheduleDueStats(db as never, { tenantId: 't1' }, today);

    expect(stats).toEqual({ active: 5, overdue: 2, dueSoon: 1 });
    expect(aggregate).toHaveBeenCalledOnce();
    const pipeline = aggregate.mock.calls[0][0];
    expect(pipeline[0].$match).toMatchObject({ tenantId: 't1', status: 'ACTIVE' });
    expect(pipeline[1].$facet).toBeDefined();
  });
});
