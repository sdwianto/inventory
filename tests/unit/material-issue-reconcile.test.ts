import { describe, expect, it } from 'vitest';
import {
  applyConsumptionToRequirementLines,
  applyReconciliationToLines,
  mergeConsumptionLinesForCost,
  looksLikeProductionKeperluan,
  isExcludedOperationalKeperluan,
  planDayWindowWib,
} from '@/lib/food-production/material-issue-reconcile';
import type { MaterialIssueLine } from '@/lib/food-production/material-issue';
import type { MaterialRequirementLine } from '@/lib/food-production/material-requirement';

describe('material-issue-reconcile', () => {
  it('applyConsumptionToRequirementLines reduces qtyNet after prior issue', () => {
    const lines: MaterialRequirementLine[] = [{
      productId: 'p1',
      qtyGross: 10,
      qtyOnHand: 2,
      qtyNet: 8,
      shortage: true,
      sources: [],
    }];
    const consumption = new Map([
      ['p1', {
        operational: 6,
        pbl: 0,
        total: 6,
        operationalRefs: [{ noRelease: 'RL001', qty: 6 }],
        pblRefs: [],
      }],
    ]);
    const out = applyConsumptionToRequirementLines(lines, consumption);
    expect(out.lines[0].qtyNet).toBe(2);
    expect(out.summary.shortageCount).toBe(1);
  });

  it('applyReconciliationToLines sets suggested qtyIssued', () => {
    const issueLines: MaterialIssueLine[] = [{
      productId: 'p1',
      qtyPlanned: 10,
      qtyIssued: 10,
    }];
    const reconciliation = {
      productionPlanId: 'plan1',
      issueId: 'i1',
      lines: [{
        productId: 'p1',
        qtyPlanned: 10,
        qtyAlreadyIssuedOperational: 6,
        qtyAlreadyIssuedPbl: 0,
        qtyAlreadyIssued: 6,
        qtyRemaining: 4,
        qtyOnHand: 1,
        suggestedQtyIssued: 1,
        operationalRefs: [],
        pblRefs: [],
        mismatch: true,
      }],
      summary: {
        lineCount: 1,
        qtyPlannedTotal: 10,
        qtyAlreadyIssuedTotal: 6,
        qtyRemainingTotal: 4,
        qtyOnHandTotal: 1,
        suggestedQtyIssuedTotal: 1,
        mismatchCount: 1,
      },
    };
    const next = applyReconciliationToLines(issueLines, reconciliation);
    expect(next[0].qtyIssued).toBe(1);
    expect(next[0].qtyPlanned).toBe(10);
  });

  it('mergeConsumptionLinesForCost sums PBL and RL by product', () => {
    const merged = mergeConsumptionLinesForCost(
      [{ productId: 'p1', qtyPlanned: 3, qtyIssued: 3 }],
      [{ productId: 'p1', qtyPlanned: 2, qtyIssued: 2, productNama: 'Beras' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].qtyIssued).toBe(5);
  });

  it('looksLikeProductionKeperluan detects production keywords', () => {
    expect(looksLikeProductionKeperluan('Masak menu harian')).toBe(true);
    expect(looksLikeProductionKeperluan('AYAM KREMES')).toBe(true);
    expect(looksLikeProductionKeperluan('SIOMAY IKAN')).toBe(true);
    expect(looksLikeProductionKeperluan('Maintenance AC')).toBe(false);
    expect(looksLikeProductionKeperluan('mencuci alat masak')).toBe(false);
    expect(looksLikeProductionKeperluan('STOK OPNAME')).toBe(false);
  });

  it('isExcludedOperationalKeperluan skips non-production ops', () => {
    expect(isExcludedOperationalKeperluan('STOK OPNAME')).toBe(true);
    expect(isExcludedOperationalKeperluan('mencuci alat masak')).toBe(true);
    expect(isExcludedOperationalKeperluan('AYAM KREMES')).toBe(false);
  });

  it('planDayWindowWib covers WIB calendar day', () => {
    const { start, end } = planDayWindowWib('2026-08-27');
    expect(start.toISOString()).toBe('2026-08-26T17:00:00.000Z');
    expect(end.toISOString()).toBe('2026-08-27T16:59:59.999Z');
  });
});
