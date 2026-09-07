#!/usr/bin/env node
/**
 * Seed fixture agar E2E D (multi-line PARTIAL) & E (maxQty≥2 + inflight) bisa jalan.
 * - Pastikan product_uom.vendorUomId = hutang.items[].uomId
 * - Top-up stok_lokasi.lokasiKode di gudang produk
 * - Hapus DRAFT RTV yang mengunci invoice target
 *
 * Usage: node scripts/e2e-seed-rtv-fixtures.mjs
 */
import { MongoClient } from 'mongodb';
import { randomUUID } from 'crypto';

const TENANT = process.env.E2E_TENANT || 'sppg';
const MONGO = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/?directConnection=true';
const DB = process.env.DB_NAME || 'inventory_customer';

async function ensureUomAndStock(db, hutang) {
  const items = hutang.items || [];
  let fixed = 0;
  for (const it of items) {
    const salesStokId = String(it.stokId || it.localStokId || '');
    const kode = String(it.kode || '');
    const vendorUomId = String(it.uomId || '').trim();
    if (!vendorUomId) continue;

    let product = salesStokId
      ? await db.collection('products').findOne({ tenantId: TENANT, vendorStokId: salesStokId, aktif: { $ne: false } })
      : null;
    if (!product && salesStokId) {
      product = await db.collection('products').findOne({ tenantId: TENANT, id: salesStokId, aktif: { $ne: false } });
    }
    if (!product && kode) {
      product = await db.collection('products').findOne({ tenantId: TENANT, kode, aktif: { $ne: false } });
    }
    if (!product?.id) {
      console.log('  SKIP no product', kode || salesStokId);
      continue;
    }

    const productId = String(product.id);
    let existing = await db.collection('product_uom').findOne({
      tenantId: TENANT,
      productId,
      $or: [{ vendorUomId }, { id: vendorUomId }],
    });
    if (!existing) {
      // Unique (tenant, product, satuan) — reuse baris satuan yang sama
      existing = await db.collection('product_uom').findOne({
        tenantId: TENANT,
        productId,
        satuan: String(it.satuan || 'PCS'),
      });
    }
    if (!existing) {
      try {
        await db.collection('product_uom').insertOne({
          id: randomUUID(),
          tenantId: TENANT,
          productId,
          satuan: String(it.satuan || 'PCS'),
          factorToBase: 1,
          isBase: true,
          vendorUomId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        fixed += 1;
        console.log('  +uom', product.kode || productId, '→', vendorUomId);
      } catch (e) {
        if (e?.code !== 11000) throw e;
        existing = await db.collection('product_uom').findOne({
          tenantId: TENANT,
          productId,
          satuan: String(it.satuan || 'PCS'),
        });
      }
    }
    if (existing && String(existing.vendorUomId || '') !== vendorUomId) {
      await db.collection('product_uom').updateOne(
        { id: existing.id },
        { $set: { vendorUomId, updatedAt: new Date() } },
      );
      fixed += 1;
      console.log('  ~uom vendorUomId', product.kode || productId, '→', vendorUomId);
    }

    const gudang = String(product.gudangKode || 'GKERING');
    const qtyNeed = Math.max(100, Math.ceil(parseFloat(String(it.qty || 1)) || 1) * 10);

    // Schema production memakai lokasiKode (bukan lokasi)
    await db.collection('stok_lokasi').updateOne(
      { tenantId: TENANT, stokId: productId, lokasiKode: gudang },
      {
        $set: {
          tenantId: TENANT,
          stokId: productId,
          lokasiKode: gudang,
          qty: qtyNeed,
          updatedAt: new Date(),
        },
        $setOnInsert: { id: randomUUID() },
        $unset: { lokasi: '' },
      },
      { upsert: true },
    );

    for (const lok of ['GKERING', 'GBASAH', 'GJANITOR']) {
      if (lok === gudang) continue;
      await db.collection('stok_lokasi').updateOne(
        { tenantId: TENANT, stokId: productId, lokasiKode: lok },
        {
          $set: {
            tenantId: TENANT,
            stokId: productId,
            lokasiKode: lok,
            qty: qtyNeed,
            updatedAt: new Date(),
          },
          $setOnInsert: { id: randomUUID() },
          $unset: { lokasi: '' },
        },
        { upsert: true },
      );
    }

    // Heal docs lama tanpa lokasiKode (qty mengambang, RTV gagal "Stok di lokasi … tidak cukup")
    await db.collection('stok_lokasi').updateMany(
      {
        tenantId: TENANT,
        stokId: productId,
        $or: [
          { lokasiKode: { $exists: false } },
          { lokasiKode: null },
          { lokasiKode: '' },
          { lokasiKode: 'undefined' },
        ],
      },
      { $set: { lokasiKode: gudang, qty: qtyNeed, updatedAt: new Date() }, $unset: { lokasi: '' } },
    );
  }
  return fixed;
}

async function main() {
  const client = new MongoClient(MONGO);
  await client.connect();
  const db = client.db(DB);

  // Semua VENDOR_INVOICE aktif — A–E butuh UOM+stok, bukan hanya multi-line
  const candidates = await db.collection('hutang').find({
    tenantId: TENANT,
    referenceType: 'VENDOR_INVOICE',
    approvalStatus: { $nin: ['REJECTED'] },
  }).sort({ tanggal: -1 }).limit(40).toArray();

  console.log(`Seeding ${candidates.length} hutang for tenant=${TENANT}`);
  for (const h of candidates) {
    const n = (h.items || []).length;
    console.log(`- ${h.noInvoice} (${n} lines, vendor=${h.vendorTenantId})`);
    await ensureUomAndStock(db, h);
    // Bebaskan kunci: DRAFT + PENDING_APPROVAL / POSTING stuck (belum stok OUT) — agar D/E punya multi-line open
    await db.collection('vendor_returns').deleteMany({
      tenantId: TENANT,
      hutangId: h.id,
      status: { $in: ['DRAFT', 'PENDING_APPROVAL', 'POSTING'] },
    });
  }

  console.log('Done.');
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
