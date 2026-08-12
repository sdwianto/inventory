/**
 * Food Safety audit readiness + traceability — ADR-004 Fase 6.
 * Routes: /food-safety-readiness, /food-safety-traceability
 */

import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import { resolveOperationalScope, tenantIdForWrite } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import { buildAuditReadinessSnapshot } from '@/lib/food-production/food-safety-audit-readiness';
import {
  traceBatchBackward,
  traceLotForward,
} from '@/lib/food-production/food-safety-traceability';
import type { HandlerContext } from '@/types/api/handler';

export async function handleFoodSafetyAudit(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request } = ctx;

  if (route === '/food-safety-readiness' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tenantId = tenantIdForWrite(scopeAuth, {});
    const kitchenId = url.searchParams.get('kitchenId') || undefined;
    const lookbackDays = Number(url.searchParams.get('lookbackDays') || 30);
    const snap = await buildAuditReadinessSnapshot(db, {
      tenantId,
      kitchenId: kitchenId || undefined,
      lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 30,
    });
    return ok(snap);
  }

  if (route === '/food-safety-traceability' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const tenantId = tenantIdForWrite(scopeAuth, {});
    const batchId = url.searchParams.get('productionBatchId') || '';
    const lotId = url.searchParams.get('ingredientLotId') || '';
    if (batchId && lotId) {
      return err('Pakai salah satu: productionBatchId (backward) atau ingredientLotId (forward)', 400);
    }
    if (!batchId && !lotId) {
      return err('productionBatchId atau ingredientLotId wajib', 400);
    }

    if (batchId) {
      const result = await traceBatchBackward(db, {
        tenantId,
        productionBatchId: batchId,
      });
      if ('error' in result) return err(result.error, 404);
      return ok(result);
    }

    const result = await traceLotForward(db, {
      tenantId,
      ingredientLotId: lotId,
    });
    if ('error' in result) return err(result.error, 404);
    return ok(result);
  }

  return null;
}
