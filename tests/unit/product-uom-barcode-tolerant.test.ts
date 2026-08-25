import { describe, expect, it, vi } from 'vitest';
import { insertProductUoms, bulkReplaceProductUoms } from '@/lib/api/product-uom';
import type { NormalizedUomInput } from '@/lib/uom/types';
import type { Db } from 'mongodb';

function uomInput(overrides: Partial<NormalizedUomInput> = {}): NormalizedUomInput {
  return {
    satuan: 'KG', isBase: true, factorToBase: 1, barcode: '8991111222333',
    sortOrder: 0, hargaEcer: 1000, hargaGrosir: 900, hargaSpesial: 850, aktif: true,
    ...overrides,
  };
}

function duplicateKeyError() {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

function bulkWriteDuplicateKeyError() {
  return Object.assign(new Error('BulkWriteError'), {
    writeErrors: [{ code: 11000 }, { code: 11000 }],
  });
}

/**
 * Regresi live-smoke-test Fase 2: dua produk vendor berbeda (dari 2 tenant berbeda) yang berbagi
 * barcode fisik yang sama (kasus normal setelah linking Master Product — lihat
 * barcodeDuplicateConfirmedSameMaster di product-sync.ts/product-sync-batch.ts) sebelumnya membuat
 * SELURUH catalog sync gagal 500 karena index unik `uniq_product_uom_tenant_barcode` di
 * product_uom. Ditemukan lewat smoke test manual sungguhan (bukan unit test) — persis pola yang
 * sama dengan bug wiring job merge di Fase 1.
 */
describe('insertProductUoms — toleran terhadap duplicate-key barcode (regresi crash sync Fase 2)', () => {
  function mockDb(insertManyImpl: (docs: unknown[], opts: unknown) => Promise<unknown>) {
    return {
      collection: () => ({
        createIndex: vi.fn(async () => {}),
        insertMany: insertManyImpl,
      }),
    } as unknown as Db;
  }

  it('tidak melempar error kalau insertMany gagal karena duplicate-key barcode (code 11000)', async () => {
    const db = mockDb(async () => { throw duplicateKeyError(); });
    await expect(insertProductUoms(db, 'sppg', 'p1', [uomInput()])).resolves.toBeDefined();
  });

  it('tetap melempar error untuk kegagalan lain yang BUKAN duplicate-key (jangan menutupi bug asli)', async () => {
    const db = mockDb(async () => { throw new Error('connection reset'); });
    await expect(insertProductUoms(db, 'sppg', 'p1', [uomInput()])).rejects.toThrow('connection reset');
  });

  it('mengembalikan docs yang direncanakan meski sebagian gagal disimpan (fallback tampilan tetap aman)', async () => {
    const db = mockDb(async () => { throw duplicateKeyError(); });
    const docs = await insertProductUoms(db, 'sppg', 'p1', [uomInput()]);
    expect(docs).toHaveLength(1);
    expect(docs[0].barcode).toBe('8991111222333');
  });
});

describe('bulkReplaceProductUoms — toleran terhadap duplicate-key barcode di jalur bulk sync', () => {
  it('tidak melempar error / tidak menggagalkan sync massal kalau satu chunk insertMany kena BulkWriteError duplicate-key', async () => {
    const deleteMany = vi.fn(async () => {});
    const insertMany = vi.fn(async () => { throw bulkWriteDuplicateKeyError(); });
    const db = {
      collection: () => ({ createIndex: vi.fn(async () => {}), deleteMany, insertMany }),
    } as unknown as Db;

    const result = await bulkReplaceProductUoms(db, 'sppg', [
      { productId: 'p1', uoms: [uomInput({ barcode: '8991111222333' })] },
      { productId: 'p2', uoms: [uomInput({ barcode: '8991111222333' })] },
    ]);
    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(result.get('p1')).toHaveLength(1);
    expect(result.get('p2')).toHaveLength(1);
  });

  it('tetap melempar error untuk kegagalan lain yang bukan seluruhnya duplicate-key', async () => {
    const insertMany = vi.fn(async () => {
      throw Object.assign(new Error('mixed'), { writeErrors: [{ code: 11000 }, { code: 99 }] });
    });
    const db = {
      collection: () => ({ createIndex: vi.fn(async () => {}), deleteMany: vi.fn(async () => {}), insertMany }),
    } as unknown as Db;

    await expect(bulkReplaceProductUoms(db, 'sppg', [
      { productId: 'p1', uoms: [uomInput()] },
    ])).rejects.toThrow('mixed');
  });
});
