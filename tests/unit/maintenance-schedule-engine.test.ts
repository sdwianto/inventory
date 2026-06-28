import { describe, expect, it } from 'vitest';
import {
  addInterval,
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
});
