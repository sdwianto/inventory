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
import {
  PORTION_TARGETS_COLLECTION,
  emptyPortionTargets,
  normalizePortionTargets,
  type PortionTargetDoc,
} from '@/lib/food-production/portion-target';
import { isIsoDate } from '@/lib/food-production/production-plan';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import type { HandlerContext } from '@/types/api/handler';

interface TargetBody extends Record<string, unknown> {
  tanggal?: string;
  kitchenId?: string;
  targets?: unknown;
}

export async function handlePortionTargets(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request, body } = ctx;
  const targetBody = (body || {}) as TargetBody;

  if (!route.startsWith('/portion-targets')) return null;

  if (route === '/portion-targets' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tanggal = String(url.searchParams.get('tanggal') || '').trim();
    if (!isIsoDate(tanggal)) return err('Query tanggal wajib (YYYY-MM-DD)', 400);
    const kitchenId = resolveKitchenIdFilter(url, request)
      || String(url.searchParams.get('kitchenId') || '').trim();
    if (!kitchenId) return err('Dapur wajib dipilih (scope dapur / kitchenId)', 400);

    const existing = await db.collection(PORTION_TARGETS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { tanggal, kitchenId }),
    ) as PortionTargetDoc | null;

    if (!existing) {
      return ok({
        tanggal,
        kitchenId,
        targets: emptyPortionTargets(),
        exists: false,
      });
    }
    return ok({
      ...clean(existing as unknown as Record<string, unknown>),
      exists: true,
    });
  }

  if (route === '/portion-targets' && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: targetBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tanggal = String(targetBody.tanggal || '').trim();
    if (!isIsoDate(tanggal)) return err('Tanggal tidak valid (YYYY-MM-DD)', 400);
    const kitchenId = String(targetBody.kitchenId || '').trim()
      || resolveKitchenIdFilter(url, request)
      || '';
    if (!kitchenId) return err('Dapur wajib dipilih', 400);

    const targetsNorm = normalizePortionTargets(targetBody.targets);
    if ('error' in targetsNorm) return err(targetsNorm.error, 400);

    const tenantFilter = withTenantFilter(scopeAuth, {});
    const kitchen = await db.collection(KITCHENS_COLLECTION).findOne({
      ...tenantFilter,
      id: kitchenId,
    });
    if (!kitchen) return err('Dapur tidak ditemukan', 404);

    const tenantId = tenantIdForWrite(scopeAuth, targetBody);
    const now = new Date();
    const existing = await db.collection(PORTION_TARGETS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { tanggal, kitchenId }),
    ) as PortionTargetDoc | null;

    const actor = auth
      ? { updatedBy: auth.userId, updatedByName: auth.name || auth.email }
      : {};

    if (existing) {
      await db.collection(PORTION_TARGETS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id: existing.id }),
        {
          $set: {
            targets: targetsNorm,
            kitchenNama: String(kitchen.nama || ''),
            updatedAt: now,
            ...actor,
          },
        },
      );
      const saved = await db.collection(PORTION_TARGETS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: existing.id }),
      );
      await writeAuditLog(db, {
        tenantId,
        action: 'PORTION_TARGET_UPDATE',
        entityType: 'portion_target',
        entityId: existing.id,
        summary: `Acuan porsi ${tanggal} diperbarui`,
        ...auditActor(auth),
      });
      return ok(clean(saved as unknown as Record<string, unknown>));
    }

    const doc: PortionTargetDoc = {
      id: uuidv4(),
      tenantId,
      tanggal,
      kitchenId,
      kitchenNama: String(kitchen.nama || ''),
      targets: targetsNorm,
      createdAt: now,
      updatedAt: now,
      ...actor,
    };
    await db.collection(PORTION_TARGETS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'PORTION_TARGET_UPSERT',
      entityType: 'portion_target',
      entityId: doc.id,
      summary: `Acuan porsi ${tanggal} dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  return null;
}
