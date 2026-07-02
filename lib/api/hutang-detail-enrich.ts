import type { Db } from 'mongodb';
// Enrichment detail tagihan vendor — profil penagih & baris item lengkap.

import { resolveSalesApiAccess, findLinkForVendorCustomer } from '@/lib/api/integration-links';
import { loadStoreSnapshot } from '@/lib/api/store-snapshot';
import { logoUrlFromSettings, storeBase64Image } from '@/lib/api/media-storage';
import { sanitizeStoreSettings } from '@/lib/receipt-doc';
import { asArray, str, num, type JsonObject } from '@/types/json';
import type { HutangDoc } from '@/types/documents';

export type VendorBillingSnapshot = {
  vendorTenantId: string | null;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyNPWP: string;
  logoUrl: string;
  logoBase64: string;
  showLogoOnInvoice?: boolean;
};

function pickStoreFields(src: Record<string, unknown> = {}): VendorBillingSnapshot {
  const picked = sanitizeStoreSettings({
    companyName: src.companyName || src.vendorTenantName || src.vendorName || '',
    companyAddress: src.companyAddress || src.address || '',
    companyPhone: src.companyPhone || src.phone || '',
    companyNPWP: src.companyNPWP || src.npwp || '',
    logoBase64: src.logoBase64 || src.vendorLogoBase64 || '',
    logoUrl: src.logoUrl || src.vendorLogoUrl || '',
    showLogoOnInvoice: src.showLogoOnInvoice !== false,
  });
  return {
    vendorTenantId: src.vendorTenantId != null ? String(src.vendorTenantId) : null,
    companyName: String(picked?.companyName || ''),
    companyAddress: String(picked?.companyAddress || ''),
    companyPhone: String(picked?.companyPhone || ''),
    companyNPWP: String(picked?.companyNPWP || ''),
    logoBase64: String(picked?.logoBase64 || ''),
    logoUrl: String(picked?.logoUrl || ''),
    showLogoOnInvoice: src.showLogoOnInvoice !== false,
  };
}

/** Simpan profil vendor tanpa base64 — logo via URL saja. */
export function normalizeVendorBillingForStorage(src: Record<string, unknown> = {}): VendorBillingSnapshot {
  const picked = pickStoreFields(src);
  const rawLogo = String(picked.logoUrl || picked.logoBase64 || src.vendorLogoUrl || '').trim();
  const logoUrl = rawLogo.startsWith('data:')
    ? ''
    : (rawLogo.startsWith('http') || rawLogo.startsWith('/api/media') ? rawLogo : String(picked.logoUrl || ''));
  return {
    ...picked,
    vendorTenantId: src.vendorTenantId != null ? String(src.vendorTenantId) : picked.vendorTenantId,
    logoUrl: logoUrl || logoUrlFromSettings(picked),
    logoBase64: '',
  };
}

/** Upload base64 ke media storage bila perlu, lalu normalisasi snapshot. */
export async function resolveVendorBillingForStorage(
  db: Db,
  tenantId: string,
  vendorTenantId: string | null | undefined,
  src: Record<string, unknown> = {},
): Promise<VendorBillingSnapshot> {
  const picked = pickStoreFields(src);
  const rawLogo = String(picked.logoUrl || picked.logoBase64 || src.vendorLogoUrl || '').trim();
  let logoUrl = rawLogo.startsWith('data:') ? '' : rawLogo;

  if (rawLogo.startsWith('data:')) {
    const storageTenant = String(vendorTenantId || tenantId || 'default');
    const stored = await storeBase64Image(storageTenant, rawLogo, { prefix: 'vendor-logo' });
    if (!('error' in stored)) logoUrl = stored.url;
  }

  return normalizeVendorBillingForStorage({
    ...src,
    logoUrl,
    logoBase64: '',
  });
}

