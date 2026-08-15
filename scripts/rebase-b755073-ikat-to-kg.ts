#!/usr/bin/env node
/**
 * B755073: 1 BAL = 10 IKAT = 2.8 KG → 1 IKAT = 0.28 KG (280 g).
 * Rebase master IKAT → KG, stok × 0.28 (jika stok masih IKAT).
 *
 * Faktor 2.8 / 0.28 tidak boleh jadi product_uom alt (harus bilangan bulat).
 * Pengadaan setelah rebase: KG. 1 BAL fisik = 2.8 KG.
 *
 * Dry-run default:
 *   npx tsx scripts/rebase-b755073-ikat-to-kg.ts
 *   npx tsx scripts/rebase-b755073-ikat-to-kg.ts --apply
 *   DB_NAME=dawam_erp npx tsx scripts/rebase-b755073-ikat-to-kg.ts --apply
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MongoClient } from 'mongodb';

function loadEnv() {
  try {
    for (const name of ['.env.local', '.env']) {
      const p = resolve(process.cwd(), name);
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const KODE = 'B755073';
const KG_PER_BAL = 2.8;
const IKAT_PER_BAL = 10;
const KG_PER_IKAT = 0.28;
const GR_PER_IKAT = 280;

const apply = process.argv.includes('--apply');
const uri = process.env.MONGO_URL || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const dbName = process.env.DB_NAME || 'inventory_customer';

function roundQty(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e9) / 1e9;
}

function factorFromSatuan(satuan: string): number | null {
  const s = String(satuan || '').trim().toUpperCase();
  if (s === 'IKAT') return KG_PER_IKAT;
  if (s === 'BAL' || s === 'BALL') return KG_PER_BAL;
  if (s === 'KG' || s === 'KILOGRAM') return null; // already kg
  if (s === 'GR' || s === 'G' || s === 'GRAM') return 0.001;
  return null;
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const now = new Date();
  const products = await db.collection('products').find({ kode: KODE }).toArray();
  const summary: Record<string, unknown>[] = [];

  for (const p of products) {
    const id = String(p.id || '');
    const tenantId = String(p.tenantId || '');
    const fromSatuan = String(p.satuan || '').trim().toUpperCase();
    const factor = factorFromSatuan(fromSatuan);
    const lokasiBefore = await db.collection('stok_lokasi').find({ stokId: id, tenantId }).toArray();
    const lokasiSumBefore = lokasiBefore.reduce((s, r) => s + (Number(r.qty) || 0), 0);
    const qtySource = lokasiSumBefore > 0 ? lokasiSumBefore : stokNow;
    const stokNext = factor != null ? roundQty(qtySource * factor) : qtySource;
    const row = {
      tenantId,
      id,
      nama: p.nama,
      satuanFrom: fromSatuan,
      satuanTo: 'KG',
      stokFrom: stokNow,
      lokasiSumFrom: lokasiSumBefore,
      stokTo: stokNext,
      factor,
      dropUom: 'BAL (faktor 25 lama; 2.8 kg/bal bukan bilangan bulat)',
    };
    summary.push(row);

    if (!apply) continue;
    if (!id) continue;

    await db.collection('products').updateOne(
      { id, tenantId },
      {
        $set: {
          satuan: 'KG',
          stok: stokNext,
          stokDisplay: `${stokNext} KG`,
          updatedAt: now,
        },
      },
    );

    if (tenantId) {
      const kgMeta = await db.collection('produk_satuan').findOne({ tenantId, nama: 'KG' });
      if (!kgMeta) {
        await db.collection('produk_satuan').insertOne({
          tenantId,
          nama: 'KG',
          aktif: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    const uoms = await db.collection('product_uom').find({
      $or: [{ productId: id }, { productId: p.id }],
      ...(tenantId ? { tenantId } : {}),
    }).toArray();
    const base = uoms.find((u) => u.isBase === true) || uoms[0];
    if (base) {
      await db.collection('product_uom').updateOne(
        { id: base.id, tenantId },
        { $set: { satuan: 'KG', factorToBase: 1, isBase: true, updatedAt: now } },
      );
    }
    await db.collection('product_uom').deleteMany({
      productId: id,
      tenantId,
      isBase: { $ne: true },
      satuan: { $in: ['BAL', 'BALL', 'IKAT'] },
    });

    if (factor != null && factor !== 1) {
      await db.collection('stok_lokasi').updateMany(
        { stokId: id, tenantId },
        [{ $set: { qty: { $multiply: [{ $toDouble: { $ifNull: ['$qty', 0] } }, factor] }, updatedAt: now } }],
      );
      await db.collection('stok_bin').updateMany(
        { stokId: id, tenantId },
        [{ $set: { qty: { $multiply: [{ $toDouble: { $ifNull: ['$qty', 0] } }, factor] }, updatedAt: now } }],
      );
    }

    const lokasiAfter = await db.collection('stok_lokasi').find({ stokId: id, tenantId }).toArray();
    const stokSynced = roundQty(lokasiAfter.reduce((s, r) => s + (Number(r.qty) || 0), 0));
    await db.collection('products').updateOne(
      { id, tenantId },
      { $set: { stok: stokSynced || stokNext, stokDisplay: `${stokSynced || stokNext} KG`, updatedAt: now } },
    );

    const recipes = await db.collection('recipes').find({
      tenantId,
      'lines.productId': id,
    }).toArray();
    for (const rec of recipes) {
      const lines = Array.isArray(rec.lines) ? rec.lines : [];
      const nextLines = lines.map((line: Record<string, unknown>) => {
        if (String(line.productId) !== id) return line;
        const lineSat = String(line.satuan || '').toUpperCase();
        const lineFactor = lineSat === 'IKAT' || lineSat === 'BAL' || lineSat === 'BALL'
          ? factorFromSatuan(lineSat)
          : null;
        if (lineFactor == null) {
          return { ...line, baseSatuan: String(line.baseSatuan || 'KG') };
        }
        const qtyBesar = Number(line.qtyBesar ?? line.qty) || 0;
        const qtyKecil = Number(line.qtyKecil) || 0;
        const qtyBaseBesar = roundQty(qtyBesar * lineFactor);
        const qtyBaseKecil = roundQty(qtyKecil * lineFactor);
        return {
          ...line,
          satuan: 'GR',
          qtyBesar: roundQty(qtyBesar * lineFactor * 1000),
          qtyKecil: roundQty(qtyKecil * lineFactor * 1000),
          qty: roundQty(qtyBesar * lineFactor * 1000),
          qtyBaseBesar,
          qtyBaseKecil,
          factorToBase: 0.001,
          baseSatuan: 'KG',
        };
      });
      await db.collection('recipes').updateOne(
        { id: rec.id, tenantId },
        { $set: { lines: nextLines, updatedAt: now } },
      );
    }
  }

  await client.close();
  console.log(JSON.stringify({
    apply,
    dbName,
    kode: KODE,
    kgPerBal: KG_PER_BAL,
    ikatPerBal: IKAT_PER_BAL,
    kgPerIkat: KG_PER_IKAT,
    grPerIkat: GR_PER_IKAT,
    products: summary,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
