// Master data per tenant: indexes, bootstrap, scoped queries.

import type { Db, Filter } from 'mongodb';
import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import type { AuthContext } from '@/types/auth';
import type { OperationalScopeResult } from '@/types/api/handler';
import { err } from '@/lib/api/db';
import { requireAuth } from '@/lib/api/require-auth';
import { readActingTenantFromRequest } from '@/lib/api/session';
import { tenantFilterFromAuth, assertDocTenant, normalizeTenantId } from '@/lib/api/tenant-scope';

export const REKENING_DEFAULTS = [
  { kode: '10010', nama: 'Kas', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '10110', nama: 'Bank Mandiri', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '10120', nama: 'Bank BCA', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '10210', nama: 'Piutang Dagang', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '10230', nama: 'Piutang EDC', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '10310', nama: 'Persediaan Barang Dagangan', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '10410', nama: 'PPN Masukan', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '11010', nama: 'Tanah & Bangunan', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '12110', nama: 'Akumulasi Penyusutan', tipe: 'ASET', posisi: 'KREDIT' },
  { kode: '11020', nama: 'Kendaraan', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '11030', nama: 'Inventaris Kantor', tipe: 'ASET', posisi: 'DEBET' },
  { kode: '20010', nama: 'Hutang Usaha', tipe: 'KEWAJIBAN', posisi: 'KREDIT' },
  { kode: '22010', nama: 'PPN Keluaran', tipe: 'KEWAJIBAN', posisi: 'KREDIT' },
  { kode: '21010', nama: 'Modal', tipe: 'EKUITAS', posisi: 'KREDIT' },
  { kode: '21110', nama: 'Laba Ditahan', tipe: 'EKUITAS', posisi: 'KREDIT' },
  { kode: '21120', nama: 'Laba Tahun Berjalan', tipe: 'EKUITAS', posisi: 'KREDIT' },
  { kode: '30010', nama: 'Penjualan', tipe: 'PENDAPATAN', posisi: 'KREDIT' },
  { kode: '30020', nama: 'Retur Penjualan', tipe: 'PENDAPATAN', posisi: 'DEBET' },
  { kode: '30030', nama: 'Diskon Penjualan', tipe: 'PENDAPATAN', posisi: 'DEBET' },
  { kode: '31010', nama: 'Harga Pokok Penjualan', tipe: 'HPP', posisi: 'DEBET' },
  { kode: '40010', nama: 'Beban Gaji', tipe: 'BEBAN', posisi: 'DEBET' },
  { kode: '40020', nama: 'Beban Listrik & Air', tipe: 'BEBAN', posisi: 'DEBET' },
  { kode: '40030', nama: 'Beban Sewa', tipe: 'BEBAN', posisi: 'DEBET' },
  { kode: '40040', nama: 'Beban Penyusutan', tipe: 'BEBAN', posisi: 'DEBET' },
  { kode: '40050', nama: 'Beban Operasional Lainnya', tipe: 'BEBAN', posisi: 'DEBET' },
  { kode: '40060', nama: 'Penyesuaian Persediaan', tipe: 'BEBAN', posisi: 'DEBET' },
];

