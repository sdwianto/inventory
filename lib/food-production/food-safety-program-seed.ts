/**
 * Seed + ensure Food Safety Program/Requirement per tenant (ADR-004 Fase 2 + Gelombang D).
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { normalizeTenantId, tenantIdMatchFilter } from '@/lib/api/tenant-scope';
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

function isDupKey(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: number }).code === 11000);
}

function catalogKode(raw: unknown): string {
  return String(raw || '').trim().toUpperCase();
}

type CatalogRow = {
  id: string;
  tenantId?: string;
  kode?: string;
  aktif?: boolean;
  createdAt?: Date;
};

function pickKeeper<T extends CatalogRow>(rows: T[], tenantId: string): T {
  return [...rows].sort((a, b) => {
    const aExact = a.tenantId === tenantId ? 1 : 0;
    const bExact = b.tenantId === tenantId ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    const aAktif = a.aktif !== false ? 1 : 0;
    const bAktif = b.aktif !== false ? 1 : 0;
    if (aAktif !== bAktif) return bAktif - aAktif;
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return at - bt;
  })[0];
}

/**
 * Rapikan program/requirement dobel (race seed, atau tenantId beda kapital).
 * Unique program adalah tenantId+kode (case-sensitive) — salinan huruf besar/kecil lolos index
 * lalu tampil bersama karena GET memakai regex case-insensitive.
 */
export async function dedupeFoodSafetyCatalog(
  db: Db,
  tenantId: string,
): Promise<{ programsRetired: number; requirementsRetired: number }> {
  const now = new Date();
  const tenantFilter = tenantIdMatchFilter(tenantId);
  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
    .find(tenantFilter)
    .project({ id: 1, tenantId: 1, kode: 1, aktif: 1, createdAt: 1 })
    .toArray() as CatalogRow[];
  const requirements = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find(tenantFilter)
    .project({ id: 1, tenantId: 1, kode: 1, aktif: 1, createdAt: 1 })
    .toArray() as CatalogRow[];

  let programsRetired = 0;
  let requirementsRetired = 0;

  async function retireExtras(
    collection: string,
    rows: CatalogRow[],
  ): Promise<number> {
    const byKode = new Map<string, CatalogRow[]>();
    for (const row of rows) {
      const kode = catalogKode(row.kode);
      if (!kode || kode.includes('__DUP__')) continue;
      const list = byKode.get(kode) || [];
      list.push(row);
      byKode.set(kode, list);
    }
    let retired = 0;
    for (const [kode, list] of byKode) {
      const keeper = pickKeeper(list, tenantId);
      if (keeper.tenantId !== tenantId || keeper.aktif === false || catalogKode(keeper.kode) !== kode) {
        await db.collection(collection).updateOne(
          { id: keeper.id },
          { $set: { tenantId, aktif: true, kode, updatedAt: now } },
        );
      }
      for (const extra of list) {
        if (extra.id === keeper.id) continue;
        await db.collection(collection).updateOne(
          { id: extra.id },
          {
            $set: {
              aktif: false,
              kode: `${kode}__DUP__${String(extra.id).slice(0, 8)}`,
              updatedAt: now,
            },
          },
        );
        retired += 1;
      }
    }
    return retired;
  }

  requirementsRetired = await retireExtras(FOOD_SAFETY_REQUIREMENTS_COLLECTION, requirements);
  programsRetired = await retireExtras(FOOD_SAFETY_PROGRAMS_COLLECTION, programs);
  return { programsRetired, requirementsRetired };
}

export async function ensureFoodSafetyProgramsSeeded(
  db: Db,
  rawTenantId: string,
): Promise<{ programs: number; requirements: number; seeded: boolean }> {
  const tenantId = normalizeTenantId(rawTenantId);
  const tenantFilter = tenantIdMatchFilter(tenantId);
  const existing = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).countDocuments(tenantFilter);
  const now = new Date();
  let seeded = false;

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

    try {
      if (programs.length) await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).insertMany(programs);
      if (requirements.length) {
        await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).insertMany(requirements);
      }
      seeded = true;
    } catch (e) {
      if (!isDupKey(e)) throw e;
    }
  }

  await dedupeFoodSafetyCatalog(db, tenantId);
  await backfillPrpRequirementMeta(db, tenantId);
  await ensureExtraPrpRequirements(db, tenantId);

  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).countDocuments({
    ...tenantFilter,
    aktif: true,
  });
  const reqCount = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).countDocuments({
    ...tenantFilter,
    aktif: true,
  });
  return { programs, requirements: reqCount, seeded };
}

export async function backfillPrpRequirementMeta(db: Db, rawTenantId: string): Promise<number> {
  const tenantId = normalizeTenantId(rawTenantId);
  const rows = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find(tenantIdMatchFilter(tenantId))
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
    if (catalogKode(row.kode).includes('__DUP__')) continue;
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
      { id: row.id },
      { $set: { ...patch, updatedAt: now } },
    );
    n += 1;
  }
  return n;
}

export async function ensureExtraPrpRequirements(db: Db, rawTenantId: string): Promise<number> {
  const tenantId = normalizeTenantId(rawTenantId);
  const tenantFilter = tenantIdMatchFilter(tenantId);
  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
    .find({ ...tenantFilter, aktif: { $ne: false } })
    .project({ id: 1, kode: 1, tenantId: 1 })
    .toArray() as Array<{ id: string; kode: string; tenantId?: string }>;
  const byKode = new Map<string, { id: string; kode: string }>();
  for (const p of programs) {
    const kode = catalogKode(p.kode);
    if (!kode || kode.includes('__DUP__')) continue;
    const prev = byKode.get(kode);
    if (!prev || p.tenantId === tenantId) byKode.set(kode, { id: p.id, kode });
  }
  const existing = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find(tenantFilter)
    .project({ kode: 1, aktif: 1 })
    .toArray() as Array<{ kode: string; aktif?: boolean }>;
  const have = new Set(
    existing
      .filter((r) => r.aktif !== false)
      .map((r) => catalogKode(r.kode))
      .filter((k) => k && !k.includes('__DUP__')),
  );
  const now = new Date();
  const toInsert: FoodSafetyRequirementDoc[] = [];
  for (const extra of EXTRA_PRP_REQUIREMENT_SEEDS) {
    if (have.has(catalogKode(extra.kode))) continue;
    const program = byKode.get(catalogKode(extra.programKode));
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
    have.add(catalogKode(extra.kode));
  }
  if (toInsert.length) {
    try {
      await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).insertMany(toInsert);
    } catch (e) {
      if (!isDupKey(e)) throw e;
    }
  }
  return toInsert.length;
}
