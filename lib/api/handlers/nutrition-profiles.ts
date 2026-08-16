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
  analyzePlanDraftNutrition,
  analyzePlanLineNutrition,
  analyzeResultNutrition,
  AKG_PROFILES,
  AKG_PROFILE_OPTIONS,
  type ProductNutritionRef,
  type NutritionFacts,
} from '@/lib/food-production/nutrition';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import {
  PRODUCTION_PLANS_COLLECTION,
  collectPlanLineRefs,
  type ProductionPlanDoc,
  type ProductionPlanLine,
  type KategoriPorsi,
} from '@/lib/food-production/production-plan';
import {
  PRODUCTION_RESULTS_COLLECTION,
  type ProductionResultDoc,
} from '@/lib/food-production/production-result';
import { FP_MGMT_READ_ROLES, FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import {
  searchTkpiFoods,
  getTkpiFood,
  nutritionFromTkpiCode,
  akgProfileMeta,
} from '@/lib/food-production/tkpi-catalog';
import {
  searchUsdaFoods,
  getUsdaFood,
  nutritionFromUsdaCode,
} from '@/lib/food-production/usda-catalog';
import type { HandlerContext } from '@/types/api/handler';

function asNutritionRef(p: Record<string, unknown>): ProductNutritionRef {
  return {
    productId: String(p.id),
    productKode: p.kode != null ? String(p.kode) : undefined,
    productNama: p.nama != null ? String(p.nama) : undefined,
    satuan: p.satuan != null ? String(p.satuan) : undefined,
    tkpiCode: p.tkpiCode != null ? String(p.tkpiCode) : undefined,
    usdaCode: p.usdaCode != null ? String(p.usdaCode) : undefined,
    recipeBaseGrams: p.recipeBaseGrams != null ? Number(p.recipeBaseGrams) : undefined,
    nutrition: (p.nutrition as NutritionFacts | undefined) || null,
  };
}

async function loadProductsByIds(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  productIds: string[],
): Promise<Map<string, ProductNutritionRef>> {
  if (!productIds.length) return new Map();
  const products = await db.collection('products')
    .find({ ...tenantFilter, id: { $in: productIds } })
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, nutrition: 1, tkpiCode: 1, usdaCode: 1, recipeBaseGrams: 1 })
    .toArray();
  return new Map(products.map((p) => [String(p.id), asNutritionRef(p as Record<string, unknown>)]));
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
      .project({ id: 1, kode: 1, nama: 1, satuan: 1, aktif: 1, itemRole: 1, nutrition: 1, tkpiCode: 1, usdaCode: 1 })
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
      tkpiCode: p.tkpiCode || (p.nutrition as NutritionFacts | undefined)?.tkpiCode || null,
      usdaCode: p.usdaCode || (p.nutrition as NutritionFacts | undefined)?.usdaCode || null,
      hasNutrition: Boolean(p.nutrition),
      nutrition: p.nutrition || null,
    }));
    if (q) {
      rows = rows.filter((r) => {
        const hay = `${r?.kode || ''} ${r?.nama || ''} ${r?.tkpiCode || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return ok({
      akgProfiles: AKG_PROFILES,
      akgProfileOptions: AKG_PROFILE_OPTIONS.length ? AKG_PROFILE_OPTIONS : akgProfileMeta(),
      items: rows,
      summary: {
        total: rows.length,
        withNutrition: rows.filter((r) => r?.hasNutrition).length,
        missing: rows.filter((r) => !r?.hasNutrition).length,
      },
    });
  }

  if (path[0] === 'nutrition-profiles' && path[1] === 'tkpi' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const q = String(url.searchParams.get('q') || '').trim();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40));
    const kode = String(url.searchParams.get('kode') || '').trim();
    if (kode) {
      const row = getTkpiFood(kode);
      if (row) return ok({ item: row, source: 'TKPI' });
      const usda = getUsdaFood(kode);
      if (!usda) return err('Kode gizi tidak ditemukan', 404);
      return ok({ item: usda, source: 'USDA' });
    }
    return ok({
      items: searchTkpiFoods(q, limit),
      usdaItems: searchUsdaFoods(q, limit),
      akgProfileOptions: AKG_PROFILE_OPTIONS,
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
    const akgProfile = String(url.searchParams.get('akg') || 'PORSI_KECIL').trim();
    if (!id) return err('id wajib');
    if (!['recipe', 'menu', 'plan', 'result'].includes(scope)) {
      return err('scope wajib recipe | menu | plan | result', 400);
    }

    const tenantFilter = withTenantFilter(scopeAuth, {});

    if (scope === 'recipe') {
      const recipe = await db.collection(RECIPES_COLLECTION).findOne(
        { ...tenantFilter, id },
      ) as RecipeDoc | null;
      if (!recipe) return err('Resep tidak ditemukan', 404);
      const productIds = [...new Set((recipe.lines || []).map((l) => l.productId))];
      const productsById = await loadProductsByIds(db, tenantFilter, productIds);
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
      const analysis = analyzeMenuNutrition({
        menu,
        recipesById: new Map(recipes.map((r) => [r.id, r])),
        productsById: await loadProductsByIds(db, tenantFilter, productIds),
        akgProfile,
      });
      if ('error' in analysis) return err(analysis.error, 400);
      return ok(analysis);
    }

    if (scope === 'result') {
      const result = await db.collection(PRODUCTION_RESULTS_COLLECTION).findOne(
        { ...tenantFilter, id },
      ) as ProductionResultDoc | null;
      if (!result) return err('Hasil produksi tidak ditemukan', 404);
      const recipeIds = [...new Set((result.lines || []).map((l) => l.recipeId).filter(Boolean))];
      const recipes = recipeIds.length
        ? await db.collection(RECIPES_COLLECTION)
          .find({ ...tenantFilter, id: { $in: recipeIds } })
          .toArray() as unknown as RecipeDoc[]
        : [];
      const productIds = [...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)))];
      const productsById = await loadProductsByIds(db, tenantFilter, productIds);
      const recipesById = new Map(recipes.map((r) => [r.id, r]));
      const analysis = analyzeResultNutrition({
        resultId: result.id,
        resultNo: result.noDokumen,
        resultLines: result.lines || [],
        recipesById,
        productsById,
        akgProfile,
      });
      if ('error' in analysis) return err(analysis.error, 400);
      const lineEstimates = (result.lines || []).map((l, idx) => {
        const recipe = recipesById.get(l.recipeId);
        if (!recipe) {
          return { index: idx, recipeId: l.recipeId, perPorsi: null, perPorsiAkgPct: null, missing: true };
        }
        const a = analyzeRecipeNutrition({ recipe, productsById, akgProfile });
        return {
          index: idx,
          recipeId: l.recipeId,
          targetPorsi: l.actualPorsi,
          perPorsi: a.perPorsi,
          perPorsiAkgPct: a.perPorsiAkgPct,
          missingProductIds: a.missingProductIds,
          warnings: a.warnings,
        };
      });
      return ok({ ...analysis, lineEstimates });
    }

    if (scope !== 'plan') return err('scope wajib recipe | menu | plan | result', 400);

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
    const productsById = await loadProductsByIds(db, tenantFilter, productIds);
    const recipesById = new Map(recipes.map((r) => [r.id, r]));
    const analysis = analyzePlanNutrition({
      planId: plan.id,
      planNo: plan.noDokumen,
      planLines: plan.lines || [],
      menusById: new Map(menus.map((m) => [m.id, m])),
      recipesById,
      productsById,
      akgProfile,
    });
    if ('error' in analysis) return err(analysis.error, 400);
    const lineEstimates = (plan.lines || []).map((l, idx) => {
      if (!l.recipeId) {
        return { index: idx, recipeId: null, menuId: l.menuId || null, perPorsi: null, perPorsiAkgPct: null, missing: true };
      }
      const recipe = recipesById.get(l.recipeId);
      if (!recipe) {
        return { index: idx, recipeId: l.recipeId, perPorsi: null, perPorsiAkgPct: null, missing: true };
      }
      const a = analyzePlanLineNutrition({
        recipe,
        productsById,
        planLine: l,
        akgProfile,
      });
      return {
        index: idx,
        recipeId: l.recipeId,
        targetPorsi: l.targetPorsi,
        perPorsi: a.perPorsi,
        perPorsiAkgPct: a.perPorsiAkgPct,
        akgProfile: a.akgProfile,
        missingProductIds: a.missingProductIds,
        warnings: a.warnings,
      };
    });
    return ok({ ...analysis, lineEstimates });
  }

  if (path[0] === 'nutrition-profiles' && path[1] === 'analyze-draft' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const bodyRecord = (body || {}) as Record<string, unknown>;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: bodyRecord, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const akgProfile = String(bodyRecord.akg || 'PORSI_KECIL').trim();
    const acuanRaw = bodyRecord.acuanByKategori;
    const acuanByKategori = acuanRaw && typeof acuanRaw === 'object' && !Array.isArray(acuanRaw)
      ? Object.fromEntries(
        Object.entries(acuanRaw as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]),
      )
      : null;
    const rawLines = Array.isArray(bodyRecord.lines) ? bodyRecord.lines : [];
    const lines = rawLines.map((row) => {
      const r = row as Record<string, unknown>;
      const kpRaw = r.kategoriPorsiList;
      const kategoriPorsiList = Array.isArray(kpRaw)
        ? kpRaw.map((x) => String(x)).filter(Boolean) as KategoriPorsi[]
        : undefined;
      const legacyKp = r.kategoriPorsi ? String(r.kategoriPorsi) : undefined;
      const kpList = kategoriPorsiList?.length
        ? kategoriPorsiList
        : (legacyKp ? [legacyKp as KategoriPorsi] : undefined);
      return {
        recipeId: r.recipeId ? String(r.recipeId) : undefined,
        menuId: r.menuId ? String(r.menuId) : undefined,
        targetPorsi: Number(r.targetPorsi) || 0,
        kategoriPorsiList: kpList,
      } satisfies Partial<ProductionPlanLine> & { targetPorsi: number };
    }).filter((l) => (l.recipeId || l.menuId) && (Number(l.targetPorsi) || 0) > 0);

    if (!lines.length) return err('lines wajib (recipeId/menuId + targetPorsi)');

    const tenantFilter = withTenantFilter(scopeAuth, {});
    const recipeIds = [...new Set(lines.map((l) => l.recipeId).filter(Boolean) as string[])];
    const menuIds = [...new Set(lines.map((l) => l.menuId).filter(Boolean) as string[])];
    const menus = menuIds.length
      ? await db.collection(MENUS_COLLECTION)
        .find({ ...tenantFilter, id: { $in: menuIds } })
        .toArray() as unknown as MenuDoc[]
      : [];
    const allRecipeIds = [...new Set([
      ...recipeIds,
      ...menus.flatMap((m) => (m.items || []).map((i) => i.recipeId)),
    ])];
    const recipes = allRecipeIds.length
      ? await db.collection(RECIPES_COLLECTION)
        .find({ ...tenantFilter, id: { $in: allRecipeIds } })
        .toArray() as unknown as RecipeDoc[]
      : [];
    const productIds = [...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.productId)))];
    const productsById = await loadProductsByIds(db, tenantFilter, productIds);
    const recipesById = new Map(recipes.map((r) => [r.id, r]));
    const analysis = analyzePlanDraftNutrition({
      lines,
      menusById: new Map(menus.map((m) => [m.id, m])),
      recipesById,
      productsById,
      akgProfile,
      acuanByKategori,
    });
    if ('error' in analysis) return err(analysis.error, 400);
    const lineEstimates = lines.map((l, idx) => {
      if (!l.recipeId) {
        return { index: idx, recipeId: null, perPorsi: null, perPorsiAkgPct: null, missing: true };
      }
      const recipe = recipesById.get(l.recipeId);
      if (!recipe) {
        return { index: idx, recipeId: l.recipeId, perPorsi: null, perPorsiAkgPct: null, missing: true };
      }
      const a = analyzePlanLineNutrition({
        recipe,
        productsById,
        planLine: l as ProductionPlanLine,
        akgProfile,
        acuanByKategori,
      });
      return {
        index: idx,
        recipeId: l.recipeId,
        targetPorsi: l.targetPorsi,
        perPorsi: a.perPorsi,
        perPorsiAkgPct: a.perPorsiAkgPct,
        akgProfile: a.akgProfile,
        missingProductIds: a.missingProductIds,
        warnings: a.warnings,
      };
    });

    return ok({ ...analysis, lineEstimates });
  }

  if (
    path[0] === 'nutrition-profiles'
    && path[1]
    && path[2] === 'apply-tkpi'
    && method === 'POST'
  ) {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const bodyRecord = (body || {}) as Record<string, unknown>;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: bodyRecord, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productId = path[1];
    const tkpiCode = String(bodyRecord.tkpiCode || '').trim();
    if (!tkpiCode) return err('tkpiCode wajib');

    const product = await db.collection('products').findOne(
      withTenantFilter(scopeAuth, { id: productId }),
    );
    if (!product) return err('Produk tidak ditemukan', 404);

    const facts = nutritionFromTkpiCode(tkpiCode, product.satuan != null ? String(product.satuan) : null);
    if (!facts) return err('Kode TKPI tidak ditemukan', 404);

    const normalized = normalizeNutritionFacts(facts);
    if ('error' in normalized) return err(normalized.error, 400);

    const now = new Date();
    const nutrition = { ...normalized, updatedAt: now };
    await db.collection('products').updateOne(
      withTenantFilter(scopeAuth, { id: productId }),
      { $set: { nutrition, tkpiCode: facts.tkpiCode, updatedAt: now }, $unset: { usdaCode: 1 } },
    );
    await writeAuditLog(db, {
      tenantId: tenantIdForWrite(scopeAuth, bodyRecord),
      action: 'NUTRITION_APPLY_TKPI',
      entityType: 'product_nutrition',
      entityId: productId,
      summary: `Gizi ${String(product.kode || product.nama || productId)} dari TKPI ${facts.tkpiCode}`,
      ...auditActor(auth),
    });
    return ok(clean({ productId, tkpiCode: facts.tkpiCode, nutrition }));
  }

  if (
    path[0] === 'nutrition-profiles'
    && path[1]
    && path[2] === 'apply-usda'
    && method === 'POST'
  ) {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const bodyRecord = (body || {}) as Record<string, unknown>;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: bodyRecord, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productId = path[1];
    const usdaCode = String(bodyRecord.usdaCode || '').trim();
    if (!usdaCode) return err('usdaCode wajib');

    const product = await db.collection('products').findOne(
      withTenantFilter(scopeAuth, { id: productId }),
    );
    if (!product) return err('Produk tidak ditemukan', 404);

    const facts = nutritionFromUsdaCode(usdaCode, product.satuan != null ? String(product.satuan) : null);
    if (!facts) return err('Kode USDA tidak ditemukan', 404);

    const normalized = normalizeNutritionFacts(facts);
    if ('error' in normalized) return err(normalized.error, 400);

    const now = new Date();
    const nutrition = { ...normalized, updatedAt: now };
    await db.collection('products').updateOne(
      withTenantFilter(scopeAuth, { id: productId }),
      { $set: { nutrition, usdaCode: facts.usdaCode, updatedAt: now }, $unset: { tkpiCode: 1 } },
    );
    await writeAuditLog(db, {
      tenantId: tenantIdForWrite(scopeAuth, bodyRecord),
      action: 'NUTRITION_APPLY_USDA',
      entityType: 'product_nutrition',
      entityId: productId,
      summary: `Gizi ${String(product.kode || product.nama || productId)} dari USDA ${facts.usdaCode}`,
      ...auditActor(auth),
    });
    return ok(clean({ productId, usdaCode: facts.usdaCode, nutrition }));
  }

  if (path[0] === 'nutrition-profiles' && path[1] && path[1] !== 'analyze' && path[1] !== 'tkpi' && path[1] !== 'analyze-draft' && method === 'PUT') {
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
    const setDoc: Record<string, unknown> = { nutrition, updatedAt: now };
    if (normalized.tkpiCode) setDoc.tkpiCode = normalized.tkpiCode;
    await db.collection('products').updateOne(
      withTenantFilter(scopeAuth, { id: productId }),
      { $set: setDoc },
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
