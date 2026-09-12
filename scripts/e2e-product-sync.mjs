#!/usr/bin/env node
/**
 * E2E product sync (Sales ↔ Inventory) — Category A.
 * Run inside Docker network sales_default:
 *   node scripts/e2e-product-sync.mjs
 *
 * Env:
 *   SALES_URL=http://sales-e2e:3000
 *   INV_URL=http://inventory-e2e:3001
 *   MONGO_URL=mongodb://sales-mongo-1:27017
 *   WORKER_SECRET=...
 *   WEBHOOK_SECRET=...
 */
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';

const SALES = (process.env.SALES_URL || 'http://sales-e2e:3000').replace(/\/$/, '');
const INV = (process.env.INV_URL || 'http://inventory-e2e:3001').replace(/\/$/, '');
const MONGO = process.env.MONGO_URL || 'mongodb://sales-mongo-1:27017/?directConnection=true';
const WORKER = String(process.env.WORKER_SECRET || 'dev-worker-secret').trim();
const WEBHOOK = String(process.env.WEBHOOK_SECRET || '').trim();
const VENDOR = 'puspita';
const CUSTOMER = 'sppg';
const KODE = `E2E${Date.now().toString().slice(-8)}`;

const results = [];
function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail = '') {
  results.push({ name, pass: false, detail });
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function assert(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else fail(name, detail);
}

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status > 0) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function main() {
  console.log('=== E2E Product Sync ===');
  console.log({ SALES, INV, VENDOR, CUSTOMER, KODE });

  if (!WEBHOOK) throw new Error('WEBHOOK_SECRET wajib');

  const upSales = await waitHttp(`${SALES}/api/health`).catch(() => false)
    || await waitHttp(`${SALES}/api/integrations/public-info`).catch(() => false)
    || await waitHttp(SALES);
  const upInv = await waitHttp(`${INV}/api/health`).catch(() => false)
    || await waitHttp(`${INV}/api/v1/integrations/public-info`).catch(() => false)
    || await waitHttp(INV);
  await assert('sales reachable', upSales, SALES);
  await assert('inventory reachable', upInv, INV);
  if (!upSales || !upInv) {
    console.error('Apps not up — abort');
    process.exit(2);
  }

  const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const salesDb = client.db(process.env.SALES_DB_NAME || 'kasir_db');
  const invDb = client.db(process.env.INV_DB_NAME || 'inventory_customer');

  const productId = randomUUID();
  const now = new Date();
  const product = {
    id: productId,
    tenantId: VENDOR,
    kode: KODE,
    barcode: `BC${KODE}`,
    nama: `E2E Sync ${KODE}`,
    grup: 'Umum',
    satuan: 'PCS',
    aktif: true,
    hargaBeli: 1000,
    hargaGrosir: 1200,
    hargaSpesial: 1100,
    hargaEcer: 1500,
    detailProduk: 'detail dari sales awal',
    fotos: ['https://example.com/e2e-a.jpg'],
    detailFotosUpdatedAt: now,
    stok: 0,
    minStok: 0,
    createdAt: now,
    updatedAt: now,
  };
  await salesDb.collection('products').insertOne({ ...product });
  ok('seed sales product', KODE);

  // ── 1) Category A push: create/update ─────────────────────────────────
  const emittedAt1 = new Date().toISOString();
  const corr1 = randomUUID();
  const body1 = {
    event: 'product.updated',
    customerTenantId: CUSTOMER,
    vendorTenantId: VENDOR,
    correlationId: corr1,
    emittedAt: emittedAt1,
    product: {
      ...product,
      emittedAt: emittedAt1,
      detailFotosUpdatedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  };
  const push1 = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/vnd.dawam.integration.v1+json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': `e2e:${productId}:create:${Date.now()}`,
      'X-Correlation-Id': corr1,
    },
    body: JSON.stringify(body1),
  });
  const push1Json = await push1.json().catch(() => ({}));
  await assert(
    'HTTP product-upserted create',
    push1.ok && (push1Json.action === 'created' || push1Json.action === 'updated'),
    `${push1.status} ${JSON.stringify(push1Json).slice(0, 180)}`,
  );

  const inv1 = await invDb.collection('products').findOne({
    tenantId: CUSTOMER,
    vendorTenantId: VENDOR,
    vendorStokId: productId,
  });
  await assert('inventory mirror exists', !!inv1, inv1?.id || 'missing');
  await assert('inventory nama synced', inv1?.nama === product.nama, inv1?.nama);
  await assert(
    'inventory detail synced',
    inv1?.detailProduk === 'detail dari sales awal',
    String(inv1?.detailProduk || ''),
  );
  await assert('lastVendorSyncEmittedAt stamped', !!inv1?.lastVendorSyncEmittedAt);

  // ── 2) Idempotency replay (body harus IDENTIK) ────────────────────────
  const idemKey = `e2e-idem-${productId}`;
  const corrIdem = randomUUID();
  const idemBody = {
    event: 'product.updated',
    customerTenantId: CUSTOMER,
    vendorTenantId: VENDOR,
    correlationId: corrIdem,
    product: {
      id: productId,
      kode: KODE,
      nama: 'E2E Idem Name',
      aktif: true,
      hargaBeli: 1000,
      emittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  const first = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': idemKey,
      'X-Correlation-Id': corrIdem,
    },
    body: JSON.stringify(idemBody),
  });
  const second = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': idemKey,
      'X-Correlation-Id': corrIdem,
    },
    body: JSON.stringify(idemBody),
  });
  await assert('idempotency first ok', first.ok, String(first.status));
  await assert(
    'idempotency replay ok',
    second.ok || second.status === 200,
    String(second.status),
  );

  // ── 3) Inventory enrichment → Sales ───────────────────────────────────
  const enrichAt = new Date();
  await invDb.collection('products').updateOne(
    { id: inv1.id },
    {
      $set: {
        detailProduk: 'ENRICHED FROM INVENTORY',
        fotos: ['https://example.com/e2e-inv.jpg'],
        detailFotosUpdatedAt: enrichAt,
        updatedAt: enrichAt,
      },
    },
  );
  const enrichRes = await fetch(`${SALES}/api/integrations/product-enrichment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WORKER}`,
      'x-worker-secret': WORKER,
      'X-Correlation-Id': randomUUID(),
      'Idempotency-Key': `e2e-enrich-${productId}`,
    },
    body: JSON.stringify({
      tenantId: VENDOR,
      productId,
      kode: KODE,
      detailProduk: 'ENRICHED FROM INVENTORY',
      fotos: ['https://example.com/e2e-inv.jpg'],
      detailFotosUpdatedAt: enrichAt.toISOString(),
    }),
  });
  const enrichJson = await enrichRes.json().catch(() => ({}));
  await assert(
    'enrichment HTTP to sales',
    enrichRes.ok && enrichJson.skipped !== 'stale_enrichment',
    `${enrichRes.status} ${JSON.stringify(enrichJson).slice(0, 160)}`,
  );
  const salesAfterEnrich = await salesDb.collection('products').findOne({ id: productId });
  await assert(
    'sales detail enriched',
    salesAfterEnrich?.detailProduk === 'ENRICHED FROM INVENTORY',
    String(salesAfterEnrich?.detailProduk || ''),
  );

  // ── 4) LWW: stale sales detail must NOT overwrite newer inventory ─────
  const staleEmit = new Date(enrichAt.getTime() - 60_000).toISOString();
  const corrLww = randomUUID();
  const lwwPush = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': `e2e-lww-${productId}`,
      'X-Correlation-Id': corrLww,
    },
    body: JSON.stringify({
      event: 'product.updated',
      customerTenantId: CUSTOMER,
      vendorTenantId: VENDOR,
      correlationId: corrLww,
      product: {
        id: productId,
        kode: KODE,
        nama: product.nama,
        aktif: true,
        detailProduk: 'STALE SALES DETAIL SHOULD NOT WIN',
        fotos: ['https://example.com/stale.jpg'],
        detailFotosUpdatedAt: staleEmit,
        emittedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }),
  });
  const lwwJson = await lwwPush.json().catch(() => ({}));
  await assert('LWW push accepted', lwwPush.ok, `${lwwPush.status} ${lwwJson.action || ''}`);
  const invAfterLww = await invDb.collection('products').findOne({ id: inv1.id });
  await assert(
    'LWW keeps inventory enrichment',
    invAfterLww?.detailProduk === 'ENRICHED FROM INVENTORY',
    String(invAfterLww?.detailProduk || ''),
  );

  // ── 5) Stale emit skip (watermark) ────────────────────────────────────
  const lastEmit = invAfterLww?.lastVendorSyncEmittedAt;
  const older = new Date((lastEmit ? new Date(lastEmit).getTime() : Date.now()) - 120_000).toISOString();
  const corrStale = randomUUID();
  const stalePush = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': `e2e-stale-${productId}`,
      'X-Correlation-Id': corrStale,
    },
    body: JSON.stringify({
      event: 'product.updated',
      customerTenantId: CUSTOMER,
      vendorTenantId: VENDOR,
      correlationId: corrStale,
      product: {
        id: productId,
        kode: KODE,
        nama: 'SHOULD SKIP STALE',
        aktif: true,
        emittedAt: older,
        updatedAt: older,
      },
    }),
  });
  const staleJson = await stalePush.json().catch(() => ({}));
  await assert(
    'stale emit skipped_stale',
    stalePush.ok && staleJson.action === 'skipped_stale',
    `${stalePush.status} ${staleJson.action || JSON.stringify(staleJson).slice(0, 120)}`,
  );

  // ── 6) Deactivate (Sales source-of-truth: set Sales aktif=false dulu) ─
  await salesDb.collection('products').updateOne(
    { id: productId },
    { $set: { aktif: false, updatedAt: new Date() } },
  );
  // Tunggu emit enrichment/outbox yang mungkin masih in-flight
  await new Promise((r) => setTimeout(r, 1500));
  const deactEmit = new Date().toISOString();
  const corrDeact = randomUUID();
  const deact = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': `e2e-deact-${productId}`,
      'X-Correlation-Id': corrDeact,
    },
    body: JSON.stringify({
      event: 'product.deactivated',
      customerTenantId: CUSTOMER,
      vendorTenantId: VENDOR,
      correlationId: corrDeact,
      product: {
        id: productId,
        kode: KODE,
        aktif: false,
        emittedAt: deactEmit,
        updatedAt: deactEmit,
      },
    }),
  });
  const deactJson = await deact.json().catch(() => ({}));
  await assert(
    'deactivate ok',
    deact.ok && (deactJson.action === 'deactivated' || deactJson.action === 'skipped'),
    `${deact.status} ${deactJson.action || ''}`,
  );
  // Poll singkat — late Sales push dengan emittedAt lebih tua harus skipped_stale
  let invDeact = null;
  for (let i = 0; i < 10; i++) {
    invDeact = await invDb.collection('products').findOne({ id: inv1.id });
    if (invDeact?.aktif === false) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await assert('inventory aktif=false', invDeact?.aktif === false, `aktif=${invDeact?.aktif}`);

  // ── 7) Soft-reactivate (Sales aktif lagi + newer emit) ────────────────
  await salesDb.collection('products').updateOne(
    { id: productId },
    { $set: { aktif: true, updatedAt: new Date() } },
  );
  const reviveEmit = new Date(Date.parse(deactEmit) + 2000).toISOString();
  const corrRevive = randomUUID();
  const revive = await fetch(`${INV}/api/v1/integrations/product-upserted`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK,
      'X-Vendor-Tenant-Id': VENDOR,
      'Idempotency-Key': `e2e-revive-${productId}`,
      'X-Correlation-Id': corrRevive,
    },
    body: JSON.stringify({
      event: 'product.updated',
      customerTenantId: CUSTOMER,
      vendorTenantId: VENDOR,
      correlationId: corrRevive,
      product: {
        id: productId,
        kode: KODE,
        nama: product.nama,
        aktif: true,
        emittedAt: reviveEmit,
        updatedAt: reviveEmit,
      },
    }),
  });
  const reviveJson = await revive.json().catch(() => ({}));
  await assert(
    'soft-reactivate not skipped_stale',
    revive.ok && reviveJson.action !== 'skipped_stale',
    `${revive.status} ${reviveJson.action || ''}`,
  );
  const invRevive = await invDb.collection('products').findOne({ id: inv1.id });
  await assert('inventory aktif=true after revive', invRevive?.aktif === true);

  // ── 8) Fanout link sanity ─────────────────────────────────────────────
  const links = await salesDb.collection('integration_links').find({
    vendorTenantId: VENDOR,
    status: 'ACTIVE',
  }).toArray();
  await assert('active integration link exists', links.length >= 1, String(links.length));
  await assert(
    'link points to inventory-e2e',
    String(links[0]?.inventoryUrl || '').includes('inventory-e2e'),
    String(links[0]?.inventoryUrl || ''),
  );

  // cleanup seed
  await salesDb.collection('products').deleteOne({ id: productId });
  await invDb.collection('products').deleteOne({ id: inv1.id });
  ok('cleanup seed products');

  await client.close();

  const failed = results.filter((r) => !r.pass);
  console.log('\n=== SUMMARY ===');
  console.log(`passed=${results.filter((r) => r.pass).length} failed=${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.error(` - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('ALL E2E CHECKS PASSED');
}

main().catch((e) => {
  console.error('E2E crashed', e);
  process.exit(2);
});
