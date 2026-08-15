import { describe, expect, it } from 'vitest';
import { inferGudangKodeFromProduct } from '@/lib/api/product-warehouse';
import { applyInferredClassification } from '@/lib/api/apply-product-classification';
import {
  classifyProduct,
  isManualClassification,
  resolveClassificationSource,
  suggestProdukGrup,
} from '@/lib/api/product-classification';

describe('product classification', () => {
  it('maps B511393-style Desaku to Bumbu / INGREDIENT / GKERING', () => {
    expect(suggestProdukGrup('Desaku Marinasi Instan 12,5g')).toBe('Bumbu');
    expect(classifyProduct({ grup: 'Umum', nama: 'Desaku Marinasi Instan 12,5g' })).toEqual({
      itemRole: 'INGREDIENT',
      gudangKode: 'GKERING',
    });
    expect(classifyProduct({ grup: 'Bumbu', nama: 'Desaku Marinasi Instan 12,5g' })).toEqual({
      itemRole: 'INGREDIENT',
      gudangKode: 'GKERING',
    });
  });

  it('keeps Abon Ayam in dry warehouse even with ayam in the name', () => {
    expect(classifyProduct({ grup: 'Bumbu', nama: 'Abon Ayam 1kg' }).gudangKode).toBe('GKERING');
    expect(inferGudangKodeFromProduct({ grup: 'Bumbu', nama: 'Abon Ayam 1kg' })).toBe('GKERING');
  });

  it('maps custom Hewani telur grup to wet warehouse', () => {
    expect(classifyProduct({ grup: 'Hewani', nama: 'Telur Ayam Horn' }).gudangKode).toBe('GBASAH');
  });

  it('maps Buah and Sayuran to wet warehouse', () => {
    expect(classifyProduct({ grup: 'Buah', nama: 'Alpukat 1kg isi 6' }).gudangKode).toBe('GBASAH');
    expect(classifyProduct({ grup: 'Sayuran', nama: 'Bayam' }).gudangKode).toBe('GBASAH');
  });

  it('maps Palen to PACKAGING + GKERING', () => {
    expect(classifyProduct({ grup: 'Palen', nama: 'Alumunium Foil Persegi' })).toEqual({
      itemRole: 'PACKAGING',
      gudangKode: 'GKERING',
    });
  });

  it('maps Toiletries to CONSUMABLE + GJANITOR', () => {
    expect(classifyProduct({ grup: 'Toiletries', nama: 'Sabun Lifebuoy' })).toEqual({
      itemRole: 'CONSUMABLE',
      gudangKode: 'GJANITOR',
    });
  });

  it('puts Palen + Sunlight into Janitor, not packaging/kering', () => {
    expect(suggestProdukGrup('Sunlight 650g')).toBe('Toiletries');
    expect(classifyProduct({ grup: 'Palen', nama: 'Sunlight 650g' })).toEqual({
      itemRole: 'CONSUMABLE',
      gudangKode: 'GJANITOR',
    });
    expect(classifyProduct({ grup: 'Palen', nama: 'Alumunium Foil Persegi' })).toEqual({
      itemRole: 'PACKAGING',
      gudangKode: 'GKERING',
    });
  });

  it('does not overwrite FINISHED_GOOD or manual source', () => {
    expect(isManualClassification({ itemRole: 'FINISHED_GOOD' })).toBe(true);
    expect(isManualClassification({ classificationSource: 'manual', itemRole: 'INGREDIENT' })).toBe(true);
    expect(isManualClassification({ classificationSource: 'inferred', itemRole: 'INGREDIENT' })).toBe(false);
    expect(isManualClassification({})).toBe(false);
  });

  it('marks source manual when saved gudang differs from infer', () => {
    const inferred = classifyProduct({ grup: 'Buah', nama: 'Apel Fuji' });
    expect(resolveClassificationSource({
      itemRole: 'INGREDIENT',
      gudangKode: 'GKERING',
      inferred,
    })).toBe('manual');
    expect(resolveClassificationSource({
      itemRole: inferred.itemRole,
      gudangKode: inferred.gudangKode,
      inferred,
    })).toBe('inferred');
  });

  it('sync apply skips manual SKUs', async () => {
    const patch = await applyInferredClassification(
      {} as never,
      'sppg',
      { id: '1', classificationSource: 'manual', itemRole: 'INGREDIENT', gudangKode: 'GKERING' },
      { grup: 'Buah', nama: 'Apel Fuji' },
    );
    expect(patch).toEqual({});
  });
});
