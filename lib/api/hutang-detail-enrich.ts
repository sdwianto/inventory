import type { Db } from 'mongodb';
// Enrichment detail tagihan vendor — profil penagih & baris item lengkap.

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { loadStoreSnapshot } from '@/lib/api/store-snapshot';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { asArray, str, num, type JsonObject } from '@/types/json';
import type { HutangDoc } from '@/types/documents';

function pickStoreFields(src: Record<string, unknown> = {}) {
  return sanitizeStoreSettings({
    companyName: src.companyName || src.vendorTenantName || src.vendorName || '',
    companyAddress: src.companyAddress || src.address || '',
    companyPhone: src.companyPhone || src.phone || '',
    companyNPWP: src.companyNPWP || src.npwp || '',
    logoBase64: src.logoBase64 || src.vendorLogoBase64 || '',
    showLogoOnInvoice: src.showLogoOnInvoice !== false,
  });
}

async function fetchVendorProfileFromSales(config, vendorTenantId) {
  if (!config?.salesApiKey || !config?.salesAppUrl || !vendorTenantId) return null;
  const headers = { 'X-Api-Key': config.salesApiKey };
  const urls = [
    `${config.salesAppUrl}/api/integrations/vendor-profile?tenantId=${encodeURIComponent(vendorTenantId)}`,
    `${config.salesAppUrl}/api/integrations/vendor-store?tenantId=${encodeURIComponent(vendorTenantId)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data.profile || data.store || data.settings || data;
      const picked = pickStoreFields(raw as Record<string, unknown>);
      if (picked && (picked.companyName || picked.logoBase64)) return picked;
    } catch {
      /* try next */
    }
  }
  return null;
}

const VENDOR_PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;

export async function loadVendorBillingProfile(db: Db, customerTenantId, vendorTenantId) {
  const tid = customerTenantId || 'default';
  const vid = String(vendorTenantId || '').trim() || 'default';
  const config = await getIntegrationConfig(db, tid);

  const [vt, integ, supplier] = await Promise.all([
    db.collection('vendor_tenants').findOne({ tenantId: tid, vendorTenantId: vid }),
    db.collection('integration_settings').findOne({ tenantId: tid }),
    db.collection('supplier').findOne({ tenantId: tid, vendorTenantId: vid }),
  ]);

  let profile = {
    ...pickStoreFields({
      companyName: vt?.vendorTenantName || integ?.vendorName || supplier?.nama || `Vendor ${vid}`,
      companyAddress: vt?.companyAddress || integ?.vendorAddress || '',
      companyPhone: vt?.companyPhone || integ?.vendorPhone || '',
      companyNPWP: vt?.companyNPWP || integ?.vendorNPWP || '',
      logoBase64: vt?.logoBase64 || integ?.vendorLogoBase64 || '',
    }),
    vendorTenantId: vid,
  };

  const syncedAt = vt?.profileSyncedAt ? new Date(vt.profileSyncedAt).getTime() : 0;
  const cacheFresh = syncedAt > 0 && (Date.now() - syncedAt) < VENDOR_PROFILE_CACHE_MS;
  const remote = cacheFresh ? null : await fetchVendorProfileFromSales(config, vid);
  if (remote) {
    profile = { ...profile, ...remote, vendorTenantId: vid };
    await db.collection('vendor_tenants').updateOne(
      { tenantId: tid, vendorTenantId: vid },
      {
        $set: {
          vendorTenantName: remote.companyName || profile.companyName,
          companyAddress: remote.companyAddress || profile.companyAddress,
          companyPhone: remote.companyPhone || profile.companyPhone,
          companyNPWP: remote.companyNPWP || profile.companyNPWP,
          logoBase64: remote.logoBase64 || profile.logoBase64,
          profileSyncedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }

  return {
    ...profile,
    vendorTenantId: vid,
    source: remote ? 'sales.app' : (vt?.profileSyncedAt ? 'cache' : (vt?.logoBase64 ? 'cache' : 'local')),
  };
}

export async function loadCustomerBillingProfile(db: Db, customerTenantId: string) {
  const snap = await loadStoreSnapshot(db, customerTenantId);
  return {
    ...snap,
    tenantId: customerTenantId || 'default',
  };
}

export async function enrichInvoiceItems(db: Db, customerTenantId: string, hutang: HutangDoc) {
  const tid = customerTenantId || hutang.tenantId || 'default';
  const items = (hutang.items || []) as JsonObject[];
  if (!items.length) return [];

  let grn: JsonObject | null = null;
  let po: JsonObject | null = null;
  if (hutang.noDO) {
    grn = await db.collection('goods_receipts').findOne({ tenantId: tid, noDO: hutang.noDO, status: 'POSTED' }) as JsonObject | null
      || await db.collection('goods_receipts').findOne({ tenantId: tid, noDO: hutang.noDO }) as JsonObject | null;
  }
  if (hutang.noPO) {
    po = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO: hutang.noPO }) as JsonObject | null;
  }

  const grnByKode = new Map<string, JsonObject>();
  for (const it of asArray(grn?.items) as JsonObject[]) {
    const keys = [it.vendorKode, it.localKode, it.kode].filter(Boolean).map(String);
    for (const k of keys) grnByKode.set(k, it);
  }
  const poByKode = new Map<string, JsonObject>();
  for (const it of asArray(po?.items) as JsonObject[]) {
    const keys = [it.vendorKode, it.kode].filter(Boolean).map(String);
    for (const k of keys) poByKode.set(k, it);
  }

  const kodes = [...new Set(items.map((it) => str(it.kode)).filter(Boolean))];
  const products = kodes.length
    ? await db.collection('products').find({ tenantId: tid, kode: { $in: kodes } }).toArray()
    : [];
  const prodByKode = Object.fromEntries(products.map((p) => [p.kode, p]));

  return items.map((it, idx) => {
    const kode = str(it.kode);
    const grnLine = grnByKode.get(kode);
    const poLine = poByKode.get(kode);
    const prod = prodByKode[kode] as JsonObject | undefined;
    const qty = num(it.qty);
    const harga = parseInt(str(it.harga), 10) || 0;
    const diskon = parseInt(str(it.diskon), 10) || 0;
    const jumlah = parseInt(str(it.jumlah), 10) || Math.max(0, Math.round(qty * harga - diskon));

    return {
      lineNo: idx + 1,
      kode,
      nama: it.nama || it.vendorNama || grnLine?.vendorNama || grnLine?.localNama || poLine?.nama || prod?.nama || '—',
      satuan: it.satuan || grnLine?.satuan || poLine?.satuan || prod?.satuan || '—',
      qty,
      harga,
      diskon,
      jumlah,
    };
  });
}

export async function buildHutangDetailEnrichment(db: Db, hutang) {
  const tid = hutang.tenantId || 'default';
  const vendorTenantId = hutang.vendorTenantId || hutang.vendorBillingSnapshot?.vendorTenantId;

  const snap = hutang.vendorBillingSnapshot;
  let vendorBilling;
  if (snap?.companyName && snap?.logoBase64) {
    vendorBilling = { ...snap, vendorTenantId, source: 'snapshot' };
  } else {
    const loaded = await loadVendorBillingProfile(db, tid, vendorTenantId);
    vendorBilling = {
      ...loaded,
      companyName: snap?.companyName || loaded.companyName,
      companyAddress: snap?.companyAddress || loaded.companyAddress,
      companyPhone: snap?.companyPhone || loaded.companyPhone,
      companyNPWP: snap?.companyNPWP || loaded.companyNPWP,
      logoBase64: snap?.logoBase64 || loaded.logoBase64,
      source: snap?.companyName ? 'snapshot+enrich' : loaded.source,
    };
  }

  const [customerBilling, itemsFull] = await Promise.all([
    loadCustomerBillingProfile(db, tid),
    enrichInvoiceItems(db, tid, hutang),
  ]);

  const itemsSubTotal = itemsFull.reduce((s, it) => s + (it.jumlah || 0), 0);

  return {
    vendorBilling,
    customerBilling,
    itemsFull,
    totals: {
      itemsSubTotal,
      subTotal: hutang.subTotal || itemsSubTotal,
      ppn: hutang.ppn || 0,
      total: hutang.total || 0,
      penyesuaian: Math.max(0, (hutang.total || 0) - (hutang.subTotal || itemsSubTotal) - (hutang.ppn || 0)),
    },
  };
}

export function vendorBillingFromPayload(payload, vendorTenantId) {
  const nested = payload.vendor || payload.vendorStore || {};
  return pickStoreFields({
    vendorTenantId: vendorTenantId || payload.vendorTenantId || null,
    companyName: nested.companyName || payload.vendorCompanyName || payload.vendorName || '',
    companyAddress: nested.companyAddress || payload.vendorAddress || '',
    companyPhone: nested.companyPhone || payload.vendorPhone || '',
    companyNPWP: nested.companyNPWP || payload.vendorNPWP || '',
    logoBase64: nested.logoBase64 || payload.vendorLogoBase64 || '',
  });
}