export const DEMO_PRODUCTS = [
  { kode: 'B00001', barcode: '8991002101417', nama: 'Beras Premium 5Kg', grup: 'Sembako', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 65000, hargaSpesial: 70000, hargaGrosir: 72000, hargaEcer: 75000, stok: 50, minStok: 10 },
  { kode: 'B00002', barcode: '8992761001346', nama: 'Minyak Goreng Tropical 2L', grup: 'Sembako', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 30000, hargaSpesial: 33000, hargaGrosir: 34000, hargaEcer: 36000, stok: 80, minStok: 15 },
  { kode: 'B00003', barcode: '8998866200615', nama: 'Telur Ayam 1 Kg', grup: 'Telur', satuan: 'KG', gudangKode: 'GBASAH', hargaBeli: 20000, hargaSpesial: 22000, hargaGrosir: 23000, hargaEcer: 24000, stok: 120, minStok: 20 },
  { kode: 'B00004', barcode: '8992696404120', nama: 'Gula Pasir 1Kg', grup: 'Sembako', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 13000, hargaSpesial: 14500, hargaGrosir: 15000, hargaEcer: 16000, stok: 100, minStok: 20 },
  { kode: 'B00005', barcode: '8993175533539', nama: 'Indomie Goreng', grup: 'Mie Instan', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 2800, hargaSpesial: 3000, hargaGrosir: 3100, hargaEcer: 3500, stok: 500, minStok: 100 },
  { kode: 'B00006', barcode: '8992775002095', nama: 'Sabun Lifebuoy', grup: 'Toiletries', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 4000, hargaSpesial: 4500, hargaGrosir: 4700, hargaEcer: 5000, stok: 150, minStok: 30 },
  { kode: 'B00007', barcode: '8993175534222', nama: 'Aqua 600ml', grup: 'Minuman', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 2500, hargaSpesial: 2800, hargaGrosir: 3000, hargaEcer: 3500, stok: 300, minStok: 50 },
  { kode: 'B00008', barcode: '8998866102018', nama: 'Teh Botol Sosro 350ml', grup: 'Minuman', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 3500, hargaSpesial: 4000, hargaGrosir: 4200, hargaEcer: 4500, stok: 200, minStok: 40 },
  { kode: 'B00009', barcode: '8994807009113', nama: 'Roti Tawar Sari Roti', grup: 'Roti', satuan: 'PCS', gudangKode: 'GBASAH', hargaBeli: 12000, hargaSpesial: 14000, hargaGrosir: 15000, hargaEcer: 17000, stok: 30, minStok: 5 },
  { kode: 'B00010', barcode: '8992937100204', nama: 'Kopi Kapal Api Sachet', grup: 'Minuman', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 1500, hargaSpesial: 1700, hargaGrosir: 1800, hargaEcer: 2000, stok: 800, minStok: 100 },
  { kode: 'B00011', barcode: '8999999013127', nama: 'Pasta Gigi Pepsodent 190g', grup: 'Toiletries', satuan: 'PCS', gudangKode: 'GKERING', hargaBeli: 10000, hargaSpesial: 11500, hargaGrosir: 12000, hargaEcer: 13500, stok: 60, minStok: 10 },
  { kode: 'B00012', barcode: '8993175001234', nama: 'Susu UHT Ultra 250ml', grup: 'Susu', satuan: 'PCS', gudangKode: 'GBASAH', hargaBeli: 5500, hargaSpesial: 6000, hargaGrosir: 6200, hargaEcer: 6500, stok: 180, minStok: 30 },
];

export const LOKASI_DEFAULTS = [
  { kode: 'GKERING', nama: 'Gudang Kering', keterangan: 'Penyimpanan barang kering', tipe: 'KERING', isWarehouse: true },
  { kode: 'GBASAH', nama: 'Gudang Basah', keterangan: 'Penyimpanan barang basah / perishable', tipe: 'BASAH', isWarehouse: true },
];

const MASTER_COLLECTIONS = [
  { name: 'supplier', index: { tenantId: 1, kode: 1 } },
  { name: 'pelanggan', index: { tenantId: 1, kode: 1 } },
  { name: 'members', index: { tenantId: 1, kodeKartu: 1 } },
  { name: 'rekening', index: { tenantId: 1, kode: 1 } },
  { name: 'lokasi', index: { tenantId: 1, kode: 1 } },
] as const;

let indexesEnsured = false;

function mongoErrorCode(e: unknown): number | undefined {
  return (e as { code?: number })?.code;
}

export async function ensureMasterDataIndexes(db: Db): Promise<void> {
  if (indexesEnsured) return;

  const needsMigrate = await db.collection('products').findOne({
    $or: [{ tenantId: { $exists: false } }, { tenantId: null }, { tenantId: '' }],
  });
  if (needsMigrate) {
    await migrateAllMasterTenantIds(db, 'default');
  }

  const { ensureOperationalTenantIds } = await import('@/lib/api/tenant-operational');
  await ensureOperationalTenantIds(db);

  const { ensureOperationalIndexes } = await import('@/lib/api/operational-indexes');
  await ensureOperationalIndexes(db);

  for (const { name, index } of MASTER_COLLECTIONS) {
    try {
      await db.collection(name).createIndex(index, { unique: true, name: `uniq_${name}_tenant` });
    } catch (e: unknown) {
      const code = mongoErrorCode(e);
      if (code !== 85 && code !== 86) {
        console.warn(`Index ${name}:`, (e as Error).message);
      }
    }
  }

  await ensureProductCatalogIndexes(db);
  indexesEnsured = true;
}

