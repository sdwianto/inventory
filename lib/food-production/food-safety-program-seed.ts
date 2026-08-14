/**
 * Seed + ensure Food Safety Program/Requirement per tenant (ADR-004 Fase 2 + Gelombang D).
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
import {
  BGN_HACCP_SOURCE,
  EXTRA_PRP_REQUIREMENT_SEEDS,
  resolvePrpMeta,
} from '@/lib/food-safety/prp-meta';

function applyPrpMeta(kode: string): Pick<
  FoodSafetyRequirementDoc,
  'requirementGroup' | 'bgnCode' | 'evidenceType' | 'sourceUrl'
> {
  const meta = resolvePrpMeta(kode);
  return {
    requirementGroup: meta?.requirementGroup,
    bgnCode: meta?.bgnCode,
    evidenceType: meta?.evidenceType,
    sourceUrl: BGN_HACCP_SOURCE.href,
  };
}

export async function ensureFoodSafetyProgramsSeeded(
  db: Db,
  tenantId: string,
): Promise<{ programs: number; requirements: number; seeded: boolean }> {
  const existing = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).countDocuments({ tenantId });
  const now = new Date();

  if (existing === 0) {
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
          ...applyPrpMeta(req.kode),
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
  }

  await backfillPrpRequirementMeta(db, tenantId);
  await ensureExtraPrpRequirements(db, tenantId);

  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).countDocuments({ tenantId });
  const reqCount = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).countDocuments({ tenantId });
  return { programs, requirements: reqCount, seeded: existing === 0 };
}

export async function backfillPrpRequirementMeta(db: Db, tenantId: string): Promise<number> {
  const rows = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find({ tenantId })
    .project({ id: 1, kode: 1, requirementGroup: 1, bgnCode: 1, evidenceType: 1, sourceUrl: 1 })
    .toArray() as Array<{
      id: string;
      kode: string;
      requirementGroup?: string;
      bgnCode?: string;
      evidenceType?: string;
      sourceUrl?: string;
    }>;
  let n = 0;
  const now = new Date();
  for (const row of rows) {
    const patch = applyPrpMeta(row.kode);
    if (!patch.requirementGroup) continue;
    const complete = Boolean(
      row.requirementGroup
      && row.bgnCode
      && row.evidenceType
      && row.sourceUrl,
    );
    if (complete && row.requirementGroup === patch.requirementGroup) continue;
    await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).updateOne(
      { tenantId, id: row.id },
      { $set: { ...patch, updatedAt: now } },
    );
    n += 1;
  }
  return n;
}

export async function ensureExtraPrpRequirements(db: Db, tenantId: string): Promise<number> {
  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
    .find({ tenantId })
    .project({ id: 1, kode: 1 })
    .toArray() as Array<{ id: string; kode: string }>;
  const byKode = new Map(programs.map((p) => [p.kode, p]));
  const existing = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find({ tenantId })
    .project({ kode: 1 })
    .toArray() as Array<{ kode: string }>;
  const have = new Set(existing.map((r) => r.kode));
  const now = new Date();
  const toInsert: FoodSafetyRequirementDoc[] = [];
  for (const extra of EXTRA_PRP_REQUIREMENT_SEEDS) {
    if (have.has(extra.kode)) continue;
    const program = byKode.get(extra.programKode);
    if (!program) continue;
    toInsert.push({
      id: uuidv4(),
      tenantId,
      programId: program.id,
      programKode: extra.programKode,
      kode: extra.kode,
      nama: extra.nama,
      description: extra.description,
      source: 'BGN',
      sourceRef: extra.programKode.replace('PRP-', 'BGN-PRP-'),
      ...applyPrpMeta(extra.kode),
      aktif: true,
      sortOrder: 50,
      createdAt: now,
      updatedAt: now,
    });
    have.add(extra.kode);
  }
  if (toInsert.length) {
    await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).insertMany(toInsert);
  }
  return toInsert.length;
}
