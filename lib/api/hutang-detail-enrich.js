// Enrichment detail tagihan vendor — profil penagih & baris item lengkap.

import { getIntegrationConfig } from '@/lib/api/integration-config';
import { loadStoreSnapshot } from '@/lib/api/store-snapshot';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';

function pickStoreFields(src = {}) {
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
      const picked = pickStoreFields(raw);
      if (picked.companyName || picked.logoBase64) return picked;
    } catch {
      /* try next */
    }
  }
  return null;
}

export async function loadVendorBillingProfile(db, customerTenantId, vendorTenantId) {
  const tid = customerTenantId || 'default';
  const vid = String(vendorTenantId || '').trim() || 'default';
  const config = await getIntegrationConfig(db, tid);

  const [vt, integ, supplier] = await Promise.all([
    db.collection('vendor_tenants').findOne({ tenantId: tid, vendorTenantId: vid }),
    db.collection('integration_settings').findOne({ tenantId: tid }),
    db.collection('supplier').findOne({ tenantId: tid, vendorTenantId: vid }),
  ]);

  let profile = pickStoreFields({
    companyName: vt?.vendorTenantName || integ?.vendorName || supplier?.nama || `Vendor ${vid}`,
    companyAddress: vt?.companyAddress || integ?.vendorAddress || '',
    companyPhone: vt?.companyPhone || integ?.vendorPhone || '',
    companyNPWP: vt?.companyNPWP || integ?.vendorNPWP || '',
    logoBase64: vt?.logoBase64 || integ?.vendorLogoBase64 || '',
    vendorTenantId: vid,
  });

  const remote = await fetchVendorProfileFromSales(config, vid);
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
    vendorTenantId: vid,
    ...profile,
    source: remote ? 'sales.app' : (vt?.logoBase64 ? 'cache' : 'local'),
  };
}

export async function loadCustomerBillingProfile(db, customerTenantId) {
  const snap = await loadStoreSnapshot(db, customerTenantId);
  return {
    tenantId: customerTenantId || 'default',
    ...snap,
  };
}

export async function enrichInvoiceItems(db, customerTenantId, hutang) {
  const tid = customerTenantId || hutang.tenantId || 'default';
  const items = hutang.items || [];
  if (!items.length) return [];

  let grn = null;
  let po = null;
  if (hutang.noDO) {
    grn = await db.collection('goods_receipts').findOne({ tenantId: tid, noDO: hutang.noDO, status: 'POSTED' })
      || await db.collection('goods_receipts').findOne({ tenantId: tid, noDO: hutang.noDO });
  }
  if (hutang.noPO) {
    po = await db.collection('customer_purchase_orders').findOne({ tenantId: tid, noPO: hutang.noPO });
  }

  const grnByKode = new Map();
  for (const it of grn?.items || []) {
    const keys = [it.vendorKode, it.localKode, it.kode].filter(Boolean);
    for (const k of keys) grnByKode.set(k, it);
  }
  const poByKode = new Map();
  for (const it of po?.items || []) {
    const keys = [it.vendorKode, it.kode].filter(Boolean);
    for (const k of keys) poByKode.set(k, it);
  }

  const kodes = [...new Set(items.map((it) => it.kode).filter(Boolean))];
  const products = kodes.length
    ? await db.collection('products').find({ tenantId: tid, kode: { $in: kodes } }).toArray()
    : [];
  const prodByKode = Object.fromEntries(products.map((p) => [p.kode, p]));

  return items.map((it, idx) => {
    const kode = it.kode || '';
    const grnLine = grnByKode.get(kode);
    const poLine = poByKode.get(kode);
    const prod = prodByKode[kode];
    const qty = parseFloat(it.qty) || 0;
    const harga = parseInt(it.harga || 0, 10);
    const diskon = parseInt(it.diskon || 0, 10);
    const jumlah = parseInt(it.jumlah || 0, 10) || Math.max(0, Math.round(qty * harga - diskon));

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

export async function buildHutangDetailEnrichment(db, hutang) {
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
