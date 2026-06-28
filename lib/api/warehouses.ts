// Dua gudang utama operasional — semua stok masuk/keluar harus melalui salah satu.

import type { Db } from 'mongodb';
import { v4 as uuidv4 } from 'uuid';

export type WarehouseCode = 'GKERING' | 'GBASAH';

function extractKode(lokasiStr: string | null | undefined): string {
  if (!lokasiStr) return '';
  const m = String(lokasiStr).match(/^([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : String(lokasiStr).trim().toUpperCase();
}

export const WAREHOUSE_CODES = ['GKERING', 'GBASAH'] as const;

export const WAREHOUSE_META: Record<WarehouseCode, {
  kode: WarehouseCode;
  nama: string;
  keterangan: string;
  tipe: string;
}> = {
  GKERING: {
    kode: 'GKERING',
    nama: 'Gudang Kering',
    keterangan: 'Penyimpanan barang kering',
    tipe: 'KERING',
  },
  GBASAH: {
    kode: 'GBASAH',
    nama: 'Gudang Basah',
    keterangan: 'Penyimpanan barang basah / perishable',
    tipe: 'BASAH',
  },
};

/** @deprecated — legacy code, dipetakan ke GKERING saat migrasi */
export const LEGACY_LOKASI_MAP: Record<string, WarehouseCode> = {
  L001: 'GKERING',
  L002: 'GBASAH',
};

function isWarehouseCode(k: string): k is WarehouseCode {
  return (WAREHOUSE_CODES as readonly string[]).includes(k);
}

export function normalizeWarehouseKode(lokasiStr: string | null | undefined): string {
  const raw = extractKode(lokasiStr);
  if (isWarehouseCode(raw)) return raw;
  if (LEGACY_LOKASI_MAP[raw]) return LEGACY_LOKASI_MAP[raw];
  return raw;
}

export function isValidWarehouseKode(lokasiStr: string | null | undefined): boolean {
  const k = normalizeWarehouseKode(lokasiStr);
  return isWarehouseCode(k);
}

export function warehouseLabel(kode: string | null | undefined): string {
  const k = normalizeWarehouseKode(kode);
  if (isWarehouseCode(k)) return WAREHOUSE_META[k].nama;
  return k;
}

export function warehouseOptions() {
  return WAREHOUSE_CODES.map((k) => ({
    ...WAREHOUSE_META[k],
    label: `${WAREHOUSE_META[k].nama} (${k})`,
  }));
}

interface StokLokasiDoc {
  id?: string;
  tenantId: string;
  stokId: string;
  lokasiKode: string;
  qty?: number;
  updatedAt?: Date;
}

/** Pastikan master lokasi tenant punya GKERING & GBASAH (idempoten, aman dari race). */
export async function ensureWarehousesForTenant(db: Db, tenantId: string | null | undefined): Promise<void> {
  const tid = tenantId || 'default';
  const col = db.collection('lokasi');
  for (const kode of WAREHOUSE_CODES) {
    const meta = WAREHOUSE_META[kode];
    try {
      await col.updateOne(
        { tenantId: tid, kode },
        {
          $setOnInsert: {
            id: uuidv4(),
            tenantId: tid,
            kode: meta.kode,
            nama: meta.nama,
            keterangan: meta.keterangan,
            tipe: meta.tipe,
            isWarehouse: true,
            aktif: true,
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code !== 11000) throw e;
    }
  }
}

/** Pindahkan stok legacy L001/L002 ke gudang baru (sekali per tenant). */
export async function migrateLegacyStokLokasi(db: Db, tenantId: string | null | undefined): Promise<void> {
  const tid = tenantId || 'default';
  const col = db.collection<StokLokasiDoc>('stok_lokasi');
  for (const [legacy, target] of Object.entries(LEGACY_LOKASI_MAP)) {
    const legacyRows = await col.find({ tenantId: tid, lokasiKode: legacy }).toArray();
    for (const row of legacyRows) {
      const targetRow = await col.findOne({ tenantId: tid, stokId: row.stokId, lokasiKode: target });
      const qty = parseFloat(String(row.qty)) || 0;
      if (targetRow) {
        await col.updateOne(
          { tenantId: tid, stokId: row.stokId, lokasiKode: target },
          { $inc: { qty }, $set: { updatedAt: new Date() } },
        );
      } else if (qty > 0) {
        await col.insertOne({
          id: uuidv4(),
          tenantId: tid,
          stokId: row.stokId,
          lokasiKode: target,
          qty,
          updatedAt: new Date(),
        });
      }
      await col.deleteOne({ tenantId: tid, stokId: row.stokId, lokasiKode: legacy });
    }
  }
}

export async function ensureAllTenantsWarehouses(db: Db): Promise<void> {
  const tenantIds = await db.collection('lokasi').distinct('tenantId') as string[];
  const productTenants = await db.collection('products').distinct('tenantId') as string[];
  const grnTenants = await db.collection('goods_receipts').distinct('tenantId') as string[];
  const all = [...new Set([...tenantIds, ...productTenants, ...grnTenants, 'sppg', 'default'].filter(Boolean))];
  for (const tid of all) {
    await ensureWarehousesForTenant(db, tid);
    await migrateLegacyStokLokasi(db, tid);
  }
}
