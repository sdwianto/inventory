/**
 * Food Safety Program + Requirement API — ADR-004 Fase 2.
 * Routes: /food-safety-programs | /food-safety-requirements
 */

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { FP_MANAGE_ROLES, FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import {
  FOOD_SAFETY_PROGRAMS_COLLECTION,
  FOOD_SAFETY_REQUIREMENTS_COLLECTION,
  normalizeFoodSafetyProgramFrequency,
  normalizeFoodSafetyProgramSource,
  type FoodSafetyProgramDoc,
  type FoodSafetyRequirementDoc,
} from '@/lib/food-production/food-safety-program';
import { ensureFoodSafetyProgramsSeeded } from '@/lib/food-production/food-safety-program-seed';
import { listPrerequisiteCompliance } from '@/lib/food-production/prerequisite-compliance';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import type { HandlerContext } from '@/types/api/handler';

export async function handleFoodSafetyPrograms(
  ctx: HandlerContext,
): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const b = (body || {}) as Record<string, unknown>;

  if (route === '/food-safety-programs' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    await ensureFoodSafetyProgramsSeeded(db, tenantId);

    const onlyActive = url.searchParams.get('aktif') === '1';
    const filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    const list = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ sortOrder: 1, kode: 1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  // ADR-004 Fase 2 — status kepatuhan periode (MISSING / RECORDED).
  if (route === '/food-safety-programs/compliance' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    await ensureFoodSafetyProgramsSeeded(db, tenantId);
    const asOf = url.searchParams.get('asOf') || undefined;
    const kitchenId = resolveKitchenIdFilter(url, request)
      || url.searchParams.get('kitchenId')
      || undefined;
    const rows = await listPrerequisiteCompliance(db, { tenantId, asOf, kitchenId });
    const missing = rows.filter((r) => r.status === 'MISSING').length;
    return ok({ asOf: asOf || new Date().toISOString().slice(0, 10), kitchenId, missing, rows });
  }

  if (route === '/food-safety-programs' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const kode = String(b.kode || '').trim().toUpperCase();
    const nama = String(b.nama || '').trim();
    if (!kode || !nama) return err('kode dan nama wajib', 400);
    const frequency = normalizeFoodSafetyProgramFrequency(b.frequency);
    if (typeof frequency !== 'string') return err(frequency.error, 400);
    const source = normalizeFoodSafetyProgramSource(b.source);
    if (typeof source !== 'string') return err(source.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const now = new Date();
    const doc: FoodSafetyProgramDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      description: String(b.description || '').trim() || undefined,
      frequency,
      responsibleRole: String(b.responsibleRole || '').trim() || undefined,
      source,
      aktif: b.aktif !== false,
      sortOrder: Number(b.sortOrder) > 0 ? Number(b.sortOrder) : 99,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err(`Kode program ${kode} sudah dipakai`, 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'FS_PROGRAM_CREATE',
      entityType: 'food_safety_program',
      entityId: doc.id,
      summary: `Program prerequisite ${doc.kode}`,
      metadata: { frequency, source },
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (route === '/food-safety-requirements' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    await ensureFoodSafetyProgramsSeeded(db, tenantId);

    const programId = url.searchParams.get('programId') || undefined;
    const onlyActive = url.searchParams.get('aktif') === '1';
    const filter: Record<string, unknown> = {};
    if (programId) filter.programId = programId;
    if (onlyActive) filter.aktif = true;
    const list = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ sortOrder: 1, kode: 1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/food-safety-requirements' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const programId = String(b.programId || '').trim();
    const kode = String(b.kode || '').trim().toUpperCase();
    const nama = String(b.nama || '').trim();
    if (!programId || !kode || !nama) return err('programId, kode, dan nama wajib', 400);
    const source = normalizeFoodSafetyProgramSource(b.source);
    if (typeof source !== 'string') return err(source.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const program = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: programId }),
    ) as FoodSafetyProgramDoc | null;
    if (!program) return err('Program tidak ditemukan', 404);

    const now = new Date();
    const doc: FoodSafetyRequirementDoc = {
      id: uuidv4(),
      tenantId,
      programId,
      programKode: program.kode,
      kode,
      nama,
      description: String(b.description || '').trim() || undefined,
      source,
      sourceRef: String(b.sourceRef || '').trim() || undefined,
      aktif: b.aktif !== false,
      sortOrder: Number(b.sortOrder) > 0 ? Number(b.sortOrder) : 99,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err(`Kode requirement ${kode} sudah dipakai di program ini`, 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'FS_REQUIREMENT_CREATE',
      entityType: 'food_safety_requirement',
      entityId: doc.id,
      summary: `Requirement ${doc.kode} · program ${program.kode}`,
      metadata: { programId, source },
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  // GET one program
  if (path[0] === 'food-safety-programs' && path[1] && path[1] !== 'compliance' && !path[2] && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Program tidak ditemukan', 404);
    const requirements = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { programId: path[1], aktif: true }))
      .sort({ sortOrder: 1 })
      .toArray();
    return ok(clean({
      ...(existing as Record<string, unknown>),
      requirements: requirements.map((r) => clean(r as Record<string, unknown>)),
    }));
  }

  return null;
}
