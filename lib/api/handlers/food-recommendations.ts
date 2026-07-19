/**
 * Food Production recommendations API — ADR-001 Phase 3 / Sprint 18.
 */

import type { NextResponse } from 'next/server';
import { ok, err } from '@/lib/api/db';
import {
  withTenantFilter,
  resolveOperationalScope,
  tenantIdForWrite,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { parseHorizon, buildMaterialForecast, type DailyConsumptionPoint } from '@/lib/food-production/forecast';
import {
  buildRecommendations,
  parseRecTypes,
  type RecAudience,
  type SubstituteCandidate,
} from '@/lib/food-production/recommendations';
import { FP_MGMT_READ_ROLES } from '@/lib/food-production/roles';
import { analyzePlanStandardCost, type ProductCostRef } from '@/lib/food-production/cost';
import { PRODUCTION_PLANS_COLLECTION, type ProductionPlanDoc } from '@/lib/food-production/production-plan';
import { MATERIAL_ISSUES_COLLECTION, type MaterialIssueDoc } from '@/lib/food-production/material-issue';
import { PRODUCTION_RESULTS_COLLECTION, type ProductionResultDoc } from '@/lib/food-production/production-result';
import { RECIPES_COLLECTION, type RecipeDoc } from '@/lib/food-production/recipe';
import { MENUS_COLLECTION, type MenuDoc } from '@/lib/food-production/menu';
import { getStokByWarehouseBatch } from '@/lib/api/stok-lokasi';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import type { HandlerContext } from '@/types/api/handler';

export async function handleFoodRecommendations(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request } = ctx;

  if (route === '/food-recommendations' && method === 'GET') {
    const deniedRole = requireRole(auth, [...FP_MGMT_READ_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const horizon = parseHorizon(url.searchParams.get('horizon'));
    const types = parseRecTypes(url.searchParams.get('types'));
    const audienceRaw = String(url.searchParams.get('audience') || 'all').toLowerCase();
    const audience = (['kitchen', 'management', 'both', 'all'].includes(audienceRaw)
      ? audienceRaw
      : 'all') as RecAudience | 'all';
    const kitchenId = resolveKitchenIdFilter(url, request);

    const tfBase = withTenantFilter(scopeAuth, {});
    const kitchenFilter = kitchenId ? { kitchenId } : {};

    const historyDays = Math.max(horizon, 14);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - historyDays);
    const sinceIso = since.toISOString().slice(0, 10);

    const issueQuery: Record<string, unknown> = {
      ...tfBase,
      ...kitchenFilter,
      status: 'COMPLETED',
      tanggal: { $gte: sinceIso },
    };

    const [issues, results, openPlans, menus, products] = await Promise.all([
      db.collection(MATERIAL_ISSUES_COLLECTION)
        .find(issueQuery)
        .project({ tanggal: 1, lines: 1, warehouseKode: 1, noDokumen: 1, kitchenId: 1 })
        .limit(300)
        .toArray() as Promise<MaterialIssueDoc[]>,
      db.collection(PRODUCTION_RESULTS_COLLECTION)
        .find({
          ...tfBase,
          ...kitchenFilter,
          status: 'COMPLETED',
          tanggal: { $gte: sinceIso },
        })
        .project({ noDokumen: 1, lines: 1 })
        .limit(100)
        .toArray() as Promise<ProductionResultDoc[]>,
      db.collection(PRODUCTION_PLANS_COLLECTION)
        .find({
          ...tfBase,
          ...kitchenFilter,
          status: { $in: ['DRAFT', 'SUBMITTED', 'APPROVED', 'PROCESSING'] },
        })
        .sort({ tanggal: -1 })
        .limit(20)
        .toArray() as unknown as Promise<ProductionPlanDoc[]>,
      db.collection(MENUS_COLLECTION)
        .find({ ...tfBase, aktif: { $ne: false } })
        .project({ id: 1, kode: 1, nama: 1, targetCostPerPorsi: 1, aktif: 1, items: 1 })
        .limit(100)
        .toArray() as Promise<MenuDoc[]>,
      db.collection('products')
        .find({ ...tfBase, aktif: { $ne: false } })
        .project({ id: 1, kode: 1, nama: 1, satuan: 1, hargaBeli: 1, grup: 1, produkGrup: 1 })
        .limit(500)
        .toArray(),
    ]);

    const points: DailyConsumptionPoint[] = [];
    const pids = new Set<string>();
    const whs = new Set<string>();
    const issueWasteLines: Array<{
      issueNo?: string;
      productId: string;
      productNama?: string;
      qtyPlanned: number;
      qtyIssued: number;
    }> = [];

    for (const issue of issues) {
      if (issue.warehouseKode) whs.add(issue.warehouseKode);
      for (const line of issue.lines || []) {
        if (!(Number(line.qtyIssued) > 0)) continue;
        pids.add(line.productId);
        points.push({
          tanggal: issue.tanggal,
          productId: line.productId,
          qty: Number(line.qtyIssued),
        });
        issueWasteLines.push({
          issueNo: issue.noDokumen,
          productId: line.productId,
          productNama: line.productNama,
          qtyPlanned: Number(line.qtyPlanned) || 0,
          qtyIssued: Number(line.qtyIssued) || 0,
        });
      }
    }

    const resultWasteLines = (results || []).flatMap((r) =>
      (r.lines || []).map((l) => ({
        resultNo: r.noDokumen,
        menuKode: l.menuKode,
        finishedGoodNama: l.finishedGoodNama,
        targetPorsi: Number(l.targetPorsi) || 0,
        wastePorsi: Number(l.wastePorsi) || 0,
      })),
    );

    const tid = tenantIdForWrite(scopeAuth, {});
    const idList = [...pids];
    const stockMap = idList.length ? await getStokByWarehouseBatch(db, tid, idList) : new Map();
    const onHandByProduct = new Map<string, number>();
    for (const pid of idList) {
      const byWh = (stockMap.get(pid) || {}) as Record<string, number>;
      let sum = 0;
      if (whs.size) for (const wh of whs) sum += Number(byWh[wh] || 0);
      else sum = Object.values(byWh).reduce((s, v) => s + Number(v || 0), 0);
      onHandByProduct.set(pid, sum);
    }

    const productMeta = new Map(
      products.map((p) => [String(p.id), {
        productKode: p.kode != null ? String(p.kode) : undefined,
        productNama: p.nama != null ? String(p.nama) : undefined,
        satuan: p.satuan != null ? String(p.satuan) : undefined,
      }]),
    );

    const forecast = buildMaterialForecast({
      horizon,
      points,
      onHandByProduct,
      productMeta,
      historyDays,
    });

    // Enrich onHand for substitute candidates (all products in grup of shorts)
    const shortIds = forecast.lines.filter((l) => l.risk === 'SHORT').map((l) => l.productId);
    const productsById = new Map<string, SubstituteCandidate>();
    for (const p of products) {
      productsById.set(String(p.id), {
        productId: String(p.id),
        productKode: p.kode != null ? String(p.kode) : undefined,
        productNama: p.nama != null ? String(p.nama) : undefined,
        hargaBeli: p.hargaBeli != null ? Number(p.hargaBeli) : undefined,
        onHandQty: onHandByProduct.get(String(p.id)) || 0,
        grup: String(p.grup || p.produkGrup || '').trim() || undefined,
      });
    }

    // Stock for short/peer products not in consumption history
    const peerIds = [...productsById.values()]
      .filter((p) => {
        if (shortIds.includes(p.productId)) return true;
        const shortGrups = new Set(
          shortIds.map((id) => productsById.get(id)?.grup).filter(Boolean) as string[],
        );
        return p.grup ? shortGrups.has(p.grup) : false;
      })
      .map((p) => p.productId)
      .filter((id) => !onHandByProduct.has(id));
    if (peerIds.length) {
      const peerStock = await getStokByWarehouseBatch(db, tid, peerIds);
      for (const pid of peerIds) {
        const byWh = (peerStock.get(pid) || {}) as Record<string, number>;
        const sum = Object.values(byWh).reduce((s, v) => s + Number(v || 0), 0);
        onHandByProduct.set(pid, sum);
        const row = productsById.get(pid);
        if (row) row.onHandQty = sum;
      }
    }

    // Planned menus + estimated cost
    const menusById = new Map(menus.map((m) => [m.id, m]));
    const plannedMenus: Array<{ menuId: string; menuNama?: string; estimatedCostPerPorsi?: number }> = [];
    const recipeIdsNeeded = new Set<string>();
    for (const plan of openPlans) {
      for (const line of plan.lines || []) {
        if (line.recipeId) recipeIdsNeeded.add(line.recipeId);
        const menu = menusById.get(String(line.menuId || ''));
        if (menu) for (const it of menu.items || []) recipeIdsNeeded.add(it.recipeId);
      }
    }
    const recipeDocs = recipeIdsNeeded.size
      ? await db.collection(RECIPES_COLLECTION)
        .find({ ...tfBase, id: { $in: [...recipeIdsNeeded] } })
        .toArray() as unknown as RecipeDoc[]
      : [];
    const recipesById = new Map(recipeDocs.map((r) => [r.id, r]));
    const costProductsById = new Map<string, ProductCostRef>();
    for (const p of products) {
      costProductsById.set(String(p.id), {
        productId: String(p.id),
        productKode: p.kode != null ? String(p.kode) : undefined,
        productNama: p.nama != null ? String(p.nama) : undefined,
        satuan: p.satuan != null ? String(p.satuan) : undefined,
        hargaBeli: p.hargaBeli != null ? Number(p.hargaBeli) : undefined,
      });
    }

    for (const plan of openPlans) {
      const standard = analyzePlanStandardCost({
        planId: plan.id,
        planNo: plan.noDokumen,
        planLines: plan.lines || [],
        menusById,
        recipesById,
        productsById: costProductsById,
      });
      if ('error' in standard) {
        for (const line of plan.lines || []) {
          if (line.recipeId) {
            const recipe = recipesById.get(line.recipeId);
            plannedMenus.push({
              menuId: line.recipeId,
              menuNama: line.recipeNama || recipe?.nama,
              estimatedCostPerPorsi: undefined,
            });
            continue;
          }
          const menu = menusById.get(String(line.menuId || ''));
          plannedMenus.push({
            menuId: String(line.menuId || ''),
            menuNama: menu?.nama || line.menuNama,
            estimatedCostPerPorsi: menu?.targetCostPerPorsi,
          });
        }
        continue;
      }
      for (const line of plan.lines || []) {
        if (line.recipeId) {
          const recipe = recipesById.get(line.recipeId);
          plannedMenus.push({
            menuId: line.recipeId,
            menuNama: line.recipeNama || recipe?.nama,
            estimatedCostPerPorsi: Number(standard.standard.perPorsi) || 0,
          });
          continue;
        }
        const menu = menusById.get(String(line.menuId || ''));
        const perPorsi = Number(standard.standard.perPorsi) || Number(menu?.targetCostPerPorsi) || 0;
        plannedMenus.push({
          menuId: String(line.menuId || ''),
          menuNama: menu?.nama || line.menuNama,
          estimatedCostPerPorsi: perPorsi,
        });
      }
    }

    // Last GRN unit price for cheaper-supply (recent receipts)
    const grns = await db.collection('goods_receipts')
      .find({ ...tfBase, status: 'POSTED' })
      .sort({ createdAt: -1 })
      .limit(80)
      .project({ items: 1 })
      .toArray();
    const lastPrice = new Map<string, number>();
    for (const grn of grns) {
      const lines = (grn.items || []) as Array<Record<string, unknown>>;
      for (const it of lines) {
        const pid = String(it.productId || it.produkId || '').trim();
        if (!pid || lastPrice.has(pid)) continue;
        const harga = Number(it.harga || it.hargaSatuan || 0);
        if (harga > 0) lastPrice.set(pid, harga);
      }
    }

    const bookRows = await db.collection('supplier_price_book')
      .find(withTenantFilter(scopeAuth, { aktif: true }))
      .project({
        productId: 1, harga: 1, supplierId: 1, supplierNama: 1, supplierKode: 1,
        aktif: 1, effectiveFrom: 1, effectiveTo: 1,
      })
      .sort({ productId: 1, harga: 1 })
      .limit(2000)
      .toArray();
    const { pickBestBookPrices } = await import('@/lib/food-production/supplier-price-book');
    const bestBook = pickBestBookPrices(
      bookRows.map((r) => ({
        productId: String(r.productId || ''),
        harga: Number(r.harga) || 0,
        supplierId: String(r.supplierId || ''),
        supplierNama: r.supplierNama != null ? String(r.supplierNama) : undefined,
        supplierKode: r.supplierKode != null ? String(r.supplierKode) : undefined,
        aktif: r.aktif !== false,
        effectiveFrom: r.effectiveFrom != null ? String(r.effectiveFrom) : undefined,
        effectiveTo: r.effectiveTo != null ? String(r.effectiveTo) : undefined,
      })),
    );

    const cheaperSupply = products
      .filter((p) => {
        const id = String(p.id);
        return Number(p.hargaBeli) > 0 && (lastPrice.has(id) || bestBook.has(id));
      })
      .map((p) => {
        const id = String(p.id);
        const book = bestBook.get(id);
        return {
          productId: id,
          productNama: p.nama != null ? String(p.nama) : undefined,
          productKode: p.kode != null ? String(p.kode) : undefined,
          hargaBeli: Number(p.hargaBeli) || 0,
          lastReceiptUnitPrice: lastPrice.get(id),
          bestBookPrice: book?.harga,
          bestBookSupplierId: book?.supplierId,
          bestBookSupplierNama: book?.supplierNama,
        };
      });

    const snapshot = buildRecommendations({
      horizon,
      forecastLines: forecast.lines,
      issueWasteLines,
      resultWasteLines,
      products: productsById,
      plannedMenus,
      activeMenus: menus.map((m) => ({
        menuId: m.id,
        menuKode: m.kode,
        menuNama: m.nama,
        targetCostPerPorsi: m.targetCostPerPorsi,
        aktif: m.aktif,
      })),
      cheaperSupply,
      types,
      audience,
    });

    return ok(snapshot);
  }

  return null;
}
