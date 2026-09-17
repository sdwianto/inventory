#!/usr/bin/env node
/**
 * Audit (+ optional repair) mismatch satuan CPO Inventory ↔ vendorUomId / SO Sales.
 *
 * Usage:
 *   node scripts/audit-repair-cpo-so-uom.mjs
 *   node scripts/audit-repair-cpo-so-uom.mjs --apply              # rebind CPO by satuan
 *   node scripts/audit-repair-cpo-so-uom.mjs --apply --repair-so  # + SO DRAFT qty/satuan selaras CPO
 *
 * Env:
 *   MONGO_URL, INV_DB_NAME (default sppg_penarukan2), SALES_DB_NAME (default dawam_erp)
 *   INV_TENANT (optional filter), SALES_TENANT (default uddawam)
 */

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve mongodb from inventory or sibling sales (VPS sering hanya install deps di sales)
const require = createRequire(
  resolve(__dirname, '../package.json'),
);
let MongoClient;
try {
  ({ MongoClient } = require('mongodb'));
} catch {
  ({ MongoClient } = createRequire(resolve(__dirname, '../../sales/package.json'))('mongodb'));
}

function loadEnv() {
  for (const name of ['.env.docker', '.env.local', '.env']) {
    try {
      const p = resolve(process.cwd(), name);
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (m && !process.env[m[1].trim()]) {
          process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch { /* ignore */ }
  }
  // Juga coba sales .env.docker bila dijalankan dari inventory
  try {
    const p = resolve(__dirname, '../../sales/.env.docker');
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* ignore */ }
}
loadEnv();

const APPLY = process.argv.includes('--apply');
const REPAIR_SO = process.argv.includes('--repair-so');
const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGO_URL wajib');
  process.exit(1);
}

const INV_DB = process.env.INV_DB_NAME || process.env.DB_NAME || 'sppg_penarukan2';
const SALES_DB = process.env.SALES_DB_NAME || 'dawam_erp';
const INV_TENANT = process.env.INV_TENANT || '';
const SALES_TENANT = process.env.SALES_TENANT || 'uddawam';

function normSat(s) {
  return String(s || '').trim().toUpperCase();
}

function calcTotals(items) {
  const subTotal = items.reduce((s, it) => s + (Number(it.jumlah) || 0), 0);
  return subTotal;
}

async function main() {
  const client = new MongoClient(uri);
  await client.connect();
  const inv = client.db(INV_DB);
  const sales = client.db(SALES_DB);

  const cpoFilter = {
    status: { $ne: 'CANCELLED' },
    ...(INV_TENANT ? { tenantId: INV_TENANT } : {}),
  };

  const cpos = await inv.collection('customer_purchase_orders').find(cpoFilter).toArray();
  const uomCache = new Map();

  async function salesUom(id) {
    const key = String(id || '');
    if (!key) return null;
    if (uomCache.has(key)) return uomCache.get(key);
    const u = await sales.collection('product_uom').findOne(
      { id: key },
      { projection: { id: 1, satuan: 1, isBase: 1, factorToBase: 1, productId: 1, tenantId: 1 } },
    );
    uomCache.set(key, u || null);
    return u || null;
  }

  const bindingMismatches = [];
  const cpoSoMismatches = [];
  const cpoRepairs = [];
  const soRepairs = [];
  const manualFlags = [];

  for (const cpo of cpos) {
    const items = Array.isArray(cpo.items) ? cpo.items : [];
    let itemsChanged = false;
    const nextItems = items.map((it) => ({ ...it }));

    for (let i = 0; i < nextItems.length; i++) {
      const it = nextItems[i];
      const sat = normSat(it.satuan);
      const vid = String(it.vendorUomId || '');
      if (!sat || !vid || vid.startsWith('legacy:')) continue;

      const vu = await salesUom(vid);
      const vuSat = normSat(vu?.satuan);
      if (vu && vuSat && vuSat !== sat) {
        bindingMismatches.push({
          noPO: cpo.noPO,
          status: cpo.status,
          kode: it.kode || it.vendorKode,
          nama: String(it.nama || '').slice(0, 40),
          cpoQty: it.qty,
          cpoSat: sat,
          vendorUomSat: vuSat,
          vendorFactor: vu.factorToBase,
          vendorIsBase: !!vu.isBase,
        });

        // Rebind from local catalog by satuan
        const localPid = String(it.localStokId || it.stokId || '');
        if (localPid) {
          const localUoms = await inv.collection('product_uom').find({
            tenantId: cpo.tenantId,
            productId: localPid,
          }).toArray();
          const matched = localUoms.find((u) => normSat(u.satuan) === sat);
          if (matched?.vendorUomId && !String(matched.vendorUomId).startsWith('legacy:')) {
            cpoRepairs.push({
              noPO: cpo.noPO,
              kode: it.kode || it.vendorKode,
              satuan: sat,
              uomIdBefore: it.uomId,
              uomIdAfter: matched.id,
              vendorUomIdBefore: it.vendorUomId,
              vendorUomIdAfter: matched.vendorUomId,
            });
            nextItems[i] = {
              ...it,
              uomId: matched.id,
              vendorUomId: matched.vendorUomId,
              satuan: matched.satuan,
            };
            itemsChanged = true;
          } else {
            manualFlags.push({
              kind: 'cpo_no_local_uom',
              noPO: cpo.noPO,
              kode: it.kode || it.vendorKode,
              satuan: sat,
              note: 'Tidak ada product_uom lokal dengan satuan ini + vendorUomId nyata',
            });
          }
        }
      }
    }

    if (APPLY && itemsChanged) {
      await inv.collection('customer_purchase_orders').updateOne(
        { _id: cpo._id },
        { $set: { items: nextItems, updatedAt: new Date(), uomRematchAt: new Date() } },
      );
    }

    // Cross-check linked SOs
    const sos = await sales.collection('sales_orders').find({
      noPO: cpo.noPO,
      status: { $ne: 'CANCELLED' },
      ...(SALES_TENANT ? { tenantId: SALES_TENANT } : {}),
    }).toArray();

    for (const so of sos) {
      const byKode = new Map();
      for (const li of so.items || []) byKode.set(String(li.kode || ''), li);

      let soChanged = false;
      const soItems = (so.items || []).map((li) => ({ ...li }));

      for (const it of nextItems) {
        const kode = String(it.kode || it.vendorKode || '');
        const li = byKode.get(kode);
        if (!li) continue;
        const cSat = normSat(it.satuan);
        const sSat = normSat(li.satuan);
        const cQty = Number(it.qty) || 0;
        const sQty = Number(li.qtyOrdered) || 0;
        if (cSat === sSat && Math.abs(cQty - sQty) < 1e-9) continue;

        const massOkKgOns = cSat === 'KG' && sSat === 'ONS'
          && Math.abs(cQty * 10 - sQty) < 1e-6;
        const massOkOnsKg = cSat === 'ONS' && sSat === 'KG'
          && Math.abs(sQty * 10 - cQty) < 1e-6;

        cpoSoMismatches.push({
          noPO: cpo.noPO,
          noSO: so.noSO,
          soStatus: so.status,
          kode,
          nama: String(it.nama || '').slice(0, 32),
          cpo: `${cQty} ${cSat}`,
          so: `${sQty} ${sSat}`,
          soQtyBase: li.qtyBase,
          massOk: massOkKgOns || massOkOnsKg,
        });

        if (!REPAIR_SO || so.status !== 'DRAFT') {
          if (so.status !== 'DRAFT') {
            manualFlags.push({
              kind: 'so_not_draft',
              noPO: cpo.noPO,
              noSO: so.noSO,
              soStatus: so.status,
              kode,
              note: 'SO non-DRAFT — jangan auto-rewrite',
            });
          }
          continue;
        }

        // Restore SO DRAFT line to CPO order unit
        const vendorUomId = String(it.vendorUomId || '');
        const vu = vendorUomId ? await salesUom(vendorUomId) : null;
        if (!vu || normSat(vu.satuan) !== cSat) {
          // try find by product + satuan
          const stokId = String(li.stokId || '');
          const match = stokId
            ? await sales.collection('product_uom').findOne({
              tenantId: so.tenantId,
              productId: stokId,
              satuan: { $regex: new RegExp(`^${cSat}$`, 'i') },
            })
            : null;
          if (!match) {
            manualFlags.push({
              kind: 'so_no_sales_uom',
              noPO: cpo.noPO,
              noSO: so.noSO,
              kode,
              satuan: cSat,
              note: 'Sales product_uom untuk satuan CPO tidak ditemukan',
            });
            continue;
          }
          const factor = Number(match.factorToBase) || 1;
          const idx = soItems.findIndex((x) => String(x.kode || '') === kode);
          if (idx < 0) continue;
          const prev = soItems[idx];
          const harga = Number(prev.harga) || 0;
          // If previous was base-priced and we're moving to higher factor, scale harga
          const prevFactor = Number(prev.factorToBase) || 1;
          let nextHarga = harga;
          if (prevFactor > 0 && factor !== prevFactor && harga > 0) {
            nextHarga = Math.round(harga * (factor / prevFactor));
          }
          soItems[idx] = {
            ...prev,
            qtyOrdered: cQty,
            qty: cQty,
            satuan: match.satuan,
            uomId: match.id,
            factorToBase: factor,
            qtyBase: cQty * factor,
            harga: nextHarga,
            jumlah: Math.max(0, Math.round(nextHarga * cQty - (Number(prev.diskon) || 0))),
          };
          soRepairs.push({
            noSO: so.noSO,
            kode,
            from: `${sQty} ${sSat}`,
            to: `${cQty} ${match.satuan}`,
            hargaBefore: harga,
            hargaAfter: nextHarga,
          });
          soChanged = true;
          continue;
        }

        const factor = Number(vu.factorToBase) || 1;
        const idx = soItems.findIndex((x) => String(x.kode || '') === kode);
        if (idx < 0) continue;
        const prev = soItems[idx];
        const harga = Number(prev.harga) || 0;
        const prevFactor = Number(prev.factorToBase) || 1;
        let nextHarga = harga;
        if (prevFactor > 0 && factor !== prevFactor && harga > 0) {
          nextHarga = Math.round(harga * (factor / prevFactor));
        }
        soItems[idx] = {
          ...prev,
          qtyOrdered: cQty,
          qty: cQty,
          satuan: vu.satuan,
          uomId: vu.id,
          factorToBase: factor,
          qtyBase: cQty * factor,
          harga: nextHarga,
          jumlah: Math.max(0, Math.round(nextHarga * cQty - (Number(prev.diskon) || 0))),
        };
        soRepairs.push({
          noSO: so.noSO,
          kode,
          from: `${sQty} ${sSat}`,
          to: `${cQty} ${vu.satuan}`,
          hargaBefore: harga,
          hargaAfter: nextHarga,
        });
        soChanged = true;
      }

      if (APPLY && REPAIR_SO && soChanged) {
        const subTotal = calcTotals(soItems);
        const diskonNota = Number(so.diskonNota) || 0;
        const ppn = Number(so.ppn) || 0;
        await sales.collection('sales_orders').updateOne(
          { _id: so._id },
          {
            $set: {
              items: soItems,
              subTotal,
              total: subTotal - diskonNota + ppn,
              updatedAt: new Date(),
              uomRepairAt: new Date(),
              uomRepairNote: 'audit-repair-cpo-so-uom: restore DRAFT lines to CPO order UOM',
            },
          },
        );
      }
    }
  }

  const report = {
    mode: APPLY ? (REPAIR_SO ? 'APPLY+SO' : 'APPLY-CPO') : 'DRY-RUN',
    invDb: INV_DB,
    salesDb: SALES_DB,
    cpoScanned: cpos.length,
    bindingMismatches: bindingMismatches.length,
    cpoSoMismatches: cpoSoMismatches.length,
    cpoRepairsPlanned: cpoRepairs.length,
    soRepairsPlanned: soRepairs.length,
    manualFlags: manualFlags.length,
    bindingMismatchesSample: bindingMismatches.slice(0, 40),
    cpoSoMismatchesSample: cpoSoMismatches.slice(0, 40),
    cpoRepairs,
    soRepairs,
    manualFlags,
  };

  console.log(JSON.stringify(report, null, 2));
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
