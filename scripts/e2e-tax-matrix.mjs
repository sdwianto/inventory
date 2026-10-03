#!/usr/bin/env node
/**
 * E2E matriks pajak (dev only): vendor Sales PKP/non-PKP × pembeli Inventory PKP/non-PKP.
 * Tenant terisolasi berprefiks `e2e-tax-`, dihapus di akhir (KEEP=1 untuk menyimpan).
 * Butuh Sales :3000 + Inventory :3001 berjalan (`next dev`) di DB dev lokal.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const invRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const salesRoot = process.env.SALES_APP_DIR || path.resolve(invRoot, '../sales-cpo-avail');
const readEnv = (p) => (fs.existsSync(p)
  ? Object.fromEntries(fs.readFileSync(p, 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }))
  : {});
const invEnv = readEnv(path.join(invRoot, '.env.local'));
const salesEnv = readEnv(path.join(salesRoot, '.env.local'));

const SALES = 'http://localhost:3000';
const INVENTORY = 'http://localhost:3001';
const PREFIX = 'e2e-tax-';
const EMAIL = 'dawam@master.com';
const PASSWORD = 'dawam123';
const SETUP_TOKEN = invEnv.INTEGRATION_SETUP_TOKEN || 'dev_pair_token_local_only';
const NPWP_V = '0123456789012345';
/** 15 digit + 1 digit per customer — NPWP party Sales unik global. */
const NPWP_C = '098765432109876';

for (const [name, e] of [['inventory', invEnv], ['sales', salesEnv]]) {
  const local = /localhost|127\.0\.0\.1|mongo:/.test(String(e.MONGO_URL || ''));
  if (!local || /prod/i.test(String(e.DB_NAME || ''))) {
    console.error(`❌ ${name} .env.local bukan DB dev lokal — batal`);
    process.exit(1);
  }
}

const VENDORS = [
  { id: `${PREFIX}vp`, pkp: true },
  { id: `${PREFIX}vn`, pkp: false },
];
const PAIRS = [
  { customer: `${PREFIX}c-pp`, vendor: `${PREFIX}vp`, buyerPkp: true, npwp: `${NPWP_C}1` },
  { customer: `${PREFIX}c-pn`, vendor: `${PREFIX}vp`, buyerPkp: false, npwp: `${NPWP_C}2` },
  { customer: `${PREFIX}c-np`, vendor: `${PREFIX}vn`, buyerPkp: true, npwp: `${NPWP_C}3` },
  { customer: `${PREFIX}c-nn`, vendor: `${PREFIX}vn`, buyerPkp: false, npwp: `${NPWP_C}4` },
];
const PROD_A = { kode: 'E2ETAX-A', nama: 'E2E Tax Kena PPN', hargaEcer: 13000, hargaGrosir: 12345, hargaSpesial: 12000, hargaBeli: 10000 };
const PROD_B = { kode: 'E2ETAX-B', nama: 'E2E Tax Bebas PPN', hargaEcer: 5500, hargaGrosir: 5000, hargaSpesial: 4800, hargaBeli: 4000, bebasPpn: true };
const COA_PPN_MASUKAN = '10410';
const COA_HUTANG_SOURCES = ['AUTO_HUTANG_VENDOR', 'AUTO_CN_VENDOR', 'AUTO_DN_VENDOR'];

