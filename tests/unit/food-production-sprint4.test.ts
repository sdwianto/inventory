import { describe, expect, it } from 'vitest';
import {
  explodeMaterialRequirements,
  scaleRecipeIngredientQty,
  roundQty,
  decideMrpRegenerateMode,
  MRP_ELIGIBLE_PLAN_STATUSES,
} from '@/lib/food-production/material-requirement';
import { FP_DOC_PREFIX, FP_DOC_TYPES } from '@/lib/food-production/document';
import type { MenuDoc } from '@/lib/food-production/menu';
import type { RecipeDoc } from '@/lib/food-production/recipe';

describe('food-production sprint 4 — MRP', () => {
  it('uses KBH document prefix', () => {
    expect(FP_DOC_PREFIX[FP_DOC_TYPES.MATERIAL_REQUIREMENT]).toBe('KBH');
  });

  it('scales recipe qty by portions / yield / waste', () => {
    // 200 porsi needed, yield 100 → 2 batches; line 5kg; waste 10% → 11
    expect(scaleRecipeIngredientQty(5, 200, 100, 10)).toBe(11);
    expect(roundQty(scaleRecipeIngredientQty(1, 50, 100, 0))).toBe(0.5);
  });

  it('explodes plan → menu → recipe → net vs stock', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      wastePct: 0,
      lines: [
        {
          productId: 'beras', productKode: 'B001', productNama: 'Beras',
          qty: 10, qtyBesar: 10, pctKecil: 70, qtyKecil: 7, satuan: 'KG',
        },
        {
          productId: 'garam', productKode: 'G001', productNama: 'Garam',
          qty: 0.2, qtyBesar: 0.2, pctKecil: 70, qtyKecil: 0.14, satuan: 'KG',
        },
      ],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const menu: MenuDoc = {
      id: 'm1',
      tenantId: 't1',
      kode: 'MNU-1',
      nama: 'Siang',
      version: 1,
      effectiveDate: '2026-07-01',
      items: [{ recipeId: 'r1', porsi: 1 }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN2607000001',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenNama: 'Utama',
        kitchenWarehouseKode: 'GKERING',
        status: 'APPROVED',
        lines: [{ menuId: 'm1', targetPorsi: 200 }],
      },
      menusById: new Map([['m1', menu]]),
      recipesById: new Map([['r1', recipe]]),
      onHandByProduct: new Map([
        ['beras', 15],
        ['garam', 0],
      ]),
      warehouseKode: 'GKERING',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 200/100 * 10 = 20 beras; on hand 15 → net 5
    const beras = result.lines.find((l) => l.productId === 'beras');
    expect(beras?.qtyGross).toBe(20);
    expect(beras?.qtyOnHand).toBe(15);
    expect(beras?.qtyNet).toBe(5);
    expect(beras?.shortage).toBe(true);
    // garam 200/100 * 0.2 = 0.4
    const garam = result.lines.find((l) => l.productId === 'garam');
    expect(garam?.qtyGross).toBe(0.4);
    expect(garam?.qtyNet).toBe(0.4);
    expect(result.summary.shortageCount).toBe(2);
    expect(result.summary.lineCount).toBe(2);
  });

  it('rejects plan without warehouse or menu', () => {
    const badWh = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        status: 'APPROVED',
        lines: [{ menuId: 'm1', targetPorsi: 10 }],
      },
      menusById: new Map(),
      recipesById: new Map(),
      onHandByProduct: new Map(),
      warehouseKode: '',
    });
    expect(badWh.ok).toBe(false);

    expect(MRP_ELIGIBLE_PLAN_STATUSES.has('APPROVED')).toBe(true);
    expect(MRP_ELIGIBLE_PLAN_STATUSES.has('DRAFT')).toBe(false);
  });

  it('rejects inactive recipe and warns on menu version drift', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      lines: [{ productId: 'beras', qty: 1, qtyBesar: 1, pctKecil: 70, qtyKecil: 0.7, satuan: 'KG' }],
      aktif: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const menu: MenuDoc = {
      id: 'm1',
      tenantId: 't1',
      kode: 'MNU-1',
      nama: 'Siang',
      version: 3,
      effectiveDate: '2026-07-01',
      items: [{ recipeId: 'r1', porsi: 1 }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const inactive = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING',
        status: 'APPROVED',
        lines: [{ menuId: 'm1', targetPorsi: 100, menuVersion: 1 }],
      },
      menusById: new Map([['m1', menu]]),
      recipesById: new Map([['r1', recipe]]),
      onHandByProduct: new Map(),
      warehouseKode: 'GKERING',
    });
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.error).toMatch(/nonaktif/i);

    const activeRecipe = { ...recipe, aktif: true };
    const drift = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING',
        status: 'APPROVED',
        lines: [{ menuId: 'm1', targetPorsi: 100, menuVersion: 1 }],
      },
      menusById: new Map([['m1', menu]]),
      recipesById: new Map([['r1', activeRecipe]]),
      onHandByProduct: new Map([['beras', 999]]),
      warehouseKode: 'GKERING',
    });
    expect(drift.ok).toBe(true);
    if (drift.ok) {
      expect(drift.summary.warnings?.[0]).toMatch(/v1/);
      expect(drift.lines[0].shortage).toBe(false);
    }
  });

  it('splits ingredient need by besar/kecil portion families', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      wastePct: 0,
      lines: [{
        productId: 'beras',
        qty: 10,
        qtyBesar: 10,
        pctKecil: 50,
        qtyKecil: 5,
        satuan: 'KG',
      }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const menu: MenuDoc = {
      id: 'm1',
      tenantId: 't1',
      kode: 'MNU-1',
      nama: 'Siang',
      version: 1,
      effectiveDate: '2026-07-01',
      items: [{ recipeId: 'r1', porsi: 1 }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // 100 besar + 100 kecil → need = scale(10,100) + scale(5,100) = 10 + 5 = 15
    const result = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING',
        status: 'APPROVED',
        kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
        lines: [{
          menuId: 'm1',
          targetPorsi: 200,
          kategoriPorsiList: ['PORSI_BESAR', 'PORSI_KECIL'],
        }],
      },
      menusById: new Map([['m1', menu]]),
      recipesById: new Map([['r1', recipe]]),
      onHandByProduct: new Map([['beras', 0]]),
      warehouseKode: 'GKERING',
      acuanByKategori: { PORSI_BESAR: 100, PORSI_KECIL: 100 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0].qtyGross).toBe(15);
  });

  it('skips excluded materials from plan overrides', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      wastePct: 0,
      lines: [{
        productId: 'beras', productKode: 'B001', productNama: 'Beras',
        qty: 10, qtyBesar: 10, pctKecil: 70, qtyKecil: 7, satuan: 'KG',
      }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING',
        status: 'DRAFT',
        kategoriPorsiList: ['PORSI_BESAR'],
        materialOverrides: [{ recipeId: 'r1', productId: 'beras', qty: 10, excluded: true }],
        lines: [{
          recipeId: 'r1',
          targetPorsi: 100,
          kategoriPorsiList: ['PORSI_BESAR'],
        }],
      },
      menusById: new Map(),
      recipesById: new Map([['r1', recipe]]),
      onHandByProduct: new Map([['beras', 0]]),
      warehouseKode: 'GKERING',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tidak ada bahan/i);
  });

  it('applies plan materialOverrides over computed recipe qty', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      wastePct: 0,
      lines: [{
        productId: 'beras', productKode: 'B001', productNama: 'Beras',
        qty: 10, qtyBesar: 10, pctKecil: 70, qtyKecil: 7, satuan: 'KG',
      }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING',
        status: 'DRAFT',
        kategoriPorsiList: ['PORSI_BESAR'],
        materialOverrides: [{ recipeId: 'r1', productId: 'beras', qty: 30 }],
        lines: [{
          recipeId: 'r1',
          targetPorsi: 100,
          kategoriPorsiList: ['PORSI_BESAR'],
        }],
      },
      menusById: new Map(),
      recipesById: new Map([['r1', recipe]]),
      onHandByProduct: new Map([['beras', 0]]),
      warehouseKode: 'GKERING',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0].qtyGross).toBe(30);
  });

  it('explodes plan lines that point at recipeId directly', () => {
    const recipe: RecipeDoc = {
      id: 'r1',
      tenantId: 't1',
      kode: 'RSP-1',
      nama: 'Nasi',
      finishedGoodProductId: 'fg1',
      version: 1,
      effectiveDate: '2026-07-01',
      yieldQty: 100,
      wastePct: 0,
      lines: [{
        productId: 'beras', productKode: 'B001', productNama: 'Beras',
        qty: 10, qtyBesar: 10, pctKecil: 70, qtyKecil: 7, satuan: 'KG',
      }],
      aktif: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = explodeMaterialRequirements({
      plan: {
        id: 'p1',
        noDokumen: 'RPN1',
        tanggal: '2026-07-16',
        kitchenId: 'k1',
        kitchenWarehouseKode: 'GKERING',
        status: 'APPROVED',
        kategoriPorsiList: ['PORSI_BESAR'],
        lines: [{
          recipeId: 'r1',
          targetPorsi: 100,
          kategoriPorsiList: ['PORSI_BESAR'],
        }],
      },
      menusById: new Map(),
      recipesById: new Map([['r1', recipe]]),
      onHandByProduct: new Map([['beras', 0]]),
      warehouseKode: 'GKERING',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lines[0].qtyGross).toBe(10);
    expect(result.lines[0].sources[0].recipeId).toBe('r1');
  });

  it('decides regenerate mode safely vs issue/PR', () => {
    expect(decideMrpRegenerateMode({
      existingStatus: 'DRAFT',
      hasBlockingIssue: false,
      hasBlockingPr: false,
    }).mode).toBe('recalculate');

    expect(decideMrpRegenerateMode({
      existingStatus: 'APPROVED',
      hasBlockingIssue: false,
      hasBlockingPr: false,
    }).mode).toBe('supersede');

    expect(decideMrpRegenerateMode({
      existingStatus: null,
      hasBlockingIssue: false,
      hasBlockingPr: false,
    }).mode).toBe('create');

    expect(decideMrpRegenerateMode({
      existingStatus: 'APPROVED',
      hasBlockingIssue: true,
      hasBlockingPr: false,
    }).mode).toBe('blocked');

    expect(decideMrpRegenerateMode({
      existingStatus: 'SUBMITTED',
      hasBlockingIssue: false,
      hasBlockingPr: true,
    }).mode).toBe('blocked');

    expect(decideMrpRegenerateMode({
      existingStatus: 'PROCESSING',
      hasBlockingIssue: false,
      hasBlockingPr: false,
    }).mode).toBe('blocked');
  });
});
