import { describe, expect, it } from 'vitest';
import {
  defaultKitchenSatuan,
  factorKitchenToBase,
  inferRecipeBridgeFromNama,
  kitchenSatuanOptionsForBase,
  resolveRecipeBridge,
  toBaseRecipeQty,
  validateIsiPerKemasan,
} from '@/lib/food-production/recipe-uom';
import {
  backfillLegacyKitchenSatuan,
  convertRecipeLineForProduct,
  formatRecipeConversionIssues,
  rebaseRecipeLineToProduct,
  resolveRecipeLineForExecution,
} from '@/lib/food-production/recipe-conversion';
import { evaluateRecipeLine } from '@/lib/api/recipe-conversion-review';
import { applyVendorRecipeBridge } from '@/lib/api/product-sync';
import { manualRecipeBridgeSet, resolveRecipeBridgeInput } from '@/lib/api/product-recipe-bridge';
import { applySppgPortionStandards, type RecipeLine } from '@/lib/food-production/recipe';

const STRICT = { strict: true };

describe('strict recipe bridge', () => {
  it('tanpa cadangan nutrisi 100 g', () => {
    const product = { satuan: 'BTL', nama: 'Saori Saus Tiram', nutrition: { gramsPerUnit: 100 } };
    expect(toBaseRecipeQty(200, 'GR', product)).toMatchObject({ qtyBase: 2 });
    const strict = toBaseRecipeQty(200, 'GR', product, STRICT);
    expect(strict).toHaveProperty('error');
    expect((strict as { error: string }).error).not.toMatch(/nutrition/);
  });

  it('tanpa tebakan nama yang belum dikonfirmasi', () => {
    const product = { satuan: 'PCS', nama: 'Abon Sapi 1kg' };
    expect(resolveRecipeBridge(product).gramsSource).toBe('inferred');
    expect(resolveRecipeBridge(product, STRICT).recipeBaseGrams).toBeNull();
    expect(kitchenSatuanOptionsForBase('PCS', { nama: 'Abon Sapi 1kg', strict: true })).toEqual(['PCS']);
    expect(defaultKitchenSatuan('PCS', { nama: 'Abon Sapi 1kg', strict: true })).toBe('PCS');
  });

  it('nilai master tetap dipakai di mode ketat', () => {
    const r = factorKitchenToBase('GR', { satuan: 'PCS', recipeBaseGrams: 1000 }, STRICT);
    expect(r).toEqual({ factorToBase: 0.001, baseSatuan: 'PCS', factorSource: 'MASTER' });
  });

  it('sumber faktor tercatat', () => {
    expect(factorKitchenToBase('KG', { satuan: 'KG' })).toMatchObject({ factorSource: 'IDENTITY' });
    expect(factorKitchenToBase('GR', { satuan: 'KG' })).toMatchObject({ factorSource: 'SI' });
    expect(factorKitchenToBase('GR', { satuan: 'PCS', nama: 'Tepung 500g' })).toMatchObject({ factorSource: 'INFERRED' });
    expect(factorKitchenToBase('GR', { satuan: 'BTL', nutrition: { gramsPerUnit: 50 } })).toMatchObject({ factorSource: 'NUTRITION' });
  });
});

describe('isi per kemasan', () => {
  const rtg = { satuan: 'RTG', nama: 'Royco Kaldu Ayam 12,5 g', isiPerKemasan: 10, satuanIsi: 'SACHET' };

  it('satuan isi jadi satuan dapur dengan faktor 1/isi', () => {
    expect(kitchenSatuanOptionsForBase('RTG', { ...rtg, strict: true })).toContain('SACHET');
    const r = toBaseRecipeQty(5, 'SACHET', rtg, STRICT);
    expect(r).toMatchObject({ qtyBase: 0.5, baseSatuan: 'RTG' });
    expect(factorKitchenToBase('SACHET', rtg, STRICT)).toMatchObject({ factorSource: 'ISI' });
  });

  it('berat di nama dianggap per satuan isi', () => {
    expect(inferRecipeBridgeFromNama(rtg)).toEqual({ grams: 125, ml: null });
    expect(inferRecipeBridgeFromNama({ nama: 'Royco Kaldu Ayam 12,5 g' })).toEqual({ grams: 12.5, ml: null });
  });

  it('validasi pasangan isi', () => {
    expect(validateIsiPerKemasan('RTG', 10, 'SACHET')).toBeNull();
    expect(validateIsiPerKemasan('RTG', null, null)).toBeNull();
    expect(validateIsiPerKemasan('RTG', 10, '')).toMatch(/berpasangan/);
    expect(validateIsiPerKemasan('RTG', -1, 'SACHET')).toMatch(/> 0/);
    expect(validateIsiPerKemasan('RTG', 10, 'RTG')).toMatch(/sama/);
    expect(validateIsiPerKemasan('RTG', 10, 'GR')).toMatch(/hitung/);
    expect(validateIsiPerKemasan('KG', 10, 'PCS')).toMatch(/kemasan/);
  });
});