const steps = [];
const log = (ok, name, detail = '') => {
  steps.push({ ok, name, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n);

async function api(base, method, route, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const res = await fetch(`${base}/api${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120_000) });
  let json = null;
  try { json = await res.json(); } catch { /* */ }
  return { status: res.status, ok: res.ok, json, headers: res.headers };
}

async function login(base) {
  const res = await api(base, 'POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const raw = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith('kasir_session=') || c.startsWith('inventory_session='));
  return raw ? raw.split(';')[0] : null;
}

async function drain(base, secret, limit = 20) {
  if (!secret) return;
  try {
    await fetch(`${base}/api/bg-jobs/process?limit=${limit}`, {
      headers: { Authorization: `Bearer ${secret}`, 'X-Worker-Secret': secret },
      signal: AbortSignal.timeout(90_000),
    });
  } catch { /* best-effort */ }
}
const drainAll = async (rounds = 2) => {
  for (let i = 0; i < rounds; i++) {
    await drain(SALES, salesEnv.WORKER_SECRET);
    await drain(INVENTORY, invEnv.WORKER_SECRET);
    await sleep(400);
  }
};

async function poll(fn, { timeoutMs = 30_000, every = 1000, drainEvery = 3 } = {}) {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    if (++i % drainEvery === 0) await drainAll(1);
    await sleep(every);
  }
  return null;
}

function journalSums(journals, kode) {
  return journals.flatMap((j) => j.details || [])
    .filter((d) => d.rekeningKode === kode)
    .reduce((s, d) => s + (Number(d.debet) || 0) - (Number(d.kredit) || 0), 0);
}

async function cleanup(ctx) {
  const { salesCookie, invCookie, salesDb, invDb } = ctx;
  const vendorIds = VENDORS.map((v) => v.id);
  const customerIds = PAIRS.map((p) => p.customer);
  for (const id of customerIds) {
    if (invCookie) await api(INVENTORY, 'DELETE', `/tenants/${id}?force=true`, { cookie: invCookie, body: {} });
  }
  for (const id of vendorIds) {
    if (salesCookie) await api(SALES, 'DELETE', `/tenants/${id}?force=true`, { cookie: salesCookie, body: {} });
  }
  // Sapu sisa dokumen berprefiks e2e-tax- (purge tidak menyentuh semua kunci lintas-tenant).
  const rx = { $regex: `^${PREFIX}` };
  let leftovers = 0;
  for (const db of [salesDb, invDb]) {
    if (!db) continue;
    const colls = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name } of colls) {
      if (name.startsWith('system.')) continue;
      const r = await db.collection(name).deleteMany({
        $or: [{ tenantId: rx }, { customerTenantId: rx }, { vendorTenantId: rx }],
      });
      leftovers += r.deletedCount || 0;
      if (r.deletedCount && process.env.VERBOSE_CLEANUP === '1') console.log(`   sapuan ${db.databaseName}.${name}: ${r.deletedCount}`);
    }
  }
  return leftovers;
}

async function setupVendor(ctx, v) {
  const { salesCookie } = ctx;
  const c = await api(SALES, 'POST', '/tenants', { cookie: salesCookie, body: { tenantId: v.id, tenantName: `E2E Tax ${v.id}`, companyNPWP: NPWP_V, companyAddress: 'Jl. E2E 1' } });
  if (!log(c.ok, `Sales tenant ${v.id}`, c.ok ? '' : c.json?.error)) return false;
  if (v.pkp) {
    const s = await api(SALES, 'PUT', '/tenant/settings', { cookie: salesCookie, body: { tenantId: v.id, companyNPWP: NPWP_V, tax: { pkp: true } } });
    if (!log(s.ok && s.json?.tax?.pkp === true, `Sales ${v.id} PKP`, s.ok ? `ppnPercent=${s.json?.ppnPercent}` : s.json?.error)) return false;
  }
  v.products = {};
  for (const p of [PROD_A, PROD_B]) {
    const r = await api(SALES, 'POST', '/products', { cookie: salesCookie, body: { tenantId: v.id, grup: 'Sembako', satuan: 'PCS', ...p } });
    if (!log(r.ok, `Produk ${p.kode} @ ${v.id}`, r.ok ? '' : r.json?.error)) return false;
    v.products[p.kode] = r.json;
    const adj = await api(SALES, 'POST', '/stok/penyesuaian', {
      cookie: salesCookie,
      body: { tenantId: v.id, lokasi: 'L001', keterangan: 'E2E tax seed', items: [{ stokId: r.json.id, kode: p.kode, qtyAktual: 1000 }] },
    });
    if (!log(adj.ok, `Stok ${p.kode} @ ${v.id}`, adj.ok ? '1000 @ L001' : adj.json?.error)) return false;
  }
  return true;
}

async function setupCustomer(ctx, pair) {
  const { salesCookie, invCookie } = ctx;
  const c = await api(INVENTORY, 'POST', '/tenants', { cookie: invCookie, body: { tenantId: pair.customer, tenantName: `E2E Tax ${pair.customer}`, companyNPWP: pair.npwp } });
  if (!log(c.ok, `Inventory tenant ${pair.customer}`, c.ok ? '' : c.json?.error)) return false;
  const s = await api(INVENTORY, 'PUT', '/tenant/settings', {
    cookie: invCookie,
    body: { tenantId: pair.customer, companyNPWP: pair.npwp, companyAddress: `Jl. E2E ${pair.customer}`, tax: { pkp: pair.buyerPkp } },
  });
  if (!log(s.ok && s.json?.tax?.pkp === pair.buyerPkp, `Inventory ${pair.customer} ${pair.buyerPkp ? 'PKP' : 'non-PKP'} NPWP ${pair.npwp}`, s.ok ? '' : s.json?.error)) return false;
  const setup = await api(SALES, 'POST', '/integrations/setup', {
    cookie: salesCookie,
    body: {
      tenantId: pair.vendor,
      inventoryUrl: `${INVENTORY}/api/webhooks/sales`,
      customerTenantId: pair.customer,
      customerName: `E2E ${pair.customer}`,
      salesAppUrl: SALES,
      autoPair: false,
      autoSyncCatalog: false,
    },
  });
  if (!log(setup.ok && setup.json?.apiKey, `Setup integrasi ${pair.vendor}→${pair.customer}`, setup.ok ? '' : setup.json?.error)) return false;
  const pairRes = await api(INVENTORY, 'POST', '/integrations/pair', {
    body: {
      setupToken: SETUP_TOKEN,
      customerTenantId: pair.customer,
      vendorTenantId: pair.vendor,
      salesAppUrl: SALES,
      salesApiKey: setup.json.apiKey,
      webhookSecret: setup.json.webhookSecret,
      vendorName: pair.vendor,
      tierHargaDefault: 'GROSIR',
      autoSyncCatalog: false,
    },
  });
  if (!log(pairRes.ok, `Pair ${pair.customer}`, pairRes.ok ? '' : pairRes.json?.error)) return false;
  const sync = await api(INVENTORY, 'POST', `/integrations/sync-catalog?inline=1&tenantId=${pair.customer}`, { cookie: invCookie, body: { tenantId: pair.customer, inline: true } });
  if (!log(sync.ok, `Sync katalog ${pair.customer}`, sync.ok ? '' : sync.json?.error)) return false;
  await ctx.invDb.collection('products').updateMany(
    { tenantId: pair.customer, $or: [{ gudangKode: { $exists: false } }, { gudangKode: { $in: ['', null] } }] },
    { $set: { gudangKode: 'GKERING' } },
  );
  const prods = await ctx.invDb.collection('products').find({ tenantId: pair.customer, vendorTenantId: pair.vendor, aktif: { $ne: false } }).toArray();
  pair.products = Object.fromEntries(prods.map((p) => [p.kode, p]));
  if (!log(Boolean(pair.products[PROD_A.kode] && pair.products[PROD_B.kode]), `Produk ter-mapping ${pair.customer}`, prods.map((p) => p.kode).join(', '))) return false;

  // Profil pajak pembeli → pelanggan B2B Sales (job push saat link dibuat).
  const party = await poll(async () => {
    const p = await ctx.salesDb.collection('pelanggan_parties').findOne({ customerTenantId: pair.customer });
    const legacy = await ctx.salesDb.collection('pelanggan').findOne({ tenantId: pair.vendor, customerTenantId: pair.customer });
    const row = p || legacy;
    return row?.npwp === pair.npwp && row?.pkp === pair.buyerPkp ? row : null;
  }, { timeoutMs: 40_000, drainEvery: 2 });
  const link = await ctx.invDb.collection('integration_links').findOne({ customerTenantId: pair.customer, vendorTenantId: pair.vendor });
  return log(Boolean(party), `Profil pajak ${pair.customer} → pelanggan Sales`,
    party ? `npwp=${party.npwp} pkp=${party.pkp} sync=${link?.taxProfileSync?.status}` : `belum tersinkron (sync=${JSON.stringify(link?.taxProfileSync || null)})`);
}

async function runCycle(ctx, pair) {
  const { salesCookie, invCookie, salesDb, invDb } = ctx;
  const vendor = VENDORS.find((v) => v.id === pair.vendor);
  const tag = `[${vendor.pkp ? 'V-PKP' : 'V-non'}×${pair.buyerPkp ? 'B-PKP' : 'B-non'}]`;
  const q = `tenantId=${pair.customer}`;
  console.log(`\n--- ${tag} ${pair.vendor} → ${pair.customer} ---`);

  // PO → SO
  const noPO = `CPO-E2ETAX-${Date.now()}`;
  const items = [PROD_A, PROD_B].map((p) => {
    const ip = pair.products[p.kode];
    return { localStokId: ip.id, vendorStokId: ip.vendorStokId, vendorKode: p.kode, kode: p.kode, nama: ip.nama, satuan: ip.satuan || 'PCS', qty: 10 };
  });
  const po = await api(INVENTORY, 'POST', '/customer-purchase-orders', { cookie: invCookie, body: { tenantId: pair.customer, noPO, items } });
  if (!log(po.ok, `${tag} Buat PO`, po.ok ? noPO : po.json?.error)) return;
  const sub = await api(INVENTORY, 'POST', `/customer-purchase-orders/${po.json.id}/submit`, { cookie: invCookie, body: { tenantId: pair.customer } });
  if (!log(sub.ok, `${tag} Submit PO`, sub.ok ? '' : sub.json?.error)) return;
  let soId = sub.json?.vendorSoId || (sub.json?.vendorSubmissions || []).find((s) => s.vendorSoId)?.vendorSoId;
  if (!soId) {
    const cpo = await poll(async () => {
      const d = await invDb.collection('customer_purchase_orders').findOne({ id: po.json.id });
      return d?.vendorSoId || (d?.vendorSubmissions || []).find((s) => s.vendorSoId)?.vendorSoId || null;
    });
    soId = cpo;
  }
  if (!log(Boolean(soId), `${tag} PO → SO`, soId ? '' : 'vendorSoId kosong')) return;
  const conf = await api(SALES, 'POST', `/sales-orders/${soId}/confirm`, { cookie: salesCookie, body: { tenantId: pair.vendor } });
  if (!log(conf.ok, `${tag} Konfirmasi SO`, conf.ok ? '' : conf.json?.error)) return;
  const so = await salesDb.collection('sales_orders').findOne({ id: soId });
  const soPpnOk = vendor.pkp ? (so.ppn || 0) > 0 : (so.ppn || 0) === 0;
  log(soPpnOk, `${tag} SO PPN`, `subTotal=${so.subTotal} ppn=${so.ppn || 0} total=${so.total}`);
  await drainAll(1);

  // DO → ship → GRN
  const doRes = await api(SALES, 'POST', '/deliveries', {
    cookie: salesCookie,
    body: { salesOrderId: soId, tenantId: pair.vendor, items: so.items.map((l) => ({ lineId: l.lineId, stokId: l.stokId, qty: l.qtyOrdered || l.qty })) },
  });
  if (!log(doRes.ok, `${tag} Buat DO`, doRes.ok ? doRes.json.noDO : doRes.json?.error)) return;
  const ship = await api(SALES, 'POST', `/deliveries/${doRes.json.id}/ship`, { cookie: salesCookie, body: { tenantId: pair.vendor } });
  if (!log(ship.ok, `${tag} Kirim DO`, ship.ok ? '' : ship.json?.error)) return;
  await drainAll(1);
  const grn = await poll(() => invDb.collection('goods_receipts').findOne({ tenantId: pair.customer, vendorDeliveryId: doRes.json.id }));
  if (!log(Boolean(grn), `${tag} GRN draft`, grn ? `${grn.noGRN} ${grn.status}` : 'tidak muncul')) return;

  // Short qty: A 10 dikirim → 8 diterima.
  const idA = pair.products[PROD_A.kode].id;
  const postItems = (grn.items || []).map((it) => ({ lineId: it.lineId, qty: it.localStokId === idA ? 8 : (it.qtyOrdered || 10) }));
  const post = await api(INVENTORY, 'POST', `/goods-receipts/${grn.id}/post`, { cookie: invCookie, body: { tenantId: pair.customer, asyncInvoice: false, items: postItems, receivedBy: { userName: 'E2E Gudang', jabatan: 'Staf Gudang', nik: '3201010101010001' } } });
  if (!log(post.ok, `${tag} Post GRN (A 8/10)`, post.ok ? `invoice=${post.json?.noInvoice || post.json?.invoiceSync?.noInvoice || '-'}` : post.json?.error)) return;

  const inv = await poll(() => salesDb.collection('invoices').findOne({ tenantId: pair.vendor, deliveryId: doRes.json.id, status: 'POSTED' }));
  if (!log(Boolean(inv), `${tag} Invoice POSTED`, inv ? inv.noInvoice : 'tidak ada')) return;
  const settings = await salesDb.collection('tenant_settings').findOne({ tenantId: pair.vendor });
  const rate = Number(inv.ppnRate ?? settings?.ppnPercent ?? 11);
  const lineA = inv.items.find((l) => l.kode === PROD_A.kode);
  const lineB = inv.items.find((l) => l.kode === PROD_B.kode);
  const expSub = 8 * PROD_A.hargaGrosir + 10 * PROD_B.hargaGrosir;
  const expPpn = vendor.pkp ? round((8 * PROD_A.hargaGrosir * rate) / 100) : 0;
  log(Number(lineA?.qty) === 8 && Number(lineB?.qty) === 10, `${tag} Invoice qty dari GRN`, `A=${lineA?.qty} B=${lineB?.qty}`);
  log(inv.subTotal === expSub && (inv.ppn || 0) === expPpn && inv.total === expSub - (inv.diskonNota || 0) + expPpn,
    `${tag} Invoice DPP/PPN`, `sub=${inv.subTotal} ppn=${inv.ppn || 0} (exp ${expPpn} @${vendor.pkp ? rate : 0}%) total=${inv.total}`);

  const faktur = await salesDb.collection('faktur_pajak').findOne({ tenantId: pair.vendor, invoiceId: inv.id, aktif: true });
  if (vendor.pkp) {
    log(Boolean(faktur) && Math.abs((faktur.ppn || 0) - expPpn) <= 1, `${tag} Faktur DRAFT dibuat`, faktur ? `status=${faktur.status} dpp=${faktur.dpp} ppn=${faktur.ppn}` : 'tidak ada');
    log(faktur?.buyer?.document === 'TIN' && faktur.buyer.npwp === pair.npwp && faktur.buyer.pkp === pair.buyerPkp,
      `${tag} Faktur: identitas pembeli dari Inventory`, `doc=${faktur?.buyer?.document} npwp=${faktur?.buyer?.npwp} pkp=${faktur?.buyer?.pkp}`);
  } else {
    log(!faktur, `${tag} Tanpa faktur (vendor non-PKP)`, faktur ? `ada faktur ${faktur.status}` : '');
  }

  // Hutang + jurnal
  const hutang = await poll(() => invDb.collection('hutang').findOne({ tenantId: pair.customer, noInvoice: inv.noInvoice }));
  if (!log(Boolean(hutang), `${tag} Hutang dibuat`, hutang ? `${hutang.noHutang || hutang.id} via=${hutang.createdVia} match=${hutang.matchStatus}` : 'tidak ada')) return;
  log(hutang.total === inv.total && (hutang.ppn || 0) === (inv.ppn || 0) && hutang.subTotal === inv.subTotal,
    `${tag} Hutang = invoice`, `total=${hutang.total} ppn=${hutang.ppn || 0} sub=${hutang.subTotal}`);
  log(hutang.ppnDikreditkan === pair.buyerPkp, `${tag} ppnDikreditkan snapshot`, String(hutang.ppnDikreditkan));
  const hj = await poll(() => invDb.collection('jurnal').findOne({ tenantId: pair.customer, sourceType: 'AUTO_HUTANG_VENDOR', sourceId: hutang.id, voidedAt: { $exists: false } }), { timeoutMs: 15_000 });
  if (log(Boolean(hj), `${tag} Jurnal tagihan`, hj ? hj.noJurnal || hj.id : `tidak ada (approval=${hutang.approvalStatus})`)) {
    const ppnLine = journalSums([hj], COA_PPN_MASUKAN);
    const expLine = pair.buyerPkp ? (hutang.ppn || 0) : 0;
    const deb = (hj.details || []).reduce((s, d) => s + (Number(d.debet) || 0), 0);
    const kre = (hj.details || []).reduce((s, d) => s + (Number(d.kredit) || 0), 0);
    log(ppnLine === expLine && deb === kre && deb === hutang.total,
      `${tag} Jurnal tagihan: PPN Masukan ${pair.buyerPkp ? 'dikreditkan' : 'dikapitalisasi'}`,
      `Dr 10410=${ppnLine} (exp ${expLine}) D=${deb} K=${kre}`);
  }

  // Nomor faktur → hutang.fakturPajak
  let nomor = null;
  if (vendor.pkp && faktur) {
    nomor = `04${String(Date.now()).slice(-12)}${String(crypto.randomInt(10, 99))}`;
    const n = await api(SALES, 'POST', `/faktur-pajak/${faktur.id}/nomor`, { cookie: salesCookie, body: { tenantId: pair.vendor, nomorFaktur: nomor } });
    if (log(n.ok, `${tag} Isi nomor faktur`, n.ok ? nomor : n.json?.error)) {
      const synced = await poll(async () => {
        const h = await invDb.collection('hutang').findOne({ id: hutang.id });
        return h?.fakturPajak?.nomorFaktur === nomor || h?.fakturPajak?.nomor === nomor ? h : null;
      }, { timeoutMs: 40_000, drainEvery: 2 });
      log(Boolean(synced), `${tag} Nomor faktur → hutang`, synced ? `status=${synced.fakturPajak?.status}` : 'belum tersinkron');
      log(synced?.fakturPajak?.buyerNpwp === pair.npwp, `${tag} NPWP pembeli di faktur → hutang`, `buyerNpwp=${synced?.fakturPajak?.buyerNpwp}`);
      if (pair.buyerPkp) {
        const masa = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
        const rep = await api(INVENTORY, 'GET', `/ppn-masukan?masa=${masa}&${q}`, { cookie: invCookie });
        const rows = rep.json?.rows || rep.json?.items || [];
        const row = Array.isArray(rows) ? rows.find((r) => r.noInvoice === inv.noInvoice || r.hutangId === hutang.id) : null;
        log(rep.ok && row?.status === 'SIAP_DIKREDITKAN', `${tag} Laporan PPN Masukan`, rep.ok ? `status=${row?.status || '(tidak ada baris)'}` : rep.json?.error);
      }
    }
  }

  // CN (retur 2 A) + DN (tambahan 1 × 1.000 pada A)
  let cnPpn = 0;
  let dnPpn = 0;
  const cn = await api(SALES, 'POST', '/credit-notes', {
    cookie: salesCookie,
    body: { tenantId: pair.vendor, invoiceId: inv.id, items: [{ lineId: lineA.lineId, stokId: lineA.stokId, uomId: lineA.uomId, satuan: lineA.satuan, kode: lineA.kode, nama: lineA.nama, qty: 2, harga: lineA.harga, hargaBeli: lineA.hargaBeli }] },
  });
  if (log(cn.ok, `${tag} Buat CN`, cn.ok ? cn.json.noCN : cn.json?.error)) {
    const pc = await api(SALES, 'POST', `/credit-notes/${cn.json.id}/post`, { cookie: salesCookie, body: { tenantId: pair.vendor } });
    if (log(pc.ok, `${tag} Post CN`, pc.ok ? `ppn=${pc.json?.ppn ?? '-'} total=${pc.json?.total ?? '-'}` : pc.json?.error)) {
      const cnDoc = await salesDb.collection('credit_notes').findOne({ id: cn.json.id });
      cnPpn = cnDoc?.ppn || 0;
      const expCnPpn = vendor.pkp ? round((2 * PROD_A.hargaGrosir * rate) / 100) : 0;
      log(Math.abs(cnPpn - expCnPpn) <= 1, `${tag} CN PPN`, `${cnPpn} (exp ${expCnPpn})`);
      if (vendor.pkp && nomor) {
        const fCn = await salesDb.collection('faktur_pajak').find({ tenantId: pair.vendor, invoiceId: inv.id }).toArray();
        const aktif = fCn.find((f) => f.aktif);
        const retur = (aktif?.returPembeli || []).find((r) => r.creditNoteId === cn.json.id);
        const ok = pair.buyerPkp
          ? !aktif?.pengganti && aktif?.status === 'DISETUJUI' && retur?.status === 'MENUNGGU'
          : aktif?.pengganti === true && !retur;
        log(ok, `${tag} Retur atas faktur bernomor: ${pair.buyerPkp ? 'menunggu retur pembeli (PKP)' : 'faktur pengganti (non-PKP)'}`,
          `aktif=${aktif?.status}${aktif?.pengganti ? ' pengganti' : ''} retur=${retur?.status || '-'}`);
      }
      const h = await poll(async () => {
        const r = await invDb.collection('hutang').findOne({ id: hutang.id });
        return (r?.creditNotes || []).some((c) => c.noCN === cn.json.noCN) ? r : null;
      }, { timeoutMs: 40_000, drainEvery: 2 });
      const entry = h?.creditNotes?.find((c) => c.noCN === cn.json.noCN);
      log(Boolean(entry) && Number(entry.amount) === cnDoc.total, `${tag} CN → hutang`, entry ? `amount=${entry.amount} ppn=${entry.ppn ?? '-'} sisa=${h.sisa}` : 'belum diterapkan');
    }
  }
  const dn = await api(SALES, 'POST', '/debit-notes', {
    cookie: salesCookie,
    body: { tenantId: pair.vendor, invoiceId: inv.id, items: [{ lineId: lineA.lineId, stokId: lineA.stokId, qty: 1, harga: 1000 }], catatan: 'E2E koreksi harga' },
  });
  if (log(dn.ok, `${tag} Buat DN`, dn.ok ? dn.json.noDN : dn.json?.error)) {
    const pd = await api(SALES, 'POST', `/debit-notes/${dn.json.id}/post`, { cookie: salesCookie, body: { tenantId: pair.vendor } });
    if (log(pd.ok, `${tag} Post DN`, pd.ok ? '' : pd.json?.error)) {
      const dnDoc = await salesDb.collection('debit_notes').findOne({ id: dn.json.id });
      dnPpn = dnDoc?.ppn || 0;
      const expDnPpn = vendor.pkp ? round((1000 * rate) / 100) : 0;
      log(dnPpn === expDnPpn, `${tag} DN PPN`, `${dnPpn} (exp ${expDnPpn}) total=${dnDoc?.total}`);
      const h = await poll(async () => {
        const r = await invDb.collection('hutang').findOne({ id: hutang.id });
        return (r?.debitNotes || []).some((c) => c.noDN === dn.json.noDN) ? r : null;
      }, { timeoutMs: 40_000, drainEvery: 2 });
      const entry = h?.debitNotes?.find((c) => c.noDN === dn.json.noDN);
      log(Boolean(entry) && Number(entry.amount) === dnDoc.total, `${tag} DN → hutang`, entry ? `amount=${entry.amount} ppn=${entry.ppn ?? '-'} total=${h.total}` : 'belum diterapkan');
    }
  }

  if (vendor.pkp) {
    const fAfter = await salesDb.collection('faktur_pajak').find({ tenantId: pair.vendor, invoiceId: inv.id }).toArray();
    console.log(`   faktur setelah CN/DN: ${fAfter.map((f) => `${f.status}${f.aktif ? '*' : ''} ppn=${f.ppn}${f.pengganti ? ' pengganti' : ''}${(f.returPembeli || []).length ? ` retur=${f.returPembeli.map((r) => r.status).join('/')}` : ''}`).join(' | ')}`);
  }

  // Repair job tidak mengubah apa pun
  await drainAll(2);
  const before = await invDb.collection('hutang').findOne({ id: hutang.id });
  const jCountBefore = await invDb.collection('jurnal').countDocuments({ tenantId: pair.customer });
  const fix = await api(INVENTORY, 'POST', '/hutang/backfix', { cookie: invCookie, body: { tenantId: pair.customer, replaySales: false } });
  const after = await invDb.collection('hutang').findOne({ id: hutang.id });
  const jCountAfter = await invDb.collection('jurnal').countDocuments({ tenantId: pair.customer });
  const keys = ['total', 'ppn', 'subTotal', 'sisa', 'matchStatus', 'approvalStatus', 'glPostingBase', 'ppnDikreditkan'];
  const changed = keys.filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  log(fix.ok && !changed.length && jCountBefore === jCountAfter,
    `${tag} Repair (backfix) no-op`, fix.ok ? `fixed=${fix.json?.fixed} created=${fix.json?.created} berubah=[${changed.join(',')}] jurnal ${jCountBefore}→${jCountAfter}` : fix.json?.error);

  // Saldo
  const journals = await invDb.collection('jurnal').find({ tenantId: pair.customer }).toArray();
  const unbalanced = journals.filter((j) => {
    const d = (j.details || []).reduce((s, x) => s + (Number(x.debet) || 0), 0);
    const k = (j.details || []).reduce((s, x) => s + (Number(x.kredit) || 0), 0);
    return d !== k;
  });
  log(!unbalanced.length, `${tag} Semua jurnal seimbang`, `${journals.length} jurnal${unbalanced.length ? `, timpang: ${unbalanced.map((j) => j.sourceType).join(',')}` : ''}`);
  const hutangJournals = journals.filter((j) => COA_HUTANG_SOURCES.includes(j.sourceType) || COA_HUTANG_SOURCES.includes(j.reversesSourceType));
  const ppnBal = journalSums(journals, COA_PPN_MASUKAN);
  const expBal = pair.buyerPkp ? (inv.ppn || 0) - cnPpn + dnPpn : 0;
  log(ppnBal === expBal, `${tag} Saldo PPN Masukan`, `${ppnBal} (exp ${expBal}; jurnal hutang/CN/DN: ${hutangJournals.length})`);
  const final = await invDb.collection('hutang').findOne({ id: hutang.id });
  const cnTotal = (final.creditNotes || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const dnTotal = (final.debitNotes || []).reduce((s, c) => s + (Number(c.amount) || 0), 0);
  // CN tercatat sebagai pengurang lewat `terbayar` (kelebihan → kreditVendorKelebihan).
  log(final.total === inv.total + dnTotal && (final.terbayar || 0) === cnTotal - (final.kreditVendorKelebihan || 0)
    && final.sisa === final.total - (final.terbayar || 0),
    `${tag} Hutang akhir`, `total=${final.total} terbayar=${final.terbayar} sisa=${final.sisa} cn=${cnTotal} dn=${dnTotal} ppn=${final.ppn}`);
}

async function main() {
  console.log('\n=== E2E MATRIKS PAJAK (dev) ===\n');
  const ctx = {};
  const client = new MongoClient(invEnv.MONGO_URL);
  await client.connect();
  ctx.invDb = client.db(invEnv.DB_NAME);
  ctx.salesDb = client.db(salesEnv.DB_NAME);
  try {
    ctx.salesCookie = await login(SALES);
    ctx.invCookie = await login(INVENTORY);
    if (!log(Boolean(ctx.salesCookie && ctx.invCookie), 'Login master dev')) return;
    const pre = await cleanup(ctx);
    if (pre) console.log(`   (sisa run sebelumnya dibersihkan: ${pre} dokumen)`);
    for (const v of VENDORS) if (!(await setupVendor(ctx, v))) return;
    for (const p of PAIRS) {
      if (process.env.ONLY && !p.customer.endsWith(process.env.ONLY)) continue;
      if (!(await setupCustomer(ctx, p))) continue;
      try {
        await runCycle(ctx, p);
      } catch (e) {
        log(false, `Siklus ${p.customer}`, e instanceof Error ? e.stack : String(e));
      }
    }
  } finally {
    if (process.env.KEEP !== '1') {
      const left = await cleanup(ctx);
      const remain = [];
      for (const db of [ctx.salesDb, ctx.invDb]) {
        const n = await db.collection('tenant_settings').countDocuments({ tenantId: { $regex: `^${PREFIX}` } });
        if (n) remain.push(`${db.databaseName}:${n}`);
      }
      log(!remain.length, 'Cleanup tenant e2e-tax-*', `sisa sapuan=${left}${remain.length ? `, tersisa ${remain.join(',')}` : ''}`);
    }
    await client.close();
    const failed = steps.filter((s) => !s.ok);
    console.log(`\n=== SELESAI: ${steps.length - failed.length}/${steps.length} OK ===`);
    if (failed.length) console.log(failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'));
    process.exitCode = failed.length ? 1 : 0;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
