/**
 * ADR-004 Fase 2 — Prerequisite programs + QC category + auto-finding.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  DEFAULT_FOOD_SAFETY_PROGRAMS,
  resolveChecklistPeriod,
  normalizeFoodSafetyProgramFrequency,
  normalizeFoodSafetyProgramSource,
} from '@/lib/food-production/food-safety-program';
import { ensureFoodSafetyProgramsSeeded } from '@/lib/food-production/food-safety-program-seed';
import {
  normalizeQcCategory,
  QC_CATEGORY_LABELS,
  normalizeQcResultItems,
  type QcTemplateItem,
} from '@/lib/food-production/qc';
import {
  applyQcFindingOnSave,
  listQcFailLabels,
} from '@/lib/food-production/qc-auto-finding';
import { applyQcFoodSafetyOnSave } from '@/lib/food-production/qc-batch-hold';
import { listPrerequisiteCompliance } from '@/lib/food-production/prerequisite-compliance';

vi.mock('@/lib/kitchen-assurance/auto-issue', () => ({
  ensureOpenKaIssue: vi.fn(async (_db, input) => ({
    created: true,
    case: {
      id: `ka-${input.sourceKey}`,
      noDokumen: 'KA-F2',
      tenantId: input.tenantId,
      sourceKey: input.sourceKey,
      proposedHoldBatchIds: input.proposedHoldBatchIds,
      resolution: input.proposedHoldBatchIds != null
        ? { type: 'HOLD_BATCH' }
        : { type: 'NONE' },
    },
  })),
}));

vi.mock('@/lib/api/audit-log', () => ({
  writeAuditLog: vi.fn(async () => undefined),
}));

import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';

const TPL: QcTemplateItem[] = [
  { key: 'a', label: 'Area bersih', required: true, critical: false, holdOnFail: false },
  { key: 'b', label: 'APD', required: true, critical: true, holdOnFail: true },
];

const HOLD_TPL: QcTemplateItem[] = [
  { key: 'b', label: 'APD', required: true, critical: true, holdOnFail: true },
];

describe('ADR-004 Fase 2 — program seed & periode', () => {
  it('punya 11 program seed BGN', () => {
    expect(DEFAULT_FOOD_SAFETY_PROGRAMS).toHaveLength(11);
    expect(DEFAULT_FOOD_SAFETY_PROGRAMS.map((p) => p.kode)).toContain('PRP-HYG');
    expect(DEFAULT_FOOD_SAFETY_PROGRAMS.every((p) => p.requirements.length >= 1)).toBe(true);
  });

  it('normalize frequency & source', () => {
    expect(normalizeFoodSafetyProgramFrequency('daily')).toBe('DAILY');
    expect(normalizeFoodSafetyProgramFrequency('x')).toEqual({ error: expect.any(String) });
    expect(normalizeFoodSafetyProgramSource('BGN')).toBe('BGN');
    expect(normalizeFoodSafetyProgramSource('')).toBe('INTERNAL');
  });

  it('resolveChecklistPeriod mengikuti frekuensi', () => {
    expect(resolveChecklistPeriod('2026-08-12', 'DAILY')).toBe('2026-08-12');
    expect(resolveChecklistPeriod('2026-08-12', 'MONTHLY')).toBe('2026-08');
    expect(resolveChecklistPeriod('2026-08-12', 'WEEKLY')).toMatch(/^2026-W\d{2}$/);
  });

  it('ensureFoodSafetyProgramsSeeded idempoten', async () => {
    const store = { programs: [] as unknown[], requirements: [] as unknown[] };
    const db = {
      collection: (name: string) => ({
        countDocuments: async () => (
          name === 'food_safety_programs' ? store.programs.length : store.requirements.length
        ),
        insertMany: async (docs: unknown[]) => {
          if (name === 'food_safety_programs') store.programs.push(...docs);
          else store.requirements.push(...docs);
        },
      }),
    };
    const first = await ensureFoodSafetyProgramsSeeded(db as never, 't1');
    expect(first.seeded).toBe(true);
    expect(first.programs).toBe(11);
    expect(first.requirements).toBeGreaterThan(11);

    const second = await ensureFoodSafetyProgramsSeeded(db as never, 't1');
    expect(second.seeded).toBe(false);
    expect(store.programs).toHaveLength(11);
  });
});

describe('ADR-004 Fase 2 — kategori PREREQUISITE', () => {
  it('menerima PREREQUISITE di normalizer', () => {
    expect(normalizeQcCategory('PREREQUISITE')).toBe('PREREQUISITE');
    expect(QC_CATEGORY_LABELS.PREREQUISITE).toMatch(/Prerequisite/i);
  });
});

describe('ADR-004 Fase 2 — auto-finding FAIL', () => {
  beforeEach(() => {
    vi.mocked(ensureOpenKaIssue).mockClear();
  });

  it('listQcFailLabels hanya FAIL', () => {
    const items = normalizeQcResultItems(
      [{ key: 'a', result: 'FAIL' }, { key: 'b', result: 'PASS' }],
      TPL,
    );
    expect('error' in (items as object)).toBe(false);
    expect(listQcFailLabels(items as never, TPL)).toEqual(['Area bersih']);
  });

  it('FAIL tanpa holdOnFail → Safety Case qc-fail', async () => {
    const items = normalizeQcResultItems(
      [{ key: 'a', result: 'FAIL' }, { key: 'b', result: 'PASS' }],
      TPL,
    ) as never;
    const db = {
      collection: () => ({
        find: () => ({
          limit: () => ({ toArray: async () => [{ id: 'batch-x' }] }),
        }),
      }),
    };
    const result = await applyQcFindingOnSave(db as never, {
      tenantId: 't1',
      qcResultId: 'qc-1',
      qcNoDokumen: 'QCR-1',
      category: 'PREREQUISITE',
      items,
      templateItems: TPL,
      kitchenId: 'k1',
      tanggal: '2026-08-12',
    });
    expect(result.raised).toBe(true);
    expect(ensureOpenKaIssue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'qc-fail:qc-1',
        proposedHoldBatchIds: ['batch-x'],
      }),
    );
  });

  it('holdOnFail candidate → skip finding (covered_by_hold)', async () => {
    const items = normalizeQcResultItems(
      [{ key: 'a', result: 'PASS' }, { key: 'b', result: 'FAIL' }],
      TPL,
    ) as never;
    const result = await applyQcFindingOnSave({} as never, {
      tenantId: 't1',
      qcResultId: 'qc-2',
      category: 'PRODUKSI',
      items,
      templateItems: TPL,
    });
    expect(result.skipped).toBe('covered_by_hold');
    expect(ensureOpenKaIssue).not.toHaveBeenCalled();
  });

  it('tanpa FAIL → no-op', async () => {
    const items = normalizeQcResultItems(
      [{ key: 'a', result: 'PASS' }, { key: 'b', result: 'PASS' }],
      TPL,
    ) as never;
    const result = await applyQcFindingOnSave({} as never, {
      tenantId: 't1',
      qcResultId: 'qc-3',
      category: 'PRODUKSI',
      items,
      templateItems: TPL,
    });
    expect(result.skipped).toBe('no_fail');
  });
});

describe('ADR-004 Fase 2 — blast radius PREREQUISITE', () => {
  beforeEach(() => {
    vi.mocked(ensureOpenKaIssue).mockClear();
  });

  it('PREREQUISITE + holdOnFail + batch → proposed, bukan auto HOLD', async () => {
    const items = normalizeQcResultItems(
      [{ key: 'b', result: 'FAIL' }],
      HOLD_TPL,
    ) as never;
    const batchDoc = {
      id: 'batch-1',
      tenantId: 't1',
      batchNo: 'B-1',
      foodSafetyStatus: 'PENDING',
      foodSafetyHistory: [],
    };
    const db = {
      collection: (name: string) => ({
        findOne: async () => (name === 'production_batches' ? batchDoc : null),
        find: () => ({
          limit: () => ({ toArray: async () => [{ id: 'batch-1' }, { id: 'batch-2' }] }),
        }),
        updateOne: async () => ({ modifiedCount: 1 }),
      }),
    };

    const result = await applyQcFoodSafetyOnSave(db as never, {
      tenantId: 't1',
      productionBatchId: 'batch-1',
      qcResultId: 'qc-prp',
      category: 'PREREQUISITE',
      items,
      templateItems: HOLD_TPL,
      kitchenId: 'k1',
      tanggal: '2026-08-12',
    });

    expect(result.held).toBe(false);
    expect(result.proposed).toBe(true);
    expect(result.proposedHoldBatchIds).toContain('batch-1');
    expect(batchDoc.foodSafetyStatus).toBe('PENDING');
  });
});

describe('ADR-004 Fase 2 — compliance periode', () => {
  it('MISSING bila belum ada hasil untuk periode', async () => {
    const programs = [{
      id: 'p1',
      kode: 'PRP-HYG',
      nama: 'Hygiene',
      frequency: 'DAILY',
      sortOrder: 1,
      aktif: true,
    }];
    const db = {
      collection: (name: string) => ({
        find: () => ({
          sort: () => ({
            toArray: async () => (name === 'food_safety_programs' ? programs : []),
          }),
        }),
        findOne: async () => null,
      }),
    };
    const rows = await listPrerequisiteCompliance(db as never, {
      tenantId: 't1',
      asOf: '2026-08-12',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('MISSING');
    expect(rows[0].checklistPeriod).toBe('2026-08-12');
  });
});