function line(partial: Partial<RecipeLine>): RecipeLine {
  return { productId: 'p1', qty: 100, qtyBesar: 100, qtyKecil: 70, pctKecil: 70, ...partial } as RecipeLine;
}

describe('convertRecipeLineForProduct', () => {
  const btl = { id: 'p1', kode: 'SAORI', nama: 'Saori 1 L', satuan: 'BTL' };

  it('strict menolak satuan dapur kosong', () => {
    const r = convertRecipeLineForProduct(line({ satuan: '' }), { ...btl, recipeBaseMl: 1000 }, STRICT);
    expect(r).toMatchObject({ ok: false, code: 'EMPTY_SATUAN' });
  });

  it('non-strict tetap memakai default satuan', () => {
    const r = convertRecipeLineForProduct(line({ satuan: '' }), { ...btl, recipeBaseMl: 1000 }, { strict: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.line.satuan).toBe('ML');
  });

  it('strict: GR ke BTL tanpa berat master ditolak (kasus Saori)', () => {
    const r = convertRecipeLineForProduct(line({ satuan: 'GR' }), btl, STRICT);
    expect(r).toMatchObject({ ok: false, code: 'NO_BRIDGE' });
  });

  it('snapshot baris membawa factorSource', () => {
    const r = convertRecipeLineForProduct(line({ satuan: 'ML' }), { ...btl, recipeBaseMl: 1000 }, STRICT);
    expect(r.ok && r.line).toMatchObject({ qtyBaseBesar: 0.1, qtyBaseKecil: 0.07, factorSource: 'MASTER', baseSatuan: 'BTL' });
  });

  it('pesan gabungan menyebut semua bahan', () => {
    const msg = formatRecipeConversionIssues([
      { productId: 'a', productNama: 'Saori', code: 'NO_BRIDGE', error: 'x' },
      { productId: 'b', productNama: 'Kaldu', code: 'EMPTY_SATUAN', error: 'y' },
    ]);
    expect(msg).toMatch(/2 bahan/);
    expect(msg).toMatch(/Saori: x/);
    expect(msg).toMatch(/Kaldu: y/);
  });
});

describe('rebase cutover', () => {
  const old = line({ productId: 'old', productKode: 'OLD', satuan: 'GR', qtyBaseBesar: 0.1, qtyBaseKecil: 0.07, factorToBase: 0.001, baseSatuan: 'KG' });

  it('qtyBase dihitung ulang dengan faktor produk pengganti', () => {
    const r = rebaseRecipeLineToProduct(old, { id: 'new', kode: 'NEW', satuan: 'BTL', recipeBaseGrams: 500 }, STRICT);
    expect(r.error).toBeUndefined();
    expect(r.line).toMatchObject({ productId: 'new', satuan: 'GR', qtyBaseBesar: 0.2, baseSatuan: 'BTL' });
  });

  it('strict: pengganti tanpa konversi → error', () => {
    const r = rebaseRecipeLineToProduct(old, { id: 'new', kode: 'NEW', satuan: 'BTL' }, STRICT);
    expect(r.error).toMatch(/NEW|pengganti/);
  });

  it('non-strict: identitas saja + peringatan, satuan dapur tidak ditimpa', () => {
    const r = rebaseRecipeLineToProduct(old, { id: 'new', kode: 'NEW', satuan: 'BTL' }, { strict: false });
    expect(r.warning).toBeTruthy();
    expect(r.line).toMatchObject({ productId: 'new', satuan: 'GR', qtyBaseBesar: 0.1, baseSatuan: 'BTL' });
  });

  it('produk sama → tidak diubah', () => {
    const r = rebaseRecipeLineToProduct(old, { id: 'old', satuan: 'KG' }, STRICT);
    expect(r.line).toBe(old);
  });
});

describe('evaluateRecipeLine', () => {
  const recipe = { id: 'r1', kode: 'RSP-1', nama: 'Nasi', aktif: true };

  it('OK bila snapshot sama', () => {
    const l = line({ satuan: 'GR', productId: 'p1', qtyBaseBesar: 0.1, qtyBaseKecil: 0.07, factorToBase: 0.001, baseSatuan: 'KG', factorSource: 'SI' });
    expect(evaluateRecipeLine(recipe, l, 0, { id: 'p1', satuan: 'KG' }).status).toBe('OK');
  });

  it('OK + metadata bila factorSource belum ada', () => {
    const l = line({ satuan: 'GR', productId: 'p1', qtyBaseBesar: 0.1, qtyBaseKecil: 0.07, factorToBase: 0.001, baseSatuan: 'KG' });
    const r = evaluateRecipeLine(recipe, l, 0, { id: 'p1', satuan: 'KG' });
    expect(r.status).toBe('OK');
    expect(r.nextLine?.factorSource).toBe('SI');
  });

  it('STALE bila snapshot memakai faktor nutrisi tapi master sudah diisi', () => {
    const l = line({ satuan: 'GR', productId: 'p1', qtyBaseBesar: 1, qtyBaseKecil: 0.7, factorToBase: 0.01, baseSatuan: 'BTL', factorSource: 'NUTRITION' });
    const r = evaluateRecipeLine(recipe, l, 0, { id: 'p1', satuan: 'BTL', recipeBaseGrams: 1000 });
    expect(r.status).toBe('STALE');
    expect(r.after).toMatchObject({ factorToBase: 0.001, qtyBaseBesar: 0.1 });
  });

  it('angka sama, tebakan kini terkonfirmasi → OK metadata, bukan STALE', () => {
    const l = line({ satuan: 'GR', productId: 'p1', qtyBaseBesar: 0.1, qtyBaseKecil: 0.07, factorToBase: 0.001, baseSatuan: 'PCS', factorSource: 'INFERRED' });
    const r = evaluateRecipeLine(recipe, l, 0, { id: 'p1', satuan: 'PCS', recipeBaseGrams: 1000 });
    expect(r.status).toBe('OK');
    expect(r.nextLine?.factorSource).toBe('MASTER');
  });

  it('INVALID bila produk tanpa konversi valid', () => {
    const l = line({ satuan: 'GR', productId: 'p1', factorToBase: 0.01, baseSatuan: 'BTL' });
    const r = evaluateRecipeLine(recipe, l, 0, { id: 'p1', satuan: 'BTL', nutrition: { gramsPerUnit: 100 } });
    expect(r.status).toBe('INVALID');
    expect(r.error).toBeTruthy();
  });
});

describe('baris lama', () => {
  it('hanya qty (tanpa qtyBesar/qtyKecil) tidak jadi 0', () => {
    const legacy = { productId: 'p1', qty: 200, pctKecil: 50, satuan: 'GR' } as RecipeLine;
    const r = convertRecipeLineForProduct(legacy, { id: 'p1', satuan: 'KG' }, STRICT);
    expect(r.ok && r.line).toMatchObject({ qtyBesar: 200, qtyKecil: 100, qtyBaseBesar: 0.2, qtyBaseKecil: 0.1 });
  });

  it('backfill satuan kosong hanya bila faktor 1/kosong', () => {
    expect(backfillLegacyKitchenSatuan(line({ satuan: '' }), 'KG', false)).toMatchObject({ filled: true, line: { satuan: 'KG' } });
    expect(backfillLegacyKitchenSatuan(line({ satuan: '', factorToBase: 0.001 }), 'KG', false).filled).toBe(false);
    expect(backfillLegacyKitchenSatuan(line({ satuan: '' }), 'KG', true).filled).toBe(false);
    expect(backfillLegacyKitchenSatuan(line({ satuan: '', baseSatuan: 'KG' }), 'BTL', true)).toMatchObject({ filled: true, line: { satuan: 'KG' } });
  });
});

describe('resolveRecipeLineForExecution', () => {
  const stale = line({ satuan: 'GR', qtyBaseBesar: 1, qtyBaseKecil: 0.7, factorToBase: 0.01, baseSatuan: 'BTL', factorSource: 'NUTRITION' });

  it('non-strict memakai snapshot tersimpan', () => {
    const r = resolveRecipeLineForExecution(stale, { id: 'p1', satuan: 'BTL' }, { strict: false });
    expect(r.line).toBe(stale);
  });

  it('strict menghitung ulang dari master (snapshot basi tidak dipakai)', () => {
    const r = resolveRecipeLineForExecution(stale, { id: 'p1', satuan: 'BTL', recipeBaseGrams: 1000 }, STRICT);
    expect(r.error).toBeUndefined();
    expect(r.line).toMatchObject({ qtyBaseBesar: 0.1, qtyBaseKecil: 0.07, factorSource: 'MASTER' });
  });

  it('strict: tanpa jembatan master → error, bukan faktor nutrisi', () => {
    const r = resolveRecipeLineForExecution(stale, { id: 'p1', satuan: 'BTL', nutrition: { gramsPerUnit: 100 } }, STRICT);
    expect(r.error).toMatch(/recipeBaseGrams/);
  });

  it('strict: produk hilang → error', () => {
    expect(resolveRecipeLineForExecution(stale, undefined, STRICT).error).toMatch(/tidak ditemukan/);
  });

  it('strict: baris lama satuan kosong faktor 1 tetap lolos', () => {
    const legacy = line({ satuan: '', qtyBaseBesar: 100, qtyBaseKecil: 70 });
    const r = resolveRecipeLineForExecution(legacy, { id: 'p1', satuan: 'KG' }, STRICT);
    expect(r.error).toBeUndefined();
    expect(r.line).toMatchObject({ satuan: 'KG', qtyBaseBesar: 100, factorSource: 'IDENTITY' });
  });
});

describe('standar porsi SPPG menimpa factorSource', () => {
  it('buah kecil basis PCS → IDENTITY, basis berat → SPPG_STANDARD; ayam → SPPG_STANDARD', () => {
    const [pcs] = applySppgPortionStandards([
      line({ productNama: 'Kelengkeng', satuan: 'POTONG', baseSatuan: 'PCS', factorToBase: 0.25, factorSource: 'ISI' }),
    ], 100);
    expect(pcs).toMatchObject({ satuan: 'PCS', factorToBase: 1, factorSource: 'IDENTITY' });
    const [kg] = applySppgPortionStandards([
      line({ productNama: 'Anggur', satuan: 'GR', baseSatuan: 'KG', factorToBase: 0.001, factorSource: 'SI' }),
    ], 100);
    expect(kg.factorSource).toBe('SPPG_STANDARD');
    const [ayam] = applySppgPortionStandards([
      line({ productNama: 'Ayam Potong', satuan: 'GR', baseSatuan: 'KG', factorToBase: 0.001, factorSource: 'SI' }),
    ], 100);
    expect(ayam.factorSource).toBe('SPPG_STANDARD');
  });
});

describe('vendor sync tidak menimpa jembatan lokal', () => {
  const snap = { hasRecipeBaseGrams: true, hasRecipeBaseMl: true, recipeBaseGrams: 900, recipeBaseMl: null };

  it('MASTER / CONFIRMED_INFER tidak disentuh', () => {
    for (const source of ['MASTER', 'CONFIRMED_INFER']) {
      const set: Record<string, unknown> = {};
      applyVendorRecipeBridge(set, { recipeBridgeSource: source, recipeBaseGrams: 1000 }, snap);
      expect(set).toEqual({});
    }
  });

  it('null vendor tidak menghapus nilai lokal', () => {
    const set: Record<string, unknown> = {};
    applyVendorRecipeBridge(set, { recipeBaseMl: 500 }, snap);
    expect(set).toEqual({ recipeBaseGrams: 900 });
  });

  it('produk baru ikut nilai vendor', () => {
    const set: Record<string, unknown> = {};
    applyVendorRecipeBridge(set, null, snap);
    expect(set).toEqual({ recipeBaseGrams: 900, recipeBaseMl: null });
  });
});

describe('input jembatan produk', () => {
  it('menolak angka tidak valid', () => {
    expect(resolveRecipeBridgeInput({ recipeBaseGrams: -5 }, 'PCS', null)).toHaveProperty('error');
    expect(resolveRecipeBridgeInput({ isiPerKemasan: 10 }, 'RTG', null)).toHaveProperty('error');
  });

  it('deteksi perubahan dan kosongkan konfirmasi saat edit manual', () => {
    const r = resolveRecipeBridgeInput({ recipeBaseGrams: '1000', recipeBaseMl: '' }, 'PCS', { recipeBaseGrams: 1000 });
    expect(r).toMatchObject({ changed: false, touched: true });
    const r2 = resolveRecipeBridgeInput({ isiPerKemasan: 10, satuanIsi: 'sachet' }, 'RTG', {});
    expect(r2).toMatchObject({ changed: true, values: { isiPerKemasan: 10, satuanIsi: 'SACHET' } });
    const now = new Date('2026-09-25T00:00:00Z');
    if ('values' in r2) {
      expect(manualRecipeBridgeSet(r2.values, now)).toMatchObject({
        recipeBridgeSource: 'MASTER',
        recipeBridgeConfirmedAt: null,
        recipeBridgeUpdatedAt: now,
      });
    }
  });
});
