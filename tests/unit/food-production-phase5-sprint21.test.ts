import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  normalizeHaccpCategory,
  normalizeHaccpTemplateItems,
  normalizeHaccpResultItems,
  summarizeHaccpItems,
  assertHaccpCanComplete,
  DEFAULT_HACCP_TEMPLATES,
} from '@/lib/food-production/haccp';
import { batchTrailToCsv, sortTrailEvents, type BatchTrailEvent } from '@/lib/food-production/batch-audit-trail';

describe('food-production phase 5 sprint 21', () => {
  it('registers HCP doc prefix', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.HACCP_RESULT]).toBe('HCP');
  });

  it('normalizes category and template items', () => {
    expect(normalizeHaccpCategory('ccp_cook')).toBe('CCP_COOK');
    expect(normalizeHaccpCategory('x')).toEqual({ error: expect.stringMatching(/category/) });
    const items = normalizeHaccpTemplateItems([
      { key: 'core', label: 'Suhu inti', needsPhoto: true },
      { key: 'hold', label: 'Holding', required: false },
    ]);
    expect('error' in (items as object)).toBe(false);
    if ('error' in (items as object)) return;
    expect(items[0].needsPhoto).toBe(true);
    expect(items[1].required).toBe(false);
  });

  it('gates complete on required PASS and photo', () => {
    const tpl = DEFAULT_HACCP_TEMPLATES[0].items;
    const items = normalizeHaccpResultItems(
      tpl.map((t) => ({ key: t.key, result: 'PASS' })),
      tpl,
    );
    expect('error' in (items as object)).toBe(false);
    if ('error' in (items as object)) return;
    expect(assertHaccpCanComplete(items, tpl, [])).toMatch(/evidence foto/);
    expect(assertHaccpCanComplete(items, tpl, ['/api/media/t/x.jpg'])).toBeNull();
    const failed = normalizeHaccpResultItems(
      [{ key: 'core_temp', result: 'FAIL' }, { key: 'hold_time', result: 'PASS' }],
      tpl,
    );
    if ('error' in (failed as object)) return;
    expect(assertHaccpCanComplete(failed, tpl, ['/api/media/t/x.jpg'])).toMatch(/gagal/);
  });

  it('summarizes items and photo count', () => {
    const tpl = DEFAULT_HACCP_TEMPLATES[2].items;
    const items = normalizeHaccpResultItems(
      [
        { key: 'hold_temp', result: 'PASS', evidenceUrls: ['/a.jpg'] },
        { key: 'hold_duration', result: 'NA' },
      ],
      tpl,
    );
    if ('error' in (items as object)) return;
    const sum = summarizeHaccpItems(items, tpl, ['/b.jpg']);
    expect(sum.passCount).toBe(1);
    expect(sum.naCount).toBe(1);
    expect(sum.photoCount).toBe(2);
  });

  it('exports batch trail CSV sorted by time and guards formula injection', () => {
    const events: BatchTrailEvent[] = [
      {
        at: '2026-07-02T10:00:00.000Z',
        eventType: 'HACCP',
        entityType: 'haccp_result',
        entityId: 'h1',
        summary: '=cmd|"/c calc"',
      },
      {
        at: '2026-07-01',
        eventType: 'BATCH',
        entityType: 'production_batch',
        entityId: 'b1',
        summary: 'Batch first',
      },
    ];
    const sorted = sortTrailEvents(events);
    expect(sorted[0].eventType).toBe('BATCH');
    const csv = batchTrailToCsv({
      batch: { id: 'b1', batchNo: 'B-1' },
      events: sorted,
    });
    expect(csv).toContain('batchId,batchNo,at,eventType');
    expect(csv).toContain('BATCH');
    expect(csv).toContain('HACCP');
    expect(csv.indexOf('Batch first')).toBeLessThan(csv.indexOf('cmd'));
    expect(csv).toContain("'=cmd");
  });
});
