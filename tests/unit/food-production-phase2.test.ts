import { describe, expect, it } from 'vitest';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import {
  assertStatusTransition,
  FP_DEFAULT_TRANSITIONS,
  FP_OPEN_DOC_STATUSES,
} from '@/lib/food-production/document';
import {
  buildIssueLinesFromMrp,
  normalizeIssueLines,
  summarizeIssueLines,
  ISSUE_ELIGIBLE_PLAN_STATUSES,
  ISSUE_OPEN_STATUSES,
  ISSUE_STATUS_TRANSITIONS,
  ISSUE_UI_STATUS_NEXT,
  postingDateFromIso,
} from '@/lib/food-production/material-issue';
import {
  buildResultLinesFromPlan,
  normalizeResultLines,
  summarizeResultLines,
  RESULT_ELIGIBLE_PLAN_STATUSES,
  RESULT_OPEN_STATUSES,
  RESULT_STATUS_TRANSITIONS,
  RESULT_UI_STATUS_NEXT,
  assertResultStockGate,
  assertPlanCanComplete,
  planCompleteGateMessage,
} from '@/lib/food-production/production-result';
import {
  buildProductionReport,
  cookingPhaseOf,
} from '@/lib/food-production/production-report';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { RecipeDoc } from '@/lib/food-production/recipe';

