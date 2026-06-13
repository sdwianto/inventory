// Dua gudang utama operasional — semua stok masuk/keluar harus melalui salah satu.

import { v4 as uuidv4 } from 'uuid';

function extractKode(lokasiStr) {
  if (!lokasiStr) return '';
  const m = String(lokasiStr).match(/^([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : String(lokasiStr).trim().toUpperCase();
}

export const WAREHOUSE_CODES = ['GKERING', 'GBASAH'];

export const WAREHOUSE_META = {
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
export const LEGACY_LOKASI_MAP = {
  L001: 'GKERING',
  L002: 'GBASAH',
};

export function normalizeWarehouseKode(lokasiStr) {
  const raw = extractKode(lokasiStr);
  if (WAREHOUSE_CODES.includes(raw)) return raw;
  if (LEGACY_LOKASI_MAP[raw]) return LEGACY_LOKASI_MAP[raw];
  return raw;
}

export function isValidWarehouseKode(lokasiStr) {
  return WAREHOUSE_CODES.includes(normalizeWarehouseKode(lokasiStr));
}

export function warehouseLabel(kode) {
  const k = normalizeWarehouseKode(kode);
  return WAREHOUSE_META[k]?.nama || k;
}

export function warehouseOptions() {
  return WAREHOUSE_CODES.map((k) => ({
    kode: k,
    ...WAREHOUSE_META[k],
    label: `${WAREHOUSE_META[k].nama} (${k})`,
  }));
}

/** Pastikan master lokasi tenant punya GKERING & GBASAH. */
export async function ensureWarehousesForTenant(db, tenantId) {
  const tid = tenantId || 'default';
  const col = db.collection('lokasi');
  for (const kode of WAREHOUSE_CODES) {
    const meta = WAREHOUSE_META[kode];
    const existing = await col.findOne({ tenantId: tid, kode });
    if (!existing) {
      await col.insertOne({
        id: uuidv4(),
        tenantId: tid,
        kode: meta.kode,
        nama: meta.nama,
        keterangan: meta.keterangan,
        tipe: meta.tipe,
        isWarehouse: true,
        aktif: true,
        createdAt: new Date(),
      });
    }
  }
}

/** Pindahkan stok legacy L001/L002 ke gudang baru (sekali per tenant). */
export async function migrateLegacyStokLokasi(db, tenantId) {
  const tid = tenantId || 'default';
  const col = db.collection('stok_lokasi');
  for (const [legacy, target] of Object.entries(LEGACY_LOKASI_MAP)) {
    const legacyRows = await col.find({ tenantId: tid, lokasiKode: legacy }).toArray();
    for (const row of legacyRows) {
      const targetRow = await col.findOne({ tenantId: tid, stokId: row.stokId, lokasiKode: target });
      const qty = parseFloat(row.qty) || 0;
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

export async function ensureAllTenantsWarehouses(db) {
  const tenantIds = await db.collection('lokasi').distinct('tenantId');
  const productTenants = await db.collection('products').distinct('tenantId');
  const grnTenants = await db.collection('goods_receipts').distinct('tenantId');
  const all = [...new Set([...tenantIds, ...productTenants, ...grnTenants, 'sppg', 'default'].filter(Boolean))];
  for (const tid of all) {
    await ensureWarehousesForTenant(db, tid);
    await migrateLegacyStokLokasi(db, tid);
  }
}
