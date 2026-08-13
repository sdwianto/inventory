/**
 * ADR-004 Fase 2 — deteksi checklist prerequisite yang belum tercatat untuk periode berjalan.
 */

import type { Db } from 'mongodb';
import {
  FOOD_SAFETY_PROGRAMS_COLLECTION,
  resolveChecklistPeriod,
  type FoodSafetyProgramDoc,
  type FoodSafetyProgramFrequency,
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
