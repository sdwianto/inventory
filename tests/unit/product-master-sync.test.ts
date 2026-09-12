import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/product-warehouse', () => ({
  setProductWarehouseStock: vi.fn(async () => {}),
}));
vi.mock('@/lib/api/apply-product-classification', () => ({
  applyInferredClassification: vi.fn(async () => ({})),
  inferredClassificationPatch: vi.fn(() => ({ gudangKode: 'GD-01' })),
}));
vi.mock('@/lib/api/product-uom', () => ({
  replaceProductUoms: vi.fn(async () => []),
  replaceProductUomsFromVendor: vi.fn(async () => []),
  productDenormFromBaseUom: vi.fn(() => ({})),
  bulkReplaceProductUoms: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/api/product-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/product-sync')>();
  return { ...actual, bulkSyncVendorProductUoms: vi.fn(async () => {}) };
});

import { vendorProductSnapshot, findBarcodeDuplicate, upsertProductFromVendor } from '@/lib/api/product-sync';
import { buildSyncSet, bulkUpsertProductsFromVendor } from '@/lib/api/product-sync-batch';
import type { Db } from 'mongodb';

describe('vendorProductSnapshot — masterProductId (regresi Fase 2)', () => {
  it('membawa masterProductId apa adanya saat sales.app mengirimnya', () => {
    const snap = vendorProductSnapshot({ id: 'p1', kode: 'B001', masterProductId: 'mp-telur-ayam' });
    expect(snap.masterProductId).toBe('mp-telur-ayam');
  });

  it('menghasilkan null saat sales.app mengirim null (unlink) atau field tidak ada', () => {
    expect(vendorProductSnapshot({ id: 'p1', kode: 'B001', masterProductId: null }).masterProductId).toBeNull();
    expect(vendorProductSnapshot({ id: 'p1', kode: 'B001' }).masterProductId).toBeNull();
  });
});

describe('buildSyncSet (jalur bulk sync) — harus ikut membawa masterProductId', () => {
  it('menyertakan masterProductId di syncSet, sama seperti jalur webhook single-item', () => {
    const snap = vendorProductSnapshot({ id: 'p1', kode: 'B001', masterProductId: 'mp-telur-ayam' });
    const syncSet = buildSyncSet(snap, 'vendor-a', new Date());
    expect(syncSet.masterProductId).toBe('mp-telur-ayam');
  });
});

describe('upsertProductFromVendor — masterProductId end-to-end + redam barcode-duplicate palsu', () => {
  function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, expected]) => {
      if (expected && typeof expected === 'object' && '$ne' in (expected as Record<string, unknown>)) {
        return doc[key] !== (expected as { $ne: unknown }).$ne;
      }
      if (expected == null) return true;
      return doc[key] === expected;
    });
  }

  function mockDb(existingProducts: Array<Record<string, unknown>>) {
    const inserted: Array<Record<string, unknown>> = [];
    const updates: Array<{ filter: Record<string, unknown>; set: Record<string, unknown> }> = [];
    return {
      db: {
        collection: (name: string) => {
          if (name !== 'products') return { find: () => ({ toArray: async () => [] }) };
          return {
            findOne: async (filter: Record<string, unknown>) =>
              existingProducts.find((p) => matchesFilter(p, filter)) || null,
            updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
              updates.push({ filter, set: update.$set });
            },
            insertOne: async (doc: Record<string, unknown>) => { inserted.push(doc); },
          };
        },
      } as never,
      inserted,
      updates,
    };
  }

  it('menyimpan masterProductId saat create baru', async () => {
    const { db, inserted } = mockDb([]);
    await upsertProductFromVendor(db, 'sppg', 'puspita', {
      id: 'vp1', kode: 'B001', nama: 'Telur Ayam', barcode: '123', masterProductId: 'mp-telur-ayam',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].masterProductId).toBe('mp-telur-ayam');
  });

  it('meng-update masterProductId ke null saat sales.app unlink (mirror apa adanya)', async () => {
    const { db, updates } = mockDb([
      { id: 'existing1', tenantId: 'sppg', vendorTenantId: 'puspita', vendorStokId: 'vp1', kode: 'B001', barcode: '123', masterProductId: 'mp-telur-ayam' },
    ]);
    await upsertProductFromVendor(db, 'sppg', 'puspita', {
      id: 'vp1', kode: 'B001', nama: 'Telur Ayam', barcode: '123', masterProductId: null,
    });
    expect(updates).toHaveLength(1);
    expect(updates[0].set.masterProductId).toBeNull();
  });

  it('meredam barcodeDuplicateWarning kalau produk yang bentrok memang berbagi masterProductId (Risk Register #9)', async () => {
    const { db, inserted } = mockDb([
      { id: 'other1', tenantId: 'sppg', vendorTenantId: 'vendor-b', vendorStokId: 'vp-other', kode: 'B999', barcode: '123', masterProductId: 'mp-telur-ayam' },
    ]);
    await upsertProductFromVendor(db, 'sppg', 'puspita', {
      id: 'vp1', kode: 'B001', nama: 'Telur Ayam', barcode: '123', masterProductId: 'mp-telur-ayam',
    });
    expect(inserted[0].barcodeDuplicateWarning).toBe(false);
    expect(inserted[0].barcodeDuplicateConfirmedSameMaster).toBe(true);
  });

  it('tetap menyalakan barcodeDuplicateWarning kalau barcode sama tapi BUKAN masterProductId yang sama', async () => {
    const { db, inserted } = mockDb([
      { id: 'other1', tenantId: 'sppg', vendorTenantId: 'vendor-b', vendorStokId: 'vp-other', kode: 'B999', barcode: '123', masterProductId: 'mp-lain' },
    ]);
    await upsertProductFromVendor(db, 'sppg', 'puspita', {
      id: 'vp1', kode: 'B001', nama: 'Telur Ayam', barcode: '123', masterProductId: 'mp-telur-ayam',
    });
    expect(inserted[0].barcodeDuplicateWarning).toBe(true);
    expect(inserted[0].barcodeDuplicateConfirmedSameMaster).toBe(false);
  });

  it('tetap menyalakan barcodeDuplicateWarning kalau belum ada satupun yang di-link (masterProductId null)', async () => {
    const { db, inserted } = mockDb([
      { id: 'other1', tenantId: 'sppg', vendorTenantId: 'vendor-b', vendorStokId: 'vp-other', kode: 'B999', barcode: '123' },
    ]);
    await upsertProductFromVendor(db, 'sppg', 'puspita', {
      id: 'vp1', kode: 'B001', nama: 'Telur Ayam', barcode: '123',
    });
    expect(inserted[0].barcodeDuplicateWarning).toBe(true);
    expect(inserted[0].barcodeDuplicateConfirmedSameMaster).toBe(false);
  });
});

