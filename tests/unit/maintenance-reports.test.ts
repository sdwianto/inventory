import { describe, expect, it } from 'vitest';
import {
  computeMttrHours,
  formatMttrLabel,
  sumReleaseItemsCost,
} from '@/lib/api/maintenance-reports';

describe('maintenance-reports', () => {
  it('computeMttrHours from start to closed', () => {
    const hours = computeMttrHours({
      status: 'CLOSED',
      createdAt: new Date('2026-06-01T08:00:00'),
      startedAt: new Date('2026-06-01T10:00:00'),
      closedAt: new Date('2026-06-02T10:00:00'),
    });
    expect(hours).toBe(24);
  });

  it('formatMttrLabel shows days for long repairs', () => {
    expect(formatMttrLabel(48)).toContain('hari');
    expect(formatMttrLabel(5)).toContain('jam');
    expect(formatMttrLabel(null)).toBe('—');
  });

  it('sumReleaseItemsCost', () => {
    expect(sumReleaseItemsCost([{ qty: 2, hargaBeli: 1000 }, { qty: 1, hargaBeli: 500 }])).toBe(2500);
  });
});
