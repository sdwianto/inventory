/**
 * ADR-004 Fase 6 — audit readiness + candidate-lot traceability.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateReadinessStatus,
  pillarFromCounts,
} from '@/lib/food-production/food-safety-audit-readiness';
import {
  TRACEABILITY_ATTRIBUTION_DISCLAIMER,
  mergeCandidateLots,
  proportionalShareForFinishedGood,
} from '@/lib/food-production/food-safety-traceability';
import type { BatchTrailEventType } from '@/lib/food-production/batch-audit-trail';

describe('ADR-004 Fase 6 — readiness aggregation', () => {
  it('pillarFromCounts', () => {
    expect(pillarFromCounts({ evidenceCount: 0, requiredCount: 5 })).toBe('NOT_READY');
    expect(pillarFromCounts({ evidenceCount: 2, requiredCount: 5 })).toBe('PARTIAL');
    expect(pillarFromCounts({ evidenceCount: 5, requiredCount: 5 })).toBe('READY');
    expect(pillarFromCounts({ evidenceCount: 0, requiredCount: 0 })).toBe('READY');
  });

  it('aggregateReadinessStatus', () => {
    expect(aggregateReadinessStatus([
      { status: 'READY' },
      { status: 'READY' },
    ])).toBe('READY');
    expect(aggregateReadinessStatus([
      { status: 'READY' },
      { status: 'NOT_READY' },
    ])).toBe('PARTIAL');
    expect(aggregateReadinessStatus([
      { status: 'NOT_READY' },
      { status: 'NOT_READY' },
    ])).toBe('NOT_READY');
  });
});

describe('ADR-004 Fase 6 — traceability helpers', () => {
  it('disclaimer eksplisit candidate-lot', () => {
    expect(TRACEABILITY_ATTRIBUTION_DISCLAIMER).toMatch(/candidate-lot inference/i);
    expect(TRACEABILITY_ATTRIBUTION_DISCLAIMER).toMatch(/not a physical observation/i);
  });

  it('proportionalShareForFinishedGood', () => {
    expect(proportionalShareForFinishedGood({
      mrpLineSources: [
        { recipeId: 'r1', qty: 3 },
        { recipeId: 'r2', qty: 1 },
      ],
      finishedGoodRecipeIds: ['r1'],
    })).toBe(0.75);
    expect(proportionalShareForFinishedGood({
      mrpLineSources: [{ recipeId: 'r1', qty: 1 }],
      finishedGoodRecipeIds: [],
    })).toBeUndefined();
  });

  it('mergeCandidateLots menjumlah qty', () => {
    const merged = mergeCandidateLots([
      { lotId: 'l1', allocatedQty: 2 },
      { lotId: 'l1', allocatedQty: 3, weightShare: 0.5 },
      { lotId: 'l2', allocatedQty: 1 },
    ]);
    expect(merged.find((x) => x.lotId === 'l1')).toMatchObject({
      allocatedQty: 5,
      weightShare: 0.5,
    });
    expect(merged).toHaveLength(2);
  });
});

describe('ADR-004 Fase 6 — trail event types', () => {
  it('LOT dan DIST ada di union', () => {
    const types: BatchTrailEventType[] = ['LOT', 'DIST', 'FOOD_SAFETY'];
    expect(types).toContain('LOT');
    expect(types).toContain('DIST');
  });
});

describe('ADR-004 Fase 6 — proportional wired semantics', () => {
  it('share informasional; qty tetap full (superset)', () => {
    const share = proportionalShareForFinishedGood({
      mrpLineSources: [
        { recipeId: 'r1', qty: 2 },
        { recipeId: 'r2', qty: 2 },
      ],
      finishedGoodRecipeIds: ['r1'],
    });
    expect(share).toBe(0.5);
    // Recall: allocatedQty tidak di-scale di merge input — hanya weightShare.
    const merged = mergeCandidateLots([
      { lotId: 'l1', allocatedQty: 10, weightShare: share },
    ]);
    expect(merged[0].allocatedQty).toBe(10);
    expect(merged[0].weightShare).toBe(0.5);
  });
});