describe('food-production phase 2 — Issue + Result', () => {
  it('uses PBL and HSL prefixes', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.MATERIAL_ISSUE]).toBe('PBL');
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.PRODUCTION_RESULT]).toBe('HSL');
  });

  it('gates issue/result on APPROVED or PROCESSING plan', () => {
    expect(ISSUE_ELIGIBLE_PLAN_STATUSES.has('APPROVED')).toBe(true);
    expect(ISSUE_ELIGIBLE_PLAN_STATUSES.has('PROCESSING')).toBe(true);
    expect(ISSUE_ELIGIBLE_PLAN_STATUSES.has('DRAFT')).toBe(false);
    expect(RESULT_ELIGIBLE_PLAN_STATUSES.has('SUBMITTED')).toBe(false);
  });

  it('builds issue lines from MRP gross qty', () => {
    const lines = buildIssueLinesFromMrp([
      {
        productId: 'beras',
        productKode: 'B001',
        productNama: 'Beras',
        satuan: 'KG',
        qtyGross: 20,
      },
      {
        productId: 'skip',
        qtyGross: 0,
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].qtyPlanned).toBe(20);
    expect(lines[0].qtyIssued).toBe(20);
    expect(summarizeIssueLines(lines).qtyIssuedTotal).toBe(20);
  });

  it('normalizes issue lines and rejects bad qty', () => {
    const ok = normalizeIssueLines([
      { productId: 'a', qtyPlanned: 1, qtyIssued: 2, productNama: 'A' },
    ]);
    expect(Array.isArray(ok)).toBe(true);
    const bad = normalizeIssueLines([
      { productId: 'a', qtyPlanned: 1, qtyIssued: 0 },
    ]);
    expect('error' in (bad as object)).toBe(true);
  });

  it('builds result lines from plan × menu × recipe (FG optional for MBG)', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      finishedGoodKode: 'FG1',
      finishedGoodNama: 'Nasi Kotak',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      lines: [{ productId: 'beras', qty: 10, satuan: 'KG' }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const menu: MenuDoc = {
      id: 'm1',
      tenantId: 't1',
      kode: 'MNU-1',
      nama: 'Siang',
      version: 1,
      effectiveDate: '2026-07-01',
      items: [{ recipeId: 'r1', porsi: 1 }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const built = buildResultLinesFromPlan({
      planLines: [{ menuId: 'm1', targetPorsi: 200 }],
      menusById: new Map([['m1', menu]]),
      recipesById: new Map([['r1', recipe]]),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.lines).toHaveLength(1);
    expect(built.lines[0].finishedGoodProductId).toBe('fg1');
    expect(built.lines[0].targetPorsi).toBe(200);
    expect(built.lines[0].actualPorsi).toBe(200);
    expect(summarizeResultLines(built.lines).actualPorsiTotal).toBe(200);

    const mbgRecipe: RecipeDoc = { ...recipe, id: 'r2', kode: 'RSP-2', finishedGoodProductId: undefined, finishedGoodKode: undefined, finishedGoodNama: undefined };
    const mbgMenu: MenuDoc = { ...menu, id: 'm2', items: [{ recipeId: 'r2', porsi: 1 }] };
    const mbg = buildResultLinesFromPlan({
      planLines: [{ menuId: 'm2', targetPorsi: 100 }],
      menusById: new Map([['m2', mbgMenu]]),
      recipesById: new Map([['r2', mbgRecipe]]),
    });
    expect(mbg.ok).toBe(true);
    if (!mbg.ok) return;
    expect(mbg.lines[0].finishedGoodProductId).toBeUndefined();
    expect(mbg.lines[0].finishedGoodNama).toBe('Nasi');
    expect(mbg.warnings.some((w) => /MBG/.test(w))).toBe(true);
  });

  it('rejects inactive menu/recipe in result build', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      lines: [{ productId: 'beras', qty: 1 }],
      aktif: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const menu: MenuDoc = {
      id: 'm1',
      tenantId: 't1',
      kode: 'MNU-1',
      nama: 'Siang',
      version: 1,
      effectiveDate: '2026-07-01',
      items: [{ recipeId: 'r1', porsi: 1 }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const built = buildResultLinesFromPlan({
      planLines: [{ menuId: 'm1', targetPorsi: 10 }],
      menusById: new Map([['m1', menu]]),
      recipesById: new Map([['r1', recipe]]),
    });
    expect(built.ok).toBe(false);
  });

  it('normalizes result lines requiring actual or waste (FG optional)', () => {
    const bad = normalizeResultLines([{
      menuId: 'm',
      recipeId: 'r',
      targetPorsi: 10,
      actualPorsi: 0,
      wastePorsi: 0,
    }]);
    expect('error' in (bad as object)).toBe(true);
    const ok = normalizeResultLines([{
      menuId: 'm',
      recipeId: 'r',
      targetPorsi: 10,
      actualPorsi: 9,
      wastePorsi: 1,
    }]);
    expect(Array.isArray(ok)).toBe(true);
  });

  it('allows APPROVED → COMPLETED for Issue/Result (UI stock post path)', () => {
    expect(assertStatusTransition('APPROVED', 'COMPLETED', FP_DEFAULT_TRANSITIONS)).not.toBeNull();
    expect(assertStatusTransition('APPROVED', 'COMPLETED', ISSUE_STATUS_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('APPROVED', 'COMPLETED', RESULT_STATUS_TRANSITIONS)).toBeNull();
  });

  it('gates Result COMPLETE and plan COMPLETED on completed PBL + HSL', () => {
    expect(assertResultStockGate({ hasCompletedIssue: false, hasOpenIssue: false })).toMatch(/PBL/);
    expect(assertResultStockGate({ hasCompletedIssue: true, hasOpenIssue: true })).toMatch(/terbuka/);
    expect(assertResultStockGate({ hasCompletedIssue: true, hasOpenIssue: false })).toBeNull();
    expect(assertPlanCanComplete({
      hasCompletedIssue: false,
      hasOpenIssue: false,
      hasOpenResult: false,
      hasCompletedResult: false,
    })).toBe(false);
    expect(assertPlanCanComplete({
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasOpenResult: false,
      hasCompletedResult: false,
    })).toBe(false);
    expect(assertPlanCanComplete({
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasOpenResult: false,
      hasCompletedResult: true,
    })).toBe(true);
    expect(assertPlanCanComplete({
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasOpenResult: true,
      hasCompletedResult: true,
    })).toBe(false);
  });

  it('parses posting date at noon UTC to avoid date-only skew', () => {
    const d = postingDateFromIso('2026-07-15');
    expect(d.toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('blocks plan COMPLETED without completed PBL / HSL (manual + auto gate)', () => {
    expect(planCompleteGateMessage({
      hasCompletedIssue: false,
      hasOpenIssue: false,
      hasOpenResult: false,
      hasCompletedResult: false,
    })).toMatch(/PBL/);
    expect(planCompleteGateMessage({
      hasCompletedIssue: true,
      hasOpenIssue: true,
      hasOpenResult: false,
      hasCompletedResult: false,
    })).toMatch(/terbuka/);
    expect(planCompleteGateMessage({
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasOpenResult: true,
      hasCompletedResult: false,
    })).toMatch(/HSL/);
    expect(planCompleteGateMessage({
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasOpenResult: false,
      hasCompletedResult: false,
    })).toMatch(/hasil produksi/);
    expect(planCompleteGateMessage({
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasOpenResult: false,
      hasCompletedResult: true,
    })).toBeNull();
  });

  it('keeps open-status constants aligned for indexes + UI PROCESSING→COMPLETED', () => {
    expect([...ISSUE_OPEN_STATUSES]).toEqual([...FP_OPEN_DOC_STATUSES]);
    expect([...RESULT_OPEN_STATUSES]).toEqual([...FP_OPEN_DOC_STATUSES]);
    expect(ISSUE_UI_STATUS_NEXT.PROCESSING).toBe('COMPLETED');
    expect(RESULT_UI_STATUS_NEXT.PROCESSING).toBe('COMPLETED');
    expect(assertStatusTransition('PROCESSING', 'COMPLETED', ISSUE_STATUS_TRANSITIONS)).toBeNull();
    expect(assertStatusTransition('PROCESSING', 'COMPLETED', RESULT_STATUS_TRANSITIONS)).toBeNull();
  });

  it('builds production report with cooking fold (no separate Cooking doc)', () => {
    expect(cookingPhaseOf({ hasCompletedIssue: false, hasCompletedResult: false }).phase).toBe('NOT_STARTED');
    expect(cookingPhaseOf({ hasCompletedIssue: true, hasCompletedResult: false }).phase).toBe('IN_PROGRESS');
    expect(cookingPhaseOf({ hasCompletedIssue: true, hasCompletedResult: true }).phase).toBe('DONE');
    expect(cookingPhaseOf({
      hasCompletedIssue: true,
      hasCompletedResult: false,
      planStatus: 'COMPLETED',
    }).phase).toBe('DONE');
    expect(cookingPhaseOf({
      hasCompletedIssue: false,
      hasCompletedResult: false,
      planStatus: 'PROCESSING',
    }).phase).toBe('IN_PROGRESS');

    const report = buildProductionReport({
      plan: {
        id: 'p1',
        noDokumen: 'RPN-1',
        tanggal: '2026-07-15',
        status: 'PROCESSING',
        totalTargetPorsi: 100,
      },
      issue: {
        id: 'i1',
        noDokumen: 'PBL-1',
        status: 'COMPLETED',
        qtyIssuedTotal: 20,
      },
      result: {
        id: 'r1',
        noDokumen: 'HSL-1',
        status: 'COMPLETED',
        targetPorsiTotal: 100,
        actualPorsiTotal: 95,
        wastePorsiTotal: 5,
      },
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasCompletedResult: true,
      hasOpenResult: false,
    });
    expect(report.cooking.phase).toBe('DONE');
    expect(report.integrity.canCompletePlan).toBe(true);
    expect(report.summary.yieldPct).toBe(95);

    const closedWithoutHsl = buildProductionReport({
      plan: {
        id: 'p2',
        noDokumen: 'RPN-2',
        tanggal: '2026-07-17',
        status: 'COMPLETED',
        totalTargetPorsi: 200,
      },
      issue: {
        id: 'i2',
        noDokumen: 'PBL-2',
        status: 'COMPLETED',
        qtyIssuedTotal: 10,
      },
      result: null,
      hasCompletedIssue: true,
      hasOpenIssue: false,
      hasCompletedResult: false,
      hasOpenResult: false,
    });
    expect(closedWithoutHsl.cooking.phase).toBe('DONE');
    expect(closedWithoutHsl.cooking.label).toBe('Selesai dimasak');
    expect(closedWithoutHsl.integrity.canCompletePlan).toBe(false);
  });
});
