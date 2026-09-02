/**
 * Koreksi B919012 Ikan Dori Fillet — stok terposting ×10 karena GRN memakai
 * factorToBase=10 (pola ONS-base), lalu master diganti jadi KG base faktor 1
 * tanpa menyesuaikan saldo.
 *
 * Target: qty base 1600 → 160 (÷10), hargaBeli 6850 → 68500, GRN line factor 1.
 *
 * Dry-run (default):
 *   docker exec -i sales-mongo-1 mongosh --quiet --file - < scripts/fix-b919012-dori-kg-x10.js
 *
 * Apply:
 *   docker exec -i sales-mongo-1 mongosh --quiet --eval 'var APPLY_FLAG=true' --file - < scripts/fix-b919012-dori-kg-x10.js
 */

const APPLY = typeof APPLY_FLAG !== 'undefined' && APPLY_FLAG === true;
const DB_NAME = 'sppg_penarukan2';
const TENANT_ID = 'sppg';
const KODE = 'B919012';
const PRODUCT_ID = '5c606904-2d24-4b84-9470-03bcdb20219d';
const NO_DO = 'DO2609000002';
const FACTOR_WRONG = 10;
const QTY_KG = 160;
const QTY_BASE_WRONG = 1600;
const QTY_BASE_RIGHT = 160;
const DELTA = QTY_BASE_RIGHT - QTY_BASE_WRONG; // -1440
const HARGA_BELI_RIGHT = 68500;
const NO_PS = 'PS-FIX-B919012-DORI-X10';

const d = db.getSiblingDB(DB_NAME);
const now = new Date();

function newId(prefix) {
  return prefix + '-' + now.getTime() + '-' + Math.floor(Math.random() * 1e9);
}

