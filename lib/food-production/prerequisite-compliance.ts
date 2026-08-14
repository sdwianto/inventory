/**
 * ADR-004 Fase 2 — deteksi checklist prerequisite yang belum tercatat untuk periode berjalan.
 */

import type { Db } from 'mongodb';
import {
  FOOD_SAFETY_PROGRAMS_COLLECTION,
  FOOD_SAFETY_REQUIREMENTS_COLLECTION,
  resolveChecklistPeriod,
  type FoodSafetyProgramDoc,
  type FoodSafetyProgramFrequency,
  type FoodSafetyRequirementDoc,
} from '@/lib/food-production/food-safety-program';
import { QC_RESULTS_COLLECTION, type QcResultDoc } from '@/lib/food-production/qc';

export type PrerequisiteComplianceRow = {
  programId: string;
  programKode: string;
  programNama: string;
  frequency: FoodSafetyProgramFrequency;
  checklistPeriod: string;
  status: 'RECORDED' | 'MISSING';
  resultId?: string;
  resultNo?: string;
  kitchenId?: string;
};

export async function listPrerequisiteCompliance(
  db: Db,
  input: {
    tenantId: string;
    asOf?: string;
    kitchenId?: string;
  },
): Promise<PrerequisiteComplianceRow[]> {
  const asOf = String(input.asOf || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
    .find({ tenantId: input.tenantId, aktif: true })
    .sort({ sortOrder: 1, kode: 1 })
    .toArray() as unknown as FoodSafetyProgramDoc[];

  const out: PrerequisiteComplianceRow[] = [];
  for (const prog of programs) {
    const checklistPeriod = resolveChecklistPeriod(asOf, prog.frequency);
    const filter: Record<string, unknown> = {
      tenantId: input.tenantId,
      programId: prog.id,
      checklistPeriod,
      status: { $in: ['COMPLETED', 'SUBMITTED', 'APPROVED'] },
      category: 'PREREQUISITE',
    };
    if (input.kitchenId?.trim()) filter.kitchenId = input.kitchenId.trim();

    const result = await db.collection(QC_RESULTS_COLLECTION).findOne(
      filter,
      { sort: { updatedAt: -1 }, projection: { id: 1, noDokumen: 1, kitchenId: 1 } },
    ) as Pick<QcResultDoc, 'id' | 'noDokumen' | 'kitchenId'> | null;

    // Fallback: kategori PREREQUISITE tanpa programId (template QC-PRP generik).
    let fallback = result;
    if (!fallback) {
      fallback = await db.collection(QC_RESULTS_COLLECTION).findOne(
        {
          tenantId: input.tenantId,
          category: 'PREREQUISITE',
          checklistPeriod,
          status: { $in: ['COMPLETED', 'SUBMITTED', 'APPROVED'] },
          ...(input.kitchenId?.trim() ? { kitchenId: input.kitchenId.trim() } : {}),
        },
        { sort: { updatedAt: -1 }, projection: { id: 1, noDokumen: 1, kitchenId: 1 } },
      ) as Pick<QcResultDoc, 'id' | 'noDokumen' | 'kitchenId'> | null;
    }

    out.push({
      programId: prog.id,
      programKode: prog.kode,
      programNama: prog.nama,
      frequency: prog.frequency,
      checklistPeriod,
      status: fallback ? 'RECORDED' : 'MISSING',
      resultId: fallback?.id,
      resultNo: fallback?.noDokumen,
      kitchenId: fallback?.kitchenId || input.kitchenId,
    });
  }
  return out;
}

export type PrerequisiteItemComplianceRow = {
  requirementId: string;
  programId: string;
  kode: string;
  checklistPeriod: string;
  status: 'RECORDED' | 'MISSING';
  resultId?: string;
};

/**
 * Gelombang D — Ada/Belum per item requirement (bukan seluruh program).
 * Hanya QC yang tertaut requirementId yang menghitung "Ada".
 */
export async function listPrerequisiteItemCompliance(
  db: Db,
  input: {
    tenantId: string;
    asOf?: string;
    kitchenId?: string;
  },
): Promise<PrerequisiteItemComplianceRow[]> {
  const asOf = String(input.asOf || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
    .find({ tenantId: input.tenantId, aktif: true })
    .project({ id: 1, frequency: 1 })
    .toArray() as unknown as Array<Pick<FoodSafetyProgramDoc, 'id' | 'frequency'>>;
  const periodByProgram = new Map<string, string>();
  const periods = new Set<string>();
  for (const p of programs) {
    const period = resolveChecklistPeriod(asOf, p.frequency as FoodSafetyProgramFrequency);
    periodByProgram.set(p.id, period);
    periods.add(period);
  }

  const reqs = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find({ tenantId: input.tenantId, aktif: true })
    .project({ id: 1, programId: 1, kode: 1 })
    .toArray() as unknown as Array<Pick<FoodSafetyRequirementDoc, 'id' | 'programId' | 'kode'>>;

  const qcFilter: Record<string, unknown> = {
    tenantId: input.tenantId,
    category: 'PREREQUISITE',
    status: { $in: ['COMPLETED', 'SUBMITTED', 'APPROVED'] },
    checklistPeriod: { $in: [...periods] },
    requirementId: { $exists: true, $type: 'string' },
  };
  if (input.kitchenId?.trim()) qcFilter.kitchenId = input.kitchenId.trim();

  const qcs = await db.collection(QC_RESULTS_COLLECTION)
    .find(qcFilter)
    .project({ requirementId: 1, id: 1, checklistPeriod: 1 })
    .toArray() as Array<{ requirementId?: string; id: string; checklistPeriod?: string }>;

  const byReq = new Map<string, { id: string }>();
  for (const q of qcs) {
    const rid = String(q.requirementId || '').trim();
    if (!rid || byReq.has(rid)) continue;
    byReq.set(rid, { id: q.id });
  }

  return reqs.map((r) => {
    const hit = byReq.get(r.id);
    return {
      requirementId: r.id,
      programId: r.programId,
      kode: r.kode,
      checklistPeriod: periodByProgram.get(r.programId) || asOf,
      status: hit ? 'RECORDED' : 'MISSING',
      resultId: hit?.id,
    };
  });
}