describe('bulkUpsertProductsFromVendor (jalur bulk sync) — redam barcode-duplicate palsu (regresi #9)', () => {
  function mockBulkDb(existingRows: Record<string, unknown>[], barcodeRows: Record<string, unknown>[]) {
    const inserted: Record<string, unknown>[] = [];
    const bulkOps: Array<{ updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> } } }> = [];
    const db = {
      collection: (name: string) => {
        if (name !== 'products') return { find: () => ({ toArray: async () => [] }) };
        return {
          find: (filter: Record<string, unknown>) => {
            const isBarcodeQuery = 'barcode' in filter;
            return {
              project: () => ({ toArray: async () => (isBarcodeQuery ? barcodeRows : []) }),
              toArray: async () => (isBarcodeQuery ? barcodeRows : existingRows),
            };
          },
          bulkWrite: async (ops: typeof bulkOps) => { bulkOps.push(...ops); },
          insertMany: async (docs: Record<string, unknown>[]) => { inserted.push(...docs); },
        };
      },
    } as unknown as Db;
    return { db, inserted, bulkOps };
  }

  it('meredam barcodeDuplicateWarning untuk produk BARU yang dari awal sudah berbagi masterProductId dengan produk existing (jalur yang paling sering dipakai — bulk catalog sync)', async () => {
    const { db, inserted } = mockBulkDb([], [
      { id: 'existing1', kode: 'B999', nama: 'Telur Ayam Lama', vendorStokId: 'vp-other', barcode: '123', masterProductId: 'mp-telur-ayam' },
    ]);
    await bulkUpsertProductsFromVendor(db, 'sppg', [
      { id: 'vp1', kode: 'B001', vendorTenantId: 'puspita', nama: 'Telur Ayam', barcode: '123', masterProductId: 'mp-telur-ayam' },
    ]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].barcodeDuplicateWarning).toBe(false);
    expect(inserted[0].barcodeDuplicateConfirmedSameMaster).toBe(true);
  });

  it('tetap menyalakan barcodeDuplicateWarning di jalur bulk kalau BUKAN masterProductId yang sama', async () => {
    const { db, inserted } = mockBulkDb([], [
      { id: 'existing1', kode: 'B999', nama: 'Telur Bebek', vendorStokId: 'vp-other', barcode: '123', masterProductId: 'mp-lain' },
    ]);
    await bulkUpsertProductsFromVendor(db, 'sppg', [
      { id: 'vp1', kode: 'B001', vendorTenantId: 'puspita', nama: 'Telur Ayam', barcode: '123', masterProductId: 'mp-telur-ayam' },
    ]);
    expect(inserted[0].barcodeDuplicateWarning).toBe(true);
    expect(inserted[0].barcodeDuplicateConfirmedSameMaster).toBe(false);
  });

  it('meredam barcodeDuplicateWarning antar-2 produk BARU dalam satu batch yang sama (barcodeMap di-update di tengah loop)', async () => {
    const { db, inserted } = mockBulkDb([], []);
    await bulkUpsertProductsFromVendor(db, 'sppg', [
      { id: 'vp1', kode: 'B001', vendorTenantId: 'vendor-a', nama: 'Telur Ayam A', barcode: '123', masterProductId: 'mp-telur-ayam' },
      { id: 'vp2', kode: 'B002', vendorTenantId: 'vendor-b', nama: 'Telur Ayam B', barcode: '123', masterProductId: 'mp-telur-ayam' },
    ]);
    expect(inserted).toHaveLength(2);
    const second = inserted.find((d) => d.vendorStokId === 'vp2');
    expect(second?.barcodeDuplicateWarning).toBe(false);
    expect(second?.barcodeDuplicateConfirmedSameMaster).toBe(true);
  });
});