function round3(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

const product = d.products.findOne({ id: PRODUCT_ID, tenantId: TENANT_ID });
if (!product) {
  throw new Error('Produk ' + KODE + ' / ' + PRODUCT_ID + ' tidak ditemukan di ' + DB_NAME);
}

const uoms = d.product_uom.find({ productId: PRODUCT_ID, tenantId: TENANT_ID }).toArray();
const lokasi = d.stok_lokasi.find({ stokId: PRODUCT_ID, tenantId: TENANT_ID }).toArray();
const lots = d.ingredient_lots.find({ productId: PRODUCT_ID, tenantId: TENANT_ID }).toArray();
const grn = d.goods_receipts.findOne({ tenantId: TENANT_ID, noDO: NO_DO, status: 'POSTED' });
const grnItem = ((grn && grn.items) || []).find(function (it) {
  return String(it.localStokId) === PRODUCT_ID;
});

const locGbasah = lokasi.find(function (l) { return l.lokasiKode === 'GBASAH'; });
const locQty = Number(locGbasah && locGbasah.qty) || 0;
const lot = lots[0] || null;
const existingPs = d.penyesuaian_stok.findOne({ tenantId: TENANT_ID, noPenyesuaian: NO_PS })
  || d.stok_kartu.findOne({ tenantId: TENANT_ID, noTransaksi: NO_PS });

const report = {
  apply: APPLY,
  db: DB_NAME,
  kode: KODE,
  nama: product.nama,
  productId: PRODUCT_ID,
  master: {
    satuan: product.satuan,
    stok: product.stok,
    hargaBeli: product.hargaBeli,
    hargaEcer: product.hargaEcer,
  },
  uoms: uoms.map(function (u) {
    return { id: u.id, satuan: u.satuan, isBase: u.isBase, factorToBase: u.factorToBase };
  }),
  before: {
    gbasahQty: locQty,
    lotQty: lot ? lot.qty : null,
    lotQtyRemaining: lot ? lot.qtyRemaining : null,
    grnFactor: grnItem ? grnItem.factorToBase : null,
    grnQtyBase: grnItem ? (grnItem.qtyReceivedBase ?? grnItem.qtyBase) : null,
    grnQty: grnItem ? (grnItem.qtyReceived ?? grnItem.qtyOrdered) : null,
  },
  plan: {
    gbasahQty: QTY_BASE_RIGHT,
    lotQty: QTY_BASE_RIGHT,
    deltaKartuKeluar: -DELTA,
    hargaBeli: HARGA_BELI_RIGHT,
    grnFactor: 1,
    grnQtyBase: QTY_BASE_RIGHT,
    noPenyesuaian: NO_PS,
  },
  guards: {
    alreadyApplied: Boolean(existingPs),
    locLooksWrong: Math.abs(locQty - QTY_BASE_WRONG) < 0.01,
    uomIsKgBase1: uoms.length === 1
      && String(uoms[0].satuan).toUpperCase() === 'KG'
      && uoms[0].isBase === true
      && Number(uoms[0].factorToBase) === 1,
    grnLooksWrong: Boolean(
      grnItem
      && Number(grnItem.factorToBase) === FACTOR_WRONG
      && Math.abs(Number(grnItem.qtyReceivedBase ?? grnItem.qtyBase) - QTY_BASE_WRONG) < 0.01
      && Math.abs(Number(grnItem.qtyReceived ?? grnItem.qtyOrdered) - QTY_KG) < 0.01,
    ),
  },
};

print('=== REPORT ===');
printjson(report);

if (!report.guards.uomIsKgBase1) {
  throw new Error('Abort: UOM master bukan KG base factor 1 — cek manual dulu');
}
if (!report.guards.locLooksWrong && !report.guards.alreadyApplied) {
  throw new Error('Abort: qty GBASAH=' + locQty + ' bukan ' + QTY_BASE_WRONG + ' — kemungkinan sudah dikoreksi');
}
if (report.guards.alreadyApplied) {
  print('SKIP: koreksi sudah pernah dijalankan (ada ' + NO_PS + ')');
  quit(0);
}
if (!APPLY) {
  print('DRY-RUN saja. Jalankan dengan --eval \'var APPLY_FLAG=true\' untuk menerapkan.');
  quit(0);
}

print('=== APPLY ===');

const locRes = d.stok_lokasi.updateOne(
  { stokId: PRODUCT_ID, tenantId: TENANT_ID, lokasiKode: 'GBASAH' },
  { $set: { qty: QTY_BASE_RIGHT, updatedAt: now } },
);
printjson({ stok_lokasi: locRes });

if (lot) {
  const lotRes = d.ingredient_lots.updateOne(
    { id: lot.id, tenantId: TENANT_ID },
    { $set: { qty: QTY_BASE_RIGHT, qtyRemaining: QTY_BASE_RIGHT, updatedAt: now } },
  );
  printjson({ ingredient_lots: lotRes });
}

const lokasiAfter = d.stok_lokasi.find({ stokId: PRODUCT_ID, tenantId: TENANT_ID }).toArray();
const stokSynced = round3(lokasiAfter.reduce(function (s, r) { return s + (Number(r.qty) || 0); }, 0));

const prodRes = d.products.updateOne(
  { id: PRODUCT_ID, tenantId: TENANT_ID },
  {
    $set: {
      stok: stokSynced,
      hargaBeli: HARGA_BELI_RIGHT,
      updatedAt: now,
    },
  },
);
printjson({ products: prodRes, stokSynced: stokSynced });

if (grn && grnItem) {
  const items = (grn.items || []).map(function (it) {
    if (String(it.localStokId) !== PRODUCT_ID) return it;
    return Object.assign({}, it, {
      factorToBase: 1,
      qtyBase: QTY_BASE_RIGHT,
      qtyReceivedBase: QTY_BASE_RIGHT,
    });
  });
  const grnRes = d.goods_receipts.updateOne(
    { _id: grn._id },
    {
      $set: {
        items: items,
        updatedAt: now,
        _fixNote: 'B919012 qtyBase dikoreksi /10 (UOM berubah ke KG base setelah POST)',
      },
    },
  );
  printjson({ goods_receipts: grnRes });
}

const penyesuaianId = newId('ps');
const kartuId = newId('sk');

d.penyesuaian_stok.insertOne({
  id: penyesuaianId,
  tenantId: TENANT_ID,
  noPenyesuaian: NO_PS,
  tanggal: now,
  lokasi: 'GBASAH - Gudang Basah',
  keterangan: 'Koreksi B919012 Ikan Dori Fillet: GRN DO2609000002 terposting x10 (factorToBase=10) padahal master sudah KG base faktor 1. 1600->160 KG.',
  userId: 'script',
  userName: 'fix-b919012-dori-kg-x10',
  items: [{
    stokId: PRODUCT_ID,
    kode: KODE,
    nama: product.nama,
    satuan: 'KG',
    gudangKode: 'GBASAH',
    qtySistem: QTY_BASE_WRONG,
    qtyAktual: QTY_BASE_RIGHT,
    selisih: DELTA,
  }],
  createdAt: now,
});

d.stok_kartu.insertOne({
  id: kartuId,
  tenantId: TENANT_ID,
  stokId: PRODUCT_ID,
  lokasi: 'GBASAH - Gudang Basah',
  lokasiKode: 'GBASAH',
  tanggal: now,
  noTransaksi: NO_PS,
  keterangan: 'Koreksi x10 salah post GRN DO2609000002 — 1600->160 KG',
  sourceType: 'PENYESUAIAN',
  masuk: 0,
  keluar: -DELTA,
  qtyEntered: QTY_BASE_RIGHT,
  satuan: 'KG',
  hargaSatuan: HARGA_BELI_RIGHT,
});

const verify = {
  product: d.products.findOne({ id: PRODUCT_ID }, { stok: 1, hargaBeli: 1, satuan: 1 }),
  lokasi: d.stok_lokasi.find({ stokId: PRODUCT_ID }).toArray().map(function (l) {
    return { lokasi: l.lokasiKode, qty: l.qty };
  }),
  lot: d.ingredient_lots.find({ productId: PRODUCT_ID }).toArray().map(function (l) {
    return { lotNo: l.lotNo, qty: l.qty, qtyRemaining: l.qtyRemaining };
  }),
  kartu: d.stok_kartu.find({ noTransaksi: NO_PS }).toArray().map(function (k) {
    return { keluar: k.keluar, masuk: k.masuk, keterangan: k.keterangan };
  }),
};
print('=== VERIFY ===');
printjson(verify);
print('DONE');