async function fetchVendorProfileFromSales(salesAppUrl: string, salesApiKey: string, vendorTenantId: string) {
  if (!salesApiKey || !salesAppUrl || !vendorTenantId) return null;
  const headers = { 'X-Api-Key': salesApiKey };
  const urls = [
    `${salesAppUrl}/api/integrations/vendor-profile?tenantId=${encodeURIComponent(vendorTenantId)}`,
    `${salesAppUrl}/api/integrations/vendor-store?tenantId=${encodeURIComponent(vendorTenantId)}`,
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
  const link = vid !== 'default' ? await findLinkForVendorCustomer(db, tid, vid) : null;

  const [vt, supplier] = await Promise.all([
    db.collection('vendor_tenants').findOne({ tenantId: tid, vendorTenantId: vid }),
    db.collection('supplier').findOne({ tenantId: tid, vendorTenantId: vid }),
  ]);

  let profile = {
    ...pickStoreFields({
      companyName: vt?.vendorTenantName || link?.vendorName || `Vendor ${vid}`,
      companyAddress: vt?.companyAddress || '',
      companyPhone: vt?.companyPhone || '',
      companyNPWP: vt?.companyNPWP || '',
      logoBase64: vt?.logoUrl || vt?.logoBase64 || '',
      logoUrl: vt?.logoUrl || '',
    }),
    vendorTenantId: vid,
  };

  const syncedAt = vt?.profileSyncedAt ? new Date(vt.profileSyncedAt).getTime() : 0;
  const cacheFresh = syncedAt > 0 && (Date.now() - syncedAt) < VENDOR_PROFILE_CACHE_MS;
  const access = cacheFresh ? null : await resolveSalesApiAccess(db, tid, vid !== 'default' ? vid : undefined);
  const remote = cacheFresh || !access
    ? null
    : await fetchVendorProfileFromSales(access.salesAppUrl, access.salesApiKey, vid);
  if (remote) {
    const normalized = await resolveVendorBillingForStorage(db, tid, vid, remote as Record<string, unknown>);
    profile = { ...profile, ...normalized, vendorTenantId: vid };
    await db.collection('vendor_tenants').updateOne(
      { tenantId: tid, vendorTenantId: vid },
      {
        $set: {
          vendorTenantName: normalized.companyName || profile.companyName,
          companyAddress: normalized.companyAddress || profile.companyAddress,
          companyPhone: normalized.companyPhone || profile.companyPhone,
          companyNPWP: normalized.companyNPWP || profile.companyNPWP,
          logoUrl: normalized.logoUrl || '',
          logoBase64: '',
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
    logoBase64: logoUrlFromSettings(profile),
    vendorTenantId: vid,
    source: remote ? 'sales.app' : (vt?.profileSyncedAt ? 'cache' : (vt?.logoUrl || vt?.logoBase64 ? 'cache' : 'local')),
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
  const vendorId = String(hutang.vendorTenantId || grn?.vendorTenantId || '').trim();
  const productFilter: Record<string, unknown> = { tenantId: tid, kode: { $in: kodes } };
  if (vendorId) productFilter.vendorTenantId = vendorId;
  const products = kodes.length
    ? await db.collection('products').find(productFilter).toArray()
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
  const snapLogo = logoUrlFromSettings(snap);
  if (snap?.companyName) {
    vendorBilling = {
      ...snap,
      logoBase64: snapLogo,
      logoUrl: snap?.logoUrl || snapLogo,
      vendorTenantId,
      source: 'snapshot',
    };
  } else {
    const loaded = await loadVendorBillingProfile(db, tid, vendorTenantId);
    const mergedLogo = logoUrlFromSettings(snap) || logoUrlFromSettings(loaded) || loaded.logoBase64;
    vendorBilling = {
      ...loaded,
      companyName: snap?.companyName || loaded.companyName,
      companyAddress: snap?.companyAddress || loaded.companyAddress,
      companyPhone: snap?.companyPhone || loaded.companyPhone,
      companyNPWP: snap?.companyNPWP || loaded.companyNPWP,
      logoUrl: snap?.logoUrl || loaded.logoUrl || mergedLogo,
      logoBase64: mergedLogo,
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
  return normalizeVendorBillingForStorage({
    vendorTenantId: vendorTenantId || payload.vendorTenantId || null,
    companyName: nested.companyName || payload.vendorCompanyName || payload.vendorName || '',
    companyAddress: nested.companyAddress || payload.vendorAddress || '',
    companyPhone: nested.companyPhone || payload.vendorPhone || '',
    companyNPWP: nested.companyNPWP || payload.vendorNPWP || '',
    logoBase64: nested.logoBase64 || payload.vendorLogoBase64 || '',
    logoUrl: nested.logoUrl || payload.vendorLogoUrl || '',
  });
}
