/**
 * Seed + ensure Food Safety Program/Requirement per tenant (ADR-004 Fase 2).
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import {
  DEFAULT_FOOD_SAFETY_PROGRAMS,
  FOOD_SAFETY_PROGRAMS_COLLECTION,
  FOOD_SAFETY_REQUIREMENTS_COLLECTION,
  type FoodSafetyProgramDoc,
  type FoodSafetyRequirementDoc,
} from '@/lib/food-production/food-safety-program';

export async function ensureFoodSafetyProgramsSeeded(
  db: Db,
  tenantId: string,
): Promise<{ programs: number; requirements: number; seeded: boolean }> {
  const existing = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).countDocuments({ tenantId });
  if (existing > 0) {
    const reqCount = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).countDocuments({ tenantId });
    return { programs: existing, requirements: reqCount, seeded: false };
  }

  const now = new Date();
  const programs: FoodSafetyProgramDoc[] = [];
  const requirements: FoodSafetyRequirementDoc[] = [];

  DEFAULT_FOOD_SAFETY_PROGRAMS.forEach((seed, idx) => {
    const programId = uuidv4();
    programs.push({
      id: programId,
      tenantId,
      kode: seed.kode,
      nama: seed.nama,
      description: seed.description,
      frequency: seed.frequency,
      responsibleRole: seed.responsibleRole,
      source: 'BGN',
      aktif: true,
      sortOrder: idx + 1,
      createdAt: now,
      updatedAt: now,
    });
    seed.requirements.forEach((req, rIdx) => {
      requirements.push({
        id: uuidv4(),
        tenantId,
        programId,
        programKode: seed.kode,
        kode: req.kode,
        nama: req.nama,
        description: req.description,
        source: 'BGN',
        sourceRef: req.sourceRef,
        aktif: true,
        sortOrder: rIdx + 1,
        createdAt: now,
        updatedAt: now,
      });
    });
  });

  if (programs.length) await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).insertMany(programs);
  if (requirements.length) {
    await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).insertMany(requirements);
  }
  return { programs: programs.length, requirements: requirements.length, seeded: true };
}
