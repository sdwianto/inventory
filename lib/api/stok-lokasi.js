// Stok per lokasi (gudang) — qty per tenant + produk + kode lokasi.

import { v4 as uuidv4 } from 'uuid';
import { productFilterById, updateProductStockScoped } from '@/lib/api/tenant-operational';

let indexesEnsured = false;
let stokLokasiMigrated = false;

export function parseLokasiKode(lokasiStr) {
  if (!lokasiStr) return 'L001';
  const m = String(lokasiStr).match(/^([A-Za-z0-9]+)/);
  return m ? m[1].toUpperCase() : 'L001';
}

export async function ensureStokLokasiIndexes(db) {
  if (indexesEnsured) return;
  try {
    await db.collection('stok_lokasi').createIndex(
      { tenantId: 1, stokId: 1, lokasiKode: 1 },
      { unique: true, name: 'uniq_stok_lokasi' },
    );
  } catch (e) {
    if (e?.code !== 85 && e?.code !== 86) console.warn('stok_lokasi index:', e.message);
  }
  indexesEnsured = true;
}

export async function migrateStokLokasiFromProducts(db) {
  if (stokLokasiMigrated) return 0;
  await ensureStokLokasiIndexes(db);
  const products = await db.collection('products')
    .find({})
    .project({ id: 1, tenantId: 1, stok: 1 })
    .toArray();
  if (products.length === 0) {
    stokLokasiMigrated = true;
    return 0;
  }
  const existing = await db.collection('stok_lokasi')
    .find({ lokasiKode: 'L001' })
    .project({ tenantId: 1, stokId: 1 })
    .toArray();
  const existingKeys = new Set(existing.map((r) => `${r.tenantId}:${r.stokId}`));
  const toInsert = [];
  for (const p of products) {
    const tid = p.tenantId || 'default';
    const key = `${tid}:${p.id}`;
    if (!existingKeys.has(key)) {
      toInsert.push({
        id: uuidv4(),
        tenantId: tid,
        stokId: p.id,
        lokasiKode: 'L001',
        qty: parseFloat(p.stok || 0),
        updatedAt: new Date(),
      });
    }
  }
  if (toInsert.length > 0) {
    await db.collection('stok_lokasi').insertMany(toInsert, { ordered: false });
  }
  stokLokasiMigrated = true;
  return toInsert.length;
}

/** Batch read qty stok per lokasi untuk banyak produk sekaligus. */
export async function getQtyStokLokasiBatch(db, tenantId, stokIds, lokasiKode) {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  const ids = [...new Set(stokIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.collection('stok_lokasi')
    .find({ tenantId: tid, stokId: { $in: ids }, lokasiKode: kode })
    .project({ stokId: 1, qty: 1 })
    .toArray();
  return new Map(rows.map((r) => [r.stokId, r.qty ?? 0]));
}

export async function getQtyStokLokasi(db, tenantId, stokId, lokasiKode) {
  const row = await db.collection('stok_lokasi').findOne({
    tenantId: tenantId || 'default',
    stokId,
    lokasiKode: parseLokasiKode(lokasiKode),
  });
  return row?.qty ?? 0;
}

export async function setQtyStokLokasi(db, tenantId, stokId, lokasiKode, qty) {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  const filter = { tenantId: tid, stokId, lokasiKode: kode };
  const next = parseFloat(qty) || 0;
  const existing = await db.collection('stok_lokasi').findOne(filter);
  if (existing) {
    await db.collection('stok_lokasi').updateOne(filter, { $set: { qty: next, updatedAt: new Date() } });
  } else {
    await db.collection('stok_lokasi').insertOne({
      id: uuidv4(),
      ...filter,
      qty: next,
      updatedAt: new Date(),
    });
  }
  return next;
}

/** @returns {{ qty: number } | { error: string }} */
export async function adjustStokLokasi(db, tenantId, stokId, lokasiKode, delta) {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  const d = parseFloat(delta) || 0;
  const current = await getQtyStokLokasi(db, tid, stokId, kode);
  const next = current + d;
  if (next < 0) return { error: `Stok di lokasi ${kode} tidak cukup (sisa: ${current})` };
  await setQtyStokLokasi(db, tid, stokId, kode, next);
  return { qty: next };
}

/** Snapshot stok & harga beli produk — prioritas total dari stok_lokasi. */
export async function getProductInventorySnapshot(db, tenantId, stokId) {
  const tid = tenantId || 'default';
  const prod = await db.collection('products').findOne(productFilterById(tid, stokId));
  if (!prod) return null;
  const rows = await db.collection('stok_lokasi').find({ tenantId: tid, stokId }).toArray();
  const stokFromLokasi = rows.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0);
  const stok = rows.length > 0 ? stokFromLokasi : (parseFloat(prod.stok) || 0);
  return {
    stok,
    hargaBeli: parseInt(prod.hargaBeli || 0, 10),
    prod,
  };
}

export async function syncProductStokFromLokasi(db, tenantId, stokId) {
  const tid = tenantId || 'default';
  const rows = await db.collection('stok_lokasi').find({ tenantId: tid, stokId }).toArray();
  const total = rows.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0);
  await updateProductStockScoped(db, tid, stokId, { $set: { stok: total, updatedAt: new Date() } });
  return total;
}

/** Ensure row exists; if missing, seed from products.stok at default lokasi. */
export async function ensureStokLokasiRow(db, tenantId, stokId, lokasiKode = 'L001') {
  const tid = tenantId || 'default';
  const kode = parseLokasiKode(lokasiKode);
  let row = await db.collection('stok_lokasi').findOne({ tenantId: tid, stokId, lokasiKode: kode });
  if (row) return row;
  const prod = await db.collection('products').findOne(productFilterById(tid, stokId));
  const qty = kode === 'L001' ? parseFloat(prod?.stok || 0) : 0;
  row = {
    id: uuidv4(),
    tenantId: tid,
    stokId,
    lokasiKode: kode,
    qty,
    updatedAt: new Date(),
  };
  await db.collection('stok_lokasi').insertOne(row);
  return row;
}

export async function transferStokBetweenLokasi(db, tenantId, stokId, lokasiAsal, lokasiTujuan, qty) {
  const q = parseFloat(qty) || 0;
  if (q <= 0) return { error: 'Qty tidak valid' };
  const asal = parseLokasiKode(lokasiAsal);
  const tujuan = parseLokasiKode(lokasiTujuan);
  if (asal === tujuan) return { error: 'Lokasi asal dan tujuan sama' };
  await ensureStokLokasiRow(db, tenantId, stokId, asal);
  await ensureStokLokasiRow(db, tenantId, stokId, tujuan);
  const out = await adjustStokLokasi(db, tenantId, stokId, asal, -q);
  if (out.error) return out;
  const inn = await adjustStokLokasi(db, tenantId, stokId, tujuan, q);
  if (inn.error) {
    await adjustStokLokasi(db, tenantId, stokId, asal, q);
    return inn;
  }
  await syncProductStokFromLokasi(db, tenantId, stokId);
  return { ok: true };
}