async function dropIndexIfExists(db: Db, collection: string, name: string): Promise<void> {
  try {
    await db.collection(collection).dropIndex(name);
  } catch (e: unknown) {
    const code = mongoErrorCode(e);
    if (code !== 27) {
      console.warn(`Drop index ${name}:`, (e as Error).message);
    }
  }
}

export async function ensureProductCatalogIndexes(db: Db): Promise<void> {
  await dropIndexIfExists(db, 'products', 'uniq_products_tenant');
  await dropIndexIfExists(db, 'products', 'uniq_products_local_kode');

  const specs = [
    {
      name: 'uniq_products_vendor_stok',
      key: { tenantId: 1, vendorTenantId: 1, vendorStokId: 1 },
      partialFilterExpression: {
        syncSource: 'sales.app',
        vendorTenantId: { $type: 'string' },
        vendorStokId: { $type: 'string' },
      },
    },
  ];

  for (const spec of specs) {
    try {
      await db.collection('products').createIndex(spec.key, {
        unique: true,
        name: spec.name,
        partialFilterExpression: spec.partialFilterExpression,
      });
    } catch (e: unknown) {
      const code = mongoErrorCode(e);
      if (code !== 85 && code !== 86) {
        console.warn(`Index ${spec.name}:`, (e as Error).message);
      }
    }
  }
}

export async function migrateCollectionTenantId(
  db: Db,
  collectionName: string,
  defaultTenant = 'default',
): Promise<number> {
  const col = db.collection(collectionName);
  const res = await col.updateMany(
    {
      $or: [
        { tenantId: { $exists: false } },
        { tenantId: null },
        { tenantId: '' },
      ],
    },
    { $set: { tenantId: defaultTenant } },
  );
  return res.modifiedCount;
}

export async function migrateAllMasterTenantIds(db: Db, defaultTenant = 'default') {
  const counts: Record<string, number> = {};
  for (const { name } of MASTER_COLLECTIONS) {
    counts[name] = await migrateCollectionTenantId(db, name, defaultTenant);
  }
  return counts;
}

/** Gabungkan filter bisnis dengan scope tenant dari session. */
export function withTenantFilter(
  auth: AuthContext | null | undefined,
  baseFilter: Filter<Record<string, unknown>> = {},
): Filter<Record<string, unknown>> {
  const tenantPart = tenantFilterFromAuth(auth);
  if (!tenantPart || Object.keys(tenantPart).length === 0) {
    return { ...baseFilter };
  }
  if (!baseFilter || Object.keys(baseFilter).length === 0) {
    return tenantPart as Filter<Record<string, unknown>>;
  }
  return { $and: [baseFilter, tenantPart] };
}

export function tenantIdForWrite(auth: AuthContext | null | undefined, body: Record<string, unknown> = {}) {
  if (auth?.isMaster && body?.tenantId) return String(body.tenantId).trim();
  return auth?.tenantId || 'default';
}

export function resolveActingTenantId(
  auth: AuthContext | null | undefined,
  { url, body }: { url?: URL; body?: Record<string, unknown> } = {},
) {
  const fromQuery = url?.searchParams?.get('tenantId')?.trim();
  const fromBody = body?.tenantId ? String(body.tenantId).trim() : '';
  if (auth?.isMaster && (fromQuery || fromBody)) return fromQuery || fromBody;
  return auth?.tenantId || 'default';
}

export function authForMasterActing(
  auth: AuthContext | null | undefined,
  actingTenantId: string | null | undefined,
): AuthContext | null | undefined {
  if (!auth?.isMaster || !actingTenantId) return auth;
  return {
    ...auth,
    tenantId: actingTenantId,
    isMaster: false,
    role: 'ADMIN',
  };
}

