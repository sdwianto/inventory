import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { isIngredientRole } from '@/lib/food-production/item-role';
import { portionExceptionMatchSet } from '@/lib/food-production/recipe';
import {
  RECIPE_PORTION_EXCEPTIONS_COLLECTION,
  type RecipePortionExceptionDoc,
} from '@/lib/food-production/recipe-portion-exception';
import type { HandlerContext } from '@/types/api/handler';
import type { NextResponse } from 'next/server';

export async function loadRecipePortionExceptionSet(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
): Promise<Set<string>> {
  const rows = await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION)
    .find(tenantFilter)
    .project({ productId: 1, productKode: 1 })
    .toArray();
  return portionExceptionMatchSet(rows);
}

export async function handleRecipePortionExceptions(
  ctx: HandlerContext,
): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  if (!route.startsWith('/recipe-portion-exceptions')) return null;

  const payload = (body || {}) as Record<string, unknown>;

  if (route === '/recipe-portion-exceptions' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const list = await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION)
      .find(withTenantFilter(scopeAuth, {}))
      .sort({ productKode: 1, productNama: 1 })
      .limit(500)
      .toArray();
    return ok(list.map((doc) => clean(doc as unknown as Record<string, unknown>)));
  }

  if (route === '/recipe-portion-exceptions' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: payload, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productId = String(payload.productId || '').trim();
    if (!productId) return err('productId wajib', 400);

    const tenantFilter = withTenantFilter(scopeAuth, {});
    const product = await db.collection('products').findOne({
      ...tenantFilter,
      id: productId,
    }) as {
      id?: string;
      kode?: string;
      nama?: string;
      itemRole?: string;
      aktif?: boolean;
    } | null;
    if (!product) return err('Produk tidak ditemukan', 404);
    if (product.aktif === false) return err('Produk nonaktif', 400);
    if (!isIngredientRole(product.itemRole)) {
      return err('Hanya bahan resep yang boleh masuk daftar pengecualian', 400);
    }

    const existing = await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { productId }),
    ) as RecipePortionExceptionDoc | null;
    if (existing) {
      return ok(clean(existing as unknown as Record<string, unknown>));
    }

    const tenantId = tenantIdForWrite(scopeAuth, payload);
    const now = new Date();
    const actor = auditActor(auth);
    const doc: RecipePortionExceptionDoc = {
      id: uuidv4(),
      tenantId,
      productId,
      productKode: product.kode != null ? String(product.kode) : undefined,
      productNama: product.nama != null ? String(product.nama) : undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    try {
      await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION).insertOne(doc);
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? Number((e as { code?: number }).code) : 0;
      if (code === 11000) {
        const again = await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { productId }),
        );
        if (again) return ok(clean(again as unknown as Record<string, unknown>));
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'RECIPE_PORTION_EXCEPTION_CREATE',
      entityType: 'recipe_portion_exception',
      entityId: doc.id,
      summary: `Pengecualian porsi 100%: ${doc.productKode || productId}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'recipe-portion-exceptions' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as RecipePortionExceptionDoc | null;
    if (!existing) return err('Pengecualian tidak ditemukan', 404);

    await db.collection(RECIPE_PORTION_EXCEPTIONS_COLLECTION).deleteOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'RECIPE_PORTION_EXCEPTION_DELETE',
      entityType: 'recipe_portion_exception',
      entityId: id,
      summary: `Hapus pengecualian porsi: ${existing.productKode || existing.productId}`,
      ...auditActor(auth),
    });
    return ok({ id, deleted: true });
  }

  return null;
}