describe('findBarcodeDuplicate — memproyeksikan masterProductId untuk perbandingan', () => {
  it('mengembalikan masterProductId kandidat duplikat', async () => {
    let capturedProjection: Record<string, unknown> | undefined;
    const db = {
      collection: () => ({
        findOne: async (_filter: unknown, opts: { projection: Record<string, unknown> }) => {
          capturedProjection = opts.projection;
          return { id: 'other1', masterProductId: 'mp-telur-ayam' };
        },
      }),
    } as never;
    const result = await findBarcodeDuplicate(db, 'sppg', '123', 'vp1');
    expect(result?.masterProductId).toBe('mp-telur-ayam');
    expect(capturedProjection?.masterProductId).toBe(1);
  });
});

describe('detail/foto LWW + stale emit + vendorBaseUomId', () => {
  it('buildSyncSet menyertakan vendorBaseUomId (legacy fallback)', () => {
    const snap = vendorProductSnapshot({ id: 'vp1', kode: 'B001' });
    const syncSet = buildSyncSet(snap, 'vendor-a', new Date(), null, { id: 'vp1' });
    expect(syncSet.vendorBaseUomId).toBe('legacy:vp1');
  });

  it('buildSyncSet tidak overwrite detail lokal yang lebih baru', () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    const snap = vendorProductSnapshot({
      id: 'vp1',
      kode: 'B001',
      detailProduk: 'dari sales basi',
      fotos: ['old.jpg'],
      detailFotosUpdatedAt: older.toISOString(),
      emittedAt: older.toISOString(),
    });
    const syncSet = buildSyncSet(snap, 'vendor-a', new Date(), {
      id: 'local1',
      detailProduk: 'enrichment lokal',
      fotos: ['new.jpg'],
      detailFotosUpdatedAt: newer,
    });
    expect(syncSet.detailProduk).toBeUndefined();
    expect(syncSet.fotos).toBeUndefined();
  });

  it('buildSyncSet tidak wipe detail lokal dengan string kosong dari Sales', () => {
    const snap = vendorProductSnapshot({
      id: 'vp1',
      kode: 'B001',
      detailProduk: '',
      fotos: [],
      emittedAt: new Date().toISOString(),
    });
    const syncSet = buildSyncSet(snap, 'vendor-a', new Date(), {
      id: 'local1',
      detailProduk: 'keep me',
      fotos: ['keep.jpg'],
    });
    expect(syncSet.detailProduk).toBeUndefined();
    expect(syncSet.fotos).toBeUndefined();
  });

  it('upsertProductFromVendor skip push dengan emittedAt lebih tua dari lastVendorSyncEmittedAt', async () => {
    const existing = {
      id: 'local1',
      tenantId: 'sppg',
      vendorTenantId: 'puspita',
      vendorStokId: 'vp1',
      kode: 'B001',
      lastVendorSyncEmittedAt: new Date('2026-06-01T00:00:00Z'),
      aktif: false,
    };
    const updates: Array<{ set: Record<string, unknown> }> = [];
    const db = {
      collection: () => ({
        findOne: async (filter: Record<string, unknown>) => {
          if (filter.vendorStokId === 'vp1' || filter.kode === 'B001') return existing;
          return null;
        },
        updateOne: async (_f: unknown, update: { $set: Record<string, unknown> }) => {
          updates.push({ set: update.$set });
        },
        insertOne: async () => {},
      }),
    } as never;
    const result = await upsertProductFromVendor(db, 'sppg', 'puspita', {
      id: 'vp1',
      kode: 'B001',
      aktif: true,
      emittedAt: '2026-01-01T00:00:00Z',
    });
    expect(result.action).toBe('skipped_stale');
    expect(updates).toHaveLength(0);
  });

  it('deactivateProductFromVendor skip stale yang akan regresi watermark', async () => {
    const { deactivateProductFromVendor } = await import('@/lib/api/product-sync');
    const existing = {
      id: 'local1',
      kode: 'B001',
      lastVendorSyncEmittedAt: new Date('2026-06-01T00:00:00Z'),
    };
    const updates: Array<{ set: Record<string, unknown> }> = [];
    const db = {
      collection: () => ({
        findOne: async () => existing,
        updateOne: async (_f: unknown, update: { $set: Record<string, unknown> }) => {
          updates.push({ set: update.$set });
          return { modifiedCount: 1 };
        },
      }),
    } as never;
    const result = await deactivateProductFromVendor(db, 'sppg', {
      id: 'vp1',
      kode: 'B001',
      emittedAt: '2026-01-01T00:00:00Z',
    });
    expect(result?.action).toBe('skipped_stale');
    expect(updates).toHaveLength(0);
  });

  it('deactivate tidak stamp watermark ke wall-clock (agar soft-reactivate tidak skipped_stale)', async () => {
    const { deactivateProductFromVendor } = await import('@/lib/api/product-sync');
    const existing = {
      id: 'local1',
      kode: 'B001',
      lastVendorSyncEmittedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const updates: Array<{ set: Record<string, unknown> }> = [];
    const db = {
      collection: () => ({
        findOne: async () => existing,
        updateOne: async (_f: unknown, update: { $set: Record<string, unknown> }) => {
          updates.push({ set: update.$set });
          return { modifiedCount: 1 };
        },
      }),
    } as never;
    const emitAt = '2026-03-01T00:00:00Z';
    await deactivateProductFromVendor(db, 'sppg', {
      id: 'vp1',
      kode: 'B001',
      emittedAt: emitAt,
    });
    expect(updates).toHaveLength(1);
    const stamped = updates[0].set.lastVendorSyncEmittedAt as Date;
    expect(stamped.toISOString()).toBe(new Date(emitAt).toISOString());
    // Soft-reactivate dengan emittedAt sedikit lebih baru harus lolos skipped_stale.
    const afterDeactivate = {
      ...existing,
      aktif: false,
      lastVendorSyncEmittedAt: stamped,
    };
    const upsertDb = {
      collection: () => ({
        findOne: async (filter: Record<string, unknown>) => {
          if (filter.vendorStokId === 'vp1' || filter.kode === 'B001') return afterDeactivate;
          return null;
        },
        updateOne: async () => {},
        insertOne: async () => {},
      }),
    } as never;
    const revived = await upsertProductFromVendor(upsertDb, 'sppg', 'puspita', {
      id: 'vp1',
      kode: 'B001',
      aktif: true,
      emittedAt: '2026-03-01T00:00:01Z',
    });
    expect(revived.action).not.toBe('skipped_stale');
  });

  it('buildSyncSet tidak pakai emittedAt sebagai proxy LWW detail', () => {
    const newerLocal = new Date('2026-06-01T00:00:00Z');
    const snap = vendorProductSnapshot({
      id: 'vp1',
      kode: 'B001',
      detailProduk: 'sales tanpa stamp detail',
      fotos: ['a.jpg'],
      emittedAt: '2026-12-01T00:00:00Z',
      // no detailFotosUpdatedAt
    });
    const syncSet = buildSyncSet(snap, 'vendor-a', new Date(), {
      id: 'local1',
      detailProduk: 'enrichment lokal',
      fotos: ['new.jpg'],
      detailFotosUpdatedAt: newerLocal,
    });
    expect(syncSet.detailProduk).toBeUndefined();
    expect(syncSet.fotos).toBeUndefined();
  });
});
