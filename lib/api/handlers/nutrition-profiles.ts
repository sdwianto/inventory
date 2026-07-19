import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import {
  withTenantFilter,
  resolveOperationalScope,
  tenantIdForWrite,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import {
  normalizeNutritionFacts,
  analyzeRecipeNutrition,
  analyzeMenuNutrition,
  analyzePlanNutrition,
  AKG_PROFILES,
  type ProductNutritionRef,
  type NutritionFacts,
} from '@/lib/food-production/nutrition';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import {
  PRODUCTION_PLANS_COLLECTION,
  collectPlanLineRefs,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { FP_MGMT_READ_ROLES, FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import type { HandlerContext } from '@/types/api/handler';

function asNutritionRef(p: Record<string, unknown>): ProductNutritionRef {
  return {
    productId: String(p.id),
    productKode: p.kode != null ? String(p.kode) : undefined,
    productNama: p.nama != null ? String(p.nama) : undefined,
    satuan: p.satuan != null ? String(p.satuan) : undefined,
    nutrition: (p.nutrition as NutritionFacts | undefined) || null,
  };
}

export async function handleNutritionProfiles(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;

  if (route === '/nutrition-profiles' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const missingOnly = url.searchParams.get('missing') === '1';
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const filter: Record<string, unknown> = {};
    if (missingOnly) filter.nutrition = { $exists: false };
    const list = await db.collection('products')
      .find(withTenantFilter(scopeAuth, filter))
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, aktif: 1, itemRole: 1, nutrition: 1 })
      .sort({ nama: 1 })
      .limit(500)
      .toArray();

    let rows = list.map((p) => clean({
      productId: p.id,
      kode: p.kode,
      nama: p.nama,
      satuan: p.satuan,
      aktif: p.aktif !== false,
      itemRole: p.itemRole,
      hasNutrition: Boolean(p.nutrition),
      nutrition: p.nutrition || null,
    }));
    if (q) {
      rows = rows.filter((r) => {
        const hay = `${r?.kode || ''} ${r?.nama || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return ok({
      akgProfiles: AKG_PROFILES,
      items: rows,
      summary: {
        total: rows.length,
        withNutrition: rows.filter((r) => r?.hasNutrition).length,
        missing: rows.filter((r) => !r?.hasNutrition).length,
      },
    });
  }

  if (path[0] === 'nutrition-profiles' && path[1] === 'analyze' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const scope = String(url.searchParams.get('scope') || '').trim().toLowerCase();
    const id = String(url.searchParams.get('id') || '').trim();
    const akgProfile = String(url.searchParams.get('akg') || 'ANAK_SD').trim();
    if (!id) return err('id wajib');
    if (!['recipe', 'menu', 'plan'].includes(scope)) {
      return err('scope wajib recipe | menu | plan', 400);
    }

    const tenantFilter = withTenantFilter(scopeAuth, {});

    if (scope === 'recipe') {
      const recipe = await db.collection(RECIPES_COLLECTION).findOne(
        { ...tenantFilter, id },
      ) as RecipeDoc | null;
      if (!recipe) return err('Resep tidak ditemukan', 404);
      const productIds = [...new Set((recipe.lines || []).map((l) => l.productId))];
      const products = await db.collection('products')
        .find({ ...tenantFilter, id: { $in: productIds } })
        .project({ id: 1, kode: 1, nama: 1, satuan: 1, nutrition: 1 })
        .toArray();
      const productsById = new Map(products.map((p) => [String(p.id), asNutritionRef(p as Record<string, unknown>)]));
      return ok(analyzeRecipeNutrition({ recipe, productsById, akgProfile }));
    }

    if (scope === 'menu') {
      const menu = await db.collection(MENUS_COLLECTION).findOne(
        { ...tenantFilter, id },
      ) as MenuDoc | null;
      if (!menu) return err('Menu tidak ditemukan', 404);
      const recipeIds = [...new Set((menu.items || []).map((i) => i.recipeId))];
      const recipes = await db.collection(RECIPES_COLLECTION)
        .find({ ...tenantFilter, id: { $in: recipeIds } })
        .toArray() as unknown as RecipeDoc[];
      const productIds = [...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)))];
      const products = await db.collection('products')
        .find({ ...tenantFilter, id: { $in: productIds } })
        .project({ id: 1, kode: 1, nama: 1, satuan: 1, nutrition: 1 })
        .toArray();
      const analysis = analyzeMenuNutrition({
        menu,
        recipesById: new Map(recipes.map((r) => [r.id, r])),
        productsById: new Map(products.map((p) => [String(p.id), asNutritionRef(p as Record<string, unknown>)])),
        akgProfile,
      });
      if ('error' in analysis) return err(analysis.error, 400);
      return ok(analysis);
    }

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      { ...tenantFilter, id },
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana tidak ditemukan', 404);
    const { menuIds, recipeIds: directRecipeIds } = collectPlanLineRefs(plan.lines);
    const menus = menuIds.length
      ? await db.collection(MENUS_COLLECTION)
        .find({ ...tenantFilter, id: { $in: menuIds } })
        .toArray() as unknown as MenuDoc[]
      : [];
    const recipeIds = [...new Set([
      ...directRecipeIds,
      ...menus.flatMap((m) => (m.items || []).map((i) => i.recipeId)),
    ])];
    const recipes = recipeIds.length
      ? await db.collection(RECIPES_COLLECTION)
        .find({ ...tenantFilter, id: { $in: recipeIds } })
        .toArray() as unknown as RecipeDoc[]
      : [];
    const productIds = [...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)))];
    const products = await db.collection('products')
      .find({ ...tenantFilter, id: { $in: productIds } })
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, nutrition: 1 })
      .toArray();
    const analysis = analyzePlanNutrition({
      planId: plan.id,
      planNo: plan.noDokumen,
      planLines: plan.lines || [],
      menusById: new Map(menus.map((m) => [m.id, m])),
      recipesById: new Map(recipes.map((r) => [r.id, r])),
      productsById: new Map(products.map((p) => [String(p.id), asNutritionRef(p as Record<string, unknown>)])),
      akgProfile,
    });
    if ('error' in analysis) return err(analysis.error, 400);
    return ok(analysis);
  }

  if (path[0] === 'nutrition-profiles' && path[1] && path[1] !== 'analyze' && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const bodyRecord = (body || {}) as Record<string, unknown>;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: bodyRecord, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productId = path[1];
    const product = await db.collection('products').findOne(
      withTenantFilter(scopeAuth, { id: productId }),
    );
    if (!product) return err('Produk tidak ditemukan', 404);

    const normalized = normalizeNutritionFacts((body as { nutrition?: unknown })?.nutrition ?? body);
    if ('error' in normalized) return err(normalized.error, 400);

    const now = new Date();
    const nutrition = { ...normalized, updatedAt: now };
    await db.collection('products').updateOne(
      withTenantFilter(scopeAuth, { id: productId }),
      { $set: { nutrition, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: tenantIdForWrite(scopeAuth, bodyRecord),
      action: 'NUTRITION_UPSERT',
      entityType: 'product_nutrition',
      entityId: productId,
      summary: `Gizi produk ${String(product.kode || product.nama || productId)} diperbarui`,
      ...auditActor(auth),
    });
    return ok(clean({ productId, nutrition }));
  }

  return null;
}