export function masterActingTenantRequired(
  auth: AuthContext | null | undefined,
  actingTenantId: string | null | undefined,
) {
  if (auth?.isMaster && !actingTenantId) {
    return { error: 'Pilih tenant terlebih dahulu' };
  }
  return null;
}

export function resolveMasterActingTenantId(
  auth: AuthContext | null | undefined,
  { url, body, request }: { url?: URL; body?: Record<string, unknown>; request?: Request } = {},
): string | null {
  if (!auth?.isMaster) return null;
  const fromQuery = url?.searchParams?.get('tenantId')?.trim() || '';
  const fromBody = body?.tenantId ? String(body.tenantId).trim() : '';
  const fromCookie = request ? readActingTenantFromRequest(request) : '';
  const acting = fromQuery || fromBody || fromCookie;
  if (!acting || acting === 'master') return '';
  return normalizeTenantId(acting);
}

/** Scope operasional per tenant — MASTER wajib pilih tenant (query/body/cookie). */
export function resolveOperationalScope(
  auth: AuthContext | null | undefined,
  { url, body, request }: { url?: URL; body?: Record<string, unknown>; request?: Request } = {},
): OperationalScopeResult {
  const denied = requireAuth(auth);
  if (denied) return { denied, scopeAuth: null, tenantId: null };

  const userAuth = auth!;

  if (userAuth.isMaster) {
    const acting = resolveMasterActingTenantId(userAuth, { url, body, request });
    if (!acting) {
      return {
        denied: err('Pilih tenant operasional terlebih dahulu', 400),
        scopeAuth: null,
        tenantId: null,
      };
    }
    return {
      denied: null,
      scopeAuth: authForMasterActing(userAuth, acting) as AuthContext,
      tenantId: acting,
    };
  }

  const tenantId = normalizeTenantId(userAuth.tenantId || 'default');
  return { denied: null, scopeAuth: userAuth, tenantId };
}

export async function findMasterDoc(
  db: Db,
  collection: string,
  auth: AuthContext | null | undefined,
  query: Filter<Record<string, unknown>>,
) {
  return db.collection(collection).findOne(withTenantFilter(auth, query));
}

export function assertMasterDoc(
  doc: { tenantId?: string | null } | null | undefined,
  auth: AuthContext | null | undefined,
) {
  if (!doc) return false;
  return assertDocTenant(doc, auth);
}

export async function bootstrapTenantMasterData(
  db: Db,
  tenantId: string | null | undefined,
  { includeProducts = false }: { includeProducts?: boolean } = {},
): Promise<void> {
  const tid = tenantId || 'default';

  const rekCount = await db.collection('rekening').countDocuments({ tenantId: tid });
  if (rekCount === 0) {
    await db.collection('rekening').insertMany(
      REKENING_DEFAULTS.map((r) => ({
        id: uuidv4(),
        tenantId: tid,
        ...r,
        aktif: true,
        createdAt: new Date(),
      })),
    );
  }

  const lokCount = await db.collection('lokasi').countDocuments({ tenantId: tid });
  if (lokCount === 0) {
    await db.collection('lokasi').insertMany(
      LOKASI_DEFAULTS.map((l) => ({
        id: uuidv4(),
        tenantId: tid,
        ...l,
        aktif: true,
        createdAt: new Date(),
      })),
    );
  }

  const { ensureProdukMetaForTenant } = await import('@/lib/api/product-meta');
  await ensureProdukMetaForTenant(db, tid);

  if (includeProducts) {
    const prodCount = await db.collection('products').countDocuments({ tenantId: tid });
    if (prodCount === 0) {
      const docs = DEMO_PRODUCTS.map((p) => ({
        id: uuidv4(),
        tenantId: tid,
        ...p,
        aktif: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      await db.collection('products').insertMany(docs);
      const { setProductWarehouseStock } = await import('@/lib/api/product-warehouse');
      for (const p of docs) {
        await setProductWarehouseStock(db, tid, p.id, p.gudangKode || 'GKERING', p.stok || 0);
      }
    }
  }

  const { backfillProductGudangForTenant } = await import('@/lib/api/product-warehouse');
  await backfillProductGudangForTenant(db, tid);
}
