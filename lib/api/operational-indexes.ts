// Index operasional — inventory customer collections only.

import type { Db } from 'mongodb';

let operationalIndexesEnsured = false;

interface IndexSpec {
  collection: string;
  index: Record<string, number>;
  name: string;
  unique?: boolean;
}

const INDEX_SPECS: IndexSpec[] = [
  { collection: 'jurnal', index: { tenantId: 1, tanggal: -1 }, name: 'idx_jurnal_tenant_tanggal' },
  { collection: 'stok_kartu', index: { tenantId: 1, stokId: 1, tanggal: 1 }, name: 'idx_stok_kartu_tenant_stok_tgl' },
  { collection: 'stok_lokasi', index: { tenantId: 1, stokId: 1, lokasiKode: 1 }, name: 'idx_stok_lokasi_tenant_stok_gudang' },
  { collection: 'penyesuaian_stok', index: { tenantId: 1, tanggal: -1 }, name: 'idx_penyesuaian_tenant_tanggal' },
  { collection: 'hutang', index: { tenantId: 1, supplierId: 1, status: 1 }, name: 'idx_hutang_tenant_supplier' },
  { collection: 'hutang', index: { tenantId: 1, vendorInvoiceId: 1 }, name: 'idx_hutang_vendor_invoice' },
  { collection: 'hutang', index: { tenantId: 1, approvalStatus: 1, approvedAt: -1 }, name: 'idx_hutang_tenant_approval_at' },
  { collection: 'hutang', index: { tenantId: 1, noPO: 1 }, name: 'idx_hutang_tenant_nopo' },
  { collection: 'hutang', index: { tenantId: 1, noDO: 1 }, name: 'idx_hutang_tenant_nodo' },
  { collection: 'hutang', index: { tenantId: 1, referenceType: 1, approvalStatus: 1 }, name: 'idx_hutang_tenant_ref_approval' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_cpo_tenant_tanggal' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, noPO: 1 }, name: 'idx_cpo_tenant_nopo' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, poChannel: 1, status: 1 }, name: 'idx_cpo_tenant_channel_status' },
  { collection: 'local_purchase_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_lpo_tenant_tanggal' },
  { collection: 'local_purchase_orders', index: { tenantId: 1, noPO: 1 }, name: 'idx_lpo_tenant_nopo', unique: true },
  { collection: 'local_purchase_orders', index: { tenantId: 1, status: 1 }, name: 'idx_lpo_tenant_status' },
  { collection: 'assets', index: { tenantId: 1, kode: 1 }, name: 'uniq_assets_tenant_kode', unique: true },
  { collection: 'assets', index: { tenantId: 1, status: 1 }, name: 'idx_assets_tenant_status' },
  { collection: 'assets', index: { tenantId: 1, nama: 1 }, name: 'idx_assets_tenant_nama' },
  { collection: 'maintenance_requests', index: { tenantId: 1, createdAt: -1 }, name: 'idx_mwr_tenant_created' },
  { collection: 'maintenance_requests', index: { tenantId: 1, noWR: 1 }, name: 'uniq_mwr_tenant_nowr', unique: true },
  { collection: 'maintenance_requests', index: { tenantId: 1, status: 1 }, name: 'idx_mwr_tenant_status' },
  { collection: 'maintenance_requests', index: { tenantId: 1, assetId: 1 }, name: 'idx_mwr_tenant_asset' },
  { collection: 'maintenance_service_orders', index: { tenantId: 1, createdAt: -1 }, name: 'idx_mso_tenant_created' },
  { collection: 'maintenance_service_orders', index: { tenantId: 1, noMSO: 1 }, name: 'uniq_mso_tenant_nomso', unique: true },
  { collection: 'maintenance_service_orders', index: { tenantId: 1, maintenanceRequestId: 1 }, name: 'idx_mso_tenant_wr' },
  { collection: 'maintenance_schedules', index: { tenantId: 1, status: 1, nextDueDate: 1 }, name: 'idx_pms_tenant_status_due' },
  { collection: 'maintenance_schedules', index: { tenantId: 1, noPM: 1 }, name: 'uniq_pms_tenant_nopm', unique: true },
  { collection: 'maintenance_schedules', index: { tenantId: 1, assetId: 1 }, name: 'idx_pms_tenant_asset' },
  { collection: 'maintenance_requests', index: { tenantId: 1, scheduleId: 1 }, name: 'idx_mwr_tenant_schedule' },
  { collection: 'procurement_expenses', index: { tenantId: 1, tanggal: -1 }, name: 'idx_proc_exp_tenant_tanggal' },
  { collection: 'inventory_releases', index: { tenantId: 1, tanggal: -1 }, name: 'idx_inv_release_tenant_tanggal' },
  { collection: 'api_keys', index: { keyHash: 1 }, name: 'uniq_api_key_hash', unique: true },
  { collection: 'webhook_subscriptions', index: { tenantId: 1, event: 1 }, name: 'idx_webhook_tenant_event' },
  { collection: 'document_sequences', index: { tenantId: 1, docType: 1 }, name: 'uniq_doc_sequence', unique: true },
  { collection: 'goods_receipts', index: { tenantId: 1, tanggal: -1 }, name: 'idx_grn_tenant_tanggal' },
  { collection: 'goods_receipts', index: { tenantId: 1, status: 1 }, name: 'idx_grn_tenant_status' },
  { collection: 'goods_receipts', index: { tenantId: 1, noDO: 1 }, name: 'idx_grn_tenant_nodo' },
  { collection: 'goods_receipts', index: { tenantId: 1, vendorDeliveryId: 1 }, name: 'idx_grn_tenant_delivery' },
  { collection: 'goods_receipts', index: { tenantId: 1, status: 1, 'items.vendorKode': 1 }, name: 'idx_grn_tenant_status_kode' },
  { collection: 'bg_jobs', index: { status: 1, createdAt: 1 }, name: 'idx_bg_jobs_status_created' },
  { collection: 'bg_jobs', index: { grnId: 1, type: 1 }, name: 'idx_bg_jobs_grn_type' },
  { collection: 'webhook_inbox', index: { dedupeKey: 1 }, name: 'uniq_webhook_dedupe', unique: true },
  { collection: 'audit_log', index: { tenantId: 1, createdAt: -1 }, name: 'idx_audit_tenant_created' },
  { collection: 'audit_log', index: { entityType: 1, entityId: 1 }, name: 'idx_audit_entity' },
  { collection: 'products', index: { tenantId: 1, kode: 1 }, name: 'uniq_products_tenant_kode', unique: true },
  { collection: 'products', index: { tenantId: 1, barcode: 1 }, name: 'idx_products_tenant_barcode' },
  { collection: 'products', index: { tenantId: 1, id: 1 }, name: 'idx_products_tenant_id' },
  { collection: 'vendor_tenants', index: { tenantId: 1, vendorTenantId: 1 }, name: 'uniq_vendor_tenants', unique: true },
  { collection: 'users', index: { email: 1 }, name: 'uniq_users_email', unique: true },
  { collection: 'tenant_settings', index: { tenantId: 1 }, name: 'uniq_tenant_settings', unique: true },
  { collection: 'produk_grup', index: { tenantId: 1, nama: 1 }, name: 'uniq_produk_grup', unique: true },
  { collection: 'produk_satuan', index: { tenantId: 1, nama: 1 }, name: 'uniq_produk_satuan', unique: true },
];

async function safeCreateIndex(
  db: Db,
  collection: string,
  index: Record<string, number>,
  options: Record<string, unknown>,
) {
  try {
    await db.collection(collection).createIndex(index, options);
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err?.code !== 85 && err?.code !== 86) {
      console.warn(`Index ${options.name}:`, err.message);
    }
  }
}

export async function ensureOperationalIndexes(db: Db): Promise<void> {
  if (operationalIndexesEnsured) return;
  for (const spec of INDEX_SPECS) {
    const opts: Record<string, unknown> = { name: spec.name };
    if (spec.unique) opts.unique = true;
    await safeCreateIndex(db, spec.collection, spec.index, opts);
  }
  operationalIndexesEnsured = true;
}
