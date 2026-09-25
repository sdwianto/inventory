import type { NextResponse } from 'next/server';
import { ok, err, clean } from '@/lib/api/db';
import { resolveOperationalScope, tenantIdForWrite, withTenantFilter } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { auditActor } from '@/lib/api/audit-log';
import { casUpdateWithAudit } from '@/lib/api/cas';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { inferRecipeBridgeFromNama } from '@/lib/food-production/recipe-uom';
import {
  manualRecipeBridgeSet,
  resolveRecipeBridgeInput,
  type RecipeBridgeSource,
} from '@/lib/api/product-recipe-bridge';
import { buildRecipeConversionReview } from '@/lib/api/recipe-conversion-review';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import type { HandlerContext } from '@/types/api/handler';

/**
 * GET  /recipe-conversion/review            — produk bahan resep + status konversi ketat per baris
 * POST /recipe-conversion/products/:id      — isi jembatan manual, atau `confirmInferred` (tebakan nama)
 */
export async function handleRecipeConversion(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  if (!route.startsWith('/recipe-conversion')) return null;
  const payload = (body || {}) as Record<string, unknown>;

  if (route === '/recipe-conversion/review' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const [review, strict] = await Promise.all([
      buildRecipeConversionReview(db, tenantId, {
        includeOk: url.searchParams.get('includeOk') === '1',
      }),
      isTenantFeatureEnabled(db, tenantId, 'strictRecipeConversion'),
    ]);
    return ok({
      strictRecipeConversion: strict,
      summary: review.summary,
      products: review.products.map((p) => ({
        ...p,
        lines: p.lines.map(({ nextLine: _next, ...row }) => row),
      })),
    });
  }

  if (path[0] === 'recipe-conversion' && path[1] === 'products' && path[2] && !path[3] && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: payload, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productId = path[2];
    const existing = await db.collection('products').findOne(
      withTenantFilter(scopeAuth, { id: productId }),
    ) as Record<string, unknown> | null;
    if (!existing) return err('Produk tidak ditemukan', 404);
    const tenantId = String(existing.tenantId || tenantIdForWrite(scopeAuth, payload));

    const input: Record<string, unknown> = {};
    for (const k of ['recipeBaseGrams', 'recipeBaseMl', 'isiPerKemasan', 'satuanIsi'] as const) {
      if (payload[k] !== undefined) input[k] = payload[k];
    }
    const resolved = resolveRecipeBridgeInput(input, existing.satuan as string | undefined, existing);
    if ('error' in resolved) return err(resolved.error, 400);
    const values = { ...resolved.values };
    const now = new Date();
    const actor = auditActor(auth);
    let source: RecipeBridgeSource = 'MASTER';
    let set: Record<string, unknown>;

    if (payload.confirmInferred === true) {
      const inferred = inferRecipeBridgeFromNama({
        kode: existing.kode as string | undefined,
        nama: existing.nama as string | undefined,
        isiPerKemasan: values.isiPerKemasan,
        satuanIsi: values.satuanIsi,
      });
      if (inferred.grams == null && inferred.ml == null) {
        return err('Nama produk tidak memuat berat/volume yang bisa ditebak — isi manual', 400);
      }
      // Nilai yang diisi di form menang; sisanya pakai tebakan (bukan nilai tersimpan lama).
      let appliedInfer = false;
      if (payload.recipeBaseGrams === undefined && inferred.grams != null) {
        values.recipeBaseGrams = inferred.grams;
        appliedInfer = true;
      }
      if (payload.recipeBaseMl === undefined && inferred.ml != null) {
        values.recipeBaseMl = inferred.ml;
        appliedInfer = true;
      }
      if (!appliedInfer) return err('Tebakan nama tidak dipakai karena nilai sudah diisi manual — simpan tanpa konfirmasi tebakan', 400);
      source = 'CONFIRMED_INFER';
      set = {
        ...values,
        recipeBridgeSource: source,
        recipeBridgeUpdatedAt: now,
        recipeBridgeConfirmedAt: now,
        recipeBridgeConfirmedBy: actor.userId,
        recipeBridgeConfirmedByName: actor.userName,
      };
    } else {
      if (!resolved.touched) return err('Isi minimal satu nilai konversi, atau konfirmasi tebakan nama', 400);
      if (!resolved.changed) return ok(clean(existing));
      set = manualRecipeBridgeSet(values, now);
    }

    const conflict = await casUpdateWithAudit({
      db,
      collection: 'products',
      filter: withTenantFilter(scopeAuth, { id: productId, updatedAt: existing.updatedAt ?? null }),
      update: { $set: { ...set, updatedAt: now } },
      audit: {
        tenantId,
        action: 'PRODUCT_RECIPE_BRIDGE',
        entityType: 'product',
        entityId: productId,
        summary: source === 'CONFIRMED_INFER'
          ? `Konfirmasi tebakan konversi resep ${String(existing.kode || productId)}`
          : `Konversi resep ${String(existing.kode || productId)} diubah manual`,
        metadata: {
          source,
          before: {
            recipeBaseGrams: existing.recipeBaseGrams ?? null,
            recipeBaseMl: existing.recipeBaseMl ?? null,
            isiPerKemasan: existing.isiPerKemasan ?? null,
            satuanIsi: existing.satuanIsi ?? null,
          },
          after: values,
        },
        ...actor,
      },
    });
    if (conflict) return conflict;
    const saved = await db.collection('products').findOne(withTenantFilter(scopeAuth, { id: productId }));
    return ok(clean(saved as Record<string, unknown>));
  }

  return null;
}
