// Index operasional — inventory customer collections only.

import type { Db, IndexSpecification } from 'mongodb';
import { FP_OPEN_DOC_STATUSES } from '@/lib/food-production/document';

const FP_OPEN_STATUS_FILTER = {
  status: { $in: [...FP_OPEN_DOC_STATUSES] },
};

let operationalIndexesEnsured = false;
let operationalIndexesInFlight: Promise<void> | null = null;

interface IndexSpec {
  collection: string;
  index: Record<string, number | string>;
  name: string;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
}

const INDEX_SPECS: IndexSpec[] = [
  { collection: 'jurnal', index: { tenantId: 1, tanggal: -1 }, name: 'idx_jurnal_tenant_tanggal' },
  { collection: 'jurnal', index: { tenantId: 1, noJurnal: 1 }, name: 'uniq_jurnal_tenant_no', unique: true },
  { collection: 'stok_kartu', index: { tenantId: 1, stokId: 1, tanggal: 1 }, name: 'idx_stok_kartu_tenant_stok_tgl' },
  { collection: 'stok_kartu', index: { tenantId: 1, tanggal: 1 }, name: 'idx_stok_kartu_tenant_tanggal' },
  { collection: 'stok_lokasi', index: { tenantId: 1, stokId: 1, lokasiKode: 1 }, name: 'idx_stok_lokasi_tenant_stok_gudang' },
  { collection: 'penyesuaian_stok', index: { tenantId: 1, tanggal: -1 }, name: 'idx_penyesuaian_tenant_tanggal' },
  { collection: 'penyesuaian_stok', index: { tenantId: 1, noPenyesuaian: 1 }, name: 'uniq_penyesuaian_tenant_no', unique: true },
  { collection: 'hutang', index: { tenantId: 1, supplierId: 1, status: 1 }, name: 'idx_hutang_tenant_supplier' },
  { collection: 'hutang', index: { tenantId: 1, noHutang: 1 }, name: 'uniq_hutang_tenant_no', unique: true },
  { collection: 'hutang', index: { tenantId: 1, vendorInvoiceId: 1 }, name: 'idx_hutang_vendor_invoice' },
  { collection: 'hutang', index: { tenantId: 1, approvalStatus: 1, approvedAt: -1 }, name: 'idx_hutang_tenant_approval_at' },
  { collection: 'hutang', index: { tenantId: 1, noPO: 1 }, name: 'idx_hutang_tenant_nopo' },
  { collection: 'hutang', index: { tenantId: 1, noDO: 1 }, name: 'idx_hutang_tenant_nodo' },
  { collection: 'hutang', index: { tenantId: 1, referenceType: 1, approvalStatus: 1 }, name: 'idx_hutang_tenant_ref_approval' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_cpo_tenant_tanggal' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, noPO: 1 }, name: 'idx_cpo_tenant_nopo' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, vendorSoId: 1 }, name: 'idx_cpo_tenant_vendor_so' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, vendorNoSO: 1 }, name: 'idx_cpo_tenant_vendor_noso' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, maintenanceRequestId: 1 }, name: 'idx_cpo_tenant_mwr' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, poChannel: 1, status: 1 }, name: 'idx_cpo_tenant_channel_status' },
  { collection: 'local_purchase_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_lpo_tenant_tanggal' },
  { collection: 'local_purchase_orders', index: { tenantId: 1, noPO: 1 }, name: 'idx_lpo_tenant_nopo', unique: true },
  { collection: 'local_purchase_orders', index: { tenantId: 1, status: 1 }, name: 'idx_lpo_tenant_status' },
  { collection: 'assets', index: { tenantId: 1, kode: 1 }, name: 'uniq_assets_tenant_kode', unique: true },
  { collection: 'assets', index: { tenantId: 1, status: 1 }, name: 'idx_assets_tenant_status' },
  { collection: 'assets', index: { tenantId: 1, nama: 1 }, name: 'idx_assets_tenant_nama' },
  { collection: 'maintenance_requests', index: { tenantId: 1, createdAt: -1, id: -1 }, name: 'idx_mwr_tenant_created_id' },
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
  { collection: 'inventory_releases', index: { tenantId: 1, noRelease: 1 }, name: 'uniq_inv_release_tenant_no', unique: true },
  { collection: 'api_keys', index: { keyHash: 1 }, name: 'uniq_api_key_hash', unique: true },
  { collection: 'webhook_subscriptions', index: { tenantId: 1, event: 1 }, name: 'idx_webhook_tenant_event' },
  { collection: 'document_sequences', index: { tenantId: 1, docType: 1 }, name: 'uniq_doc_sequence', unique: true },
  { collection: 'goods_receipts', index: { tenantId: 1, tanggal: -1 }, name: 'idx_grn_tenant_tanggal' },
  { collection: 'goods_receipts', index: { tenantId: 1, status: 1 }, name: 'idx_grn_tenant_status' },
  { collection: 'goods_receipts', index: { tenantId: 1, noDO: 1 }, name: 'idx_grn_tenant_nodo' },
  { collection: 'goods_receipts', index: { tenantId: 1, noGRN: 1 }, name: 'uniq_grn_tenant_no', unique: true },
  { collection: 'goods_receipts', index: { tenantId: 1, noPO: 1, postedAt: -1 }, name: 'idx_grn_tenant_nopo_posted' },
  {
    collection: 'goods_receipts',
    index: { tenantId: 1, vendorDeliveryId: 1 },
    name: 'uniq_grn_tenant_vendor_delivery',
    unique: true,
    partialFilterExpression: { vendorDeliveryId: { $type: 'string', $gt: '' } },
  },
  { collection: 'goods_receipts', index: { tenantId: 1, status: 1, 'items.vendorKode': 1 }, name: 'idx_grn_tenant_status_kode' },
  {
    collection: 'goods_receipts',
    index: { correlationId: 1 },
    name: 'idx_grn_correlation',
    partialFilterExpression: { correlationId: { $type: 'string', $gt: '' } },
  },
  { collection: 'bg_jobs', index: { status: 1, createdAt: 1 }, name: 'idx_bg_jobs_status_created' },
  { collection: 'bg_jobs', index: { grnId: 1, type: 1 }, name: 'idx_bg_jobs_grn_type' },
  { collection: 'integration_commands', index: { correlationId: 1, startedAt: -1 }, name: 'idx_integration_commands_corr_started' },
  { collection: 'integration_commands', index: { commandType: 1, status: 1, startedAt: -1 }, name: 'idx_integration_commands_type_status' },
  { collection: 'integration_commands', index: { grnId: 1, startedAt: -1 }, name: 'idx_integration_commands_grn' },
  { collection: 'integration_commands', index: { invoiceId: 1, startedAt: -1 }, name: 'idx_integration_commands_invoice' },
  { collection: 'integration_commands', index: { apId: 1, startedAt: -1 }, name: 'idx_integration_commands_ap' },
  { collection: 'integration_commands', index: { id: 1 }, name: 'uniq_integration_commands_id', unique: true },
  {
    collection: 'hutang',
    index: { correlationId: 1 },
    name: 'idx_hutang_correlation',
    partialFilterExpression: { correlationId: { $type: 'string', $gt: '' } },
  },
  {
    collection: 'customer_purchase_orders',
    index: { correlationId: 1 },
    name: 'idx_cpo_correlation',
    partialFilterExpression: { correlationId: { $type: 'string', $gt: '' } },
  },
  {
    collection: 'integration_outbox',
    index: { type: 1, aggregateId: 1 },
    name: 'uniq_integration_outbox_type_aggregate',
    unique: true,
  },
  {
    collection: 'integration_outbox',
    index: { status: 1, updatedAt: 1 },
    name: 'idx_integration_outbox_status_updated',
  },
  {
    collection: 'integration_outbox',
    index: { tenantId: 1, type: 1, status: 1 },
    name: 'idx_integration_outbox_tenant_type_status',
  },
  { collection: 'webhook_inbox', index: { dedupeKey: 1 }, name: 'uniq_webhook_dedupe', unique: true },
  { collection: 'audit_log', index: { tenantId: 1, createdAt: -1 }, name: 'idx_audit_tenant_created' },
  { collection: 'audit_log', index: { entityType: 1, entityId: 1 }, name: 'idx_audit_entity' },
  { collection: 'products', index: { tenantId: 1, vendorTenantId: 1, kode: 1 }, name: 'uniq_products_tenant_vendor_kode', unique: true, partialFilterExpression: { syncSource: 'sales.app' } },
  { collection: 'products', index: { tenantId: 1, vendorTenantId: 1, vendorStokId: 1 }, name: 'uniq_products_tenant_vendor_stok', unique: true, partialFilterExpression: { syncSource: 'sales.app', vendorStokId: { $exists: true, $type: 'string' } } },
  { collection: 'products', index: { tenantId: 1, kode: 1 }, name: 'uniq_products_tenant_local_kode', unique: true, partialFilterExpression: { syncSource: 'local' } },
  { collection: 'products', index: { tenantId: 1, barcode: 1 }, name: 'idx_products_tenant_barcode' },
  { collection: 'products', index: { tenantId: 1, id: 1 }, name: 'idx_products_tenant_id' },
  { collection: 'products', index: { tenantId: 1, nama: 1, id: 1 }, name: 'idx_products_tenant_nama_id' },
  { collection: 'products', index: { tenantId: 1, itemRole: 1 }, name: 'idx_products_tenant_item_role' },
  { collection: 'kitchens', index: { tenantId: 1, nama: 1 }, name: 'idx_kitchens_tenant_nama' },
  { collection: 'kitchens', index: { tenantId: 1, id: 1 }, name: 'idx_kitchens_tenant_id' },
  { collection: 'recipes', index: { tenantId: 1, nama: 1 }, name: 'idx_recipes_tenant_nama' },
  { collection: 'recipes', index: { tenantId: 1, id: 1 }, name: 'idx_recipes_tenant_id' },
  { collection: 'recipes', index: { tenantId: 1, kode: 1, version: 1 }, name: 'uniq_recipes_tenant_kode_ver', unique: true },
  { collection: 'menus', index: { tenantId: 1, nama: 1 }, name: 'idx_menus_tenant_nama' },
  { collection: 'menus', index: { tenantId: 1, id: 1 }, name: 'idx_menus_tenant_id' },
  { collection: 'menus', index: { tenantId: 1, kode: 1, version: 1 }, name: 'uniq_menus_tenant_kode_ver', unique: true },
  { collection: 'production_plans', index: { tenantId: 1, id: 1 }, name: 'idx_fp_plans_tenant_id' },
  { collection: 'production_plans', index: { tenantId: 1, tanggal: -1 }, name: 'idx_fp_plans_tenant_tanggal' },
  { collection: 'production_plans', index: { tenantId: 1, status: 1, tanggal: -1 }, name: 'idx_fp_plans_tenant_status_tanggal' },
  { collection: 'production_plans', index: { tenantId: 1, kitchenId: 1, tanggal: -1 }, name: 'idx_fp_plans_tenant_kitchen_tanggal' },
  { collection: 'production_plans', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_fp_plans_tenant_no', unique: true },
  { collection: 'material_requirements', index: { tenantId: 1, id: 1 }, name: 'idx_mrp_tenant_id' },
  { collection: 'material_requirements', index: { tenantId: 1, productionPlanId: 1, createdAt: -1 }, name: 'idx_mrp_tenant_plan' },
  { collection: 'material_requirements', index: { tenantId: 1, tanggal: -1 }, name: 'idx_mrp_tenant_tanggal' },
  { collection: 'material_requirements', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_mrp_tenant_no', unique: true },
  { collection: 'purchase_requirements', index: { tenantId: 1, id: 1 }, name: 'idx_pr_tenant_id' },
  { collection: 'purchase_requirements', index: { tenantId: 1, materialRequirementId: 1, createdAt: -1 }, name: 'idx_pr_tenant_mrp' },
  { collection: 'purchase_requirements', index: { tenantId: 1, productionPlanId: 1, createdAt: -1 }, name: 'idx_pr_tenant_plan' },
  { collection: 'purchase_requirements', index: { tenantId: 1, tanggal: -1 }, name: 'idx_pr_tenant_tanggal' },
  { collection: 'purchase_requirements', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_pr_tenant_no', unique: true },
  {
    collection: 'purchase_requirements',
    index: { tenantId: 1, materialRequirementId: 1 },
    name: 'uniq_pr_tenant_mrp_open',
    unique: true,
    partialFilterExpression: FP_OPEN_STATUS_FILTER,
  },
  { collection: 'material_issues', index: { tenantId: 1, id: 1 }, name: 'idx_issue_tenant_id' },
  { collection: 'material_issues', index: { tenantId: 1, productionPlanId: 1, createdAt: -1 }, name: 'idx_issue_tenant_plan' },
  { collection: 'material_issues', index: { tenantId: 1, tanggal: -1 }, name: 'idx_issue_tenant_tanggal' },
  { collection: 'material_issues', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_issue_tenant_no', unique: true },
  {
    collection: 'material_issues',
    index: { tenantId: 1, productionPlanId: 1 },
    name: 'uniq_issue_tenant_plan_open',
    unique: true,
    partialFilterExpression: FP_OPEN_STATUS_FILTER,
  },
  { collection: 'production_results', index: { tenantId: 1, id: 1 }, name: 'idx_result_tenant_id' },
  { collection: 'production_results', index: { tenantId: 1, productionPlanId: 1, createdAt: -1 }, name: 'idx_result_tenant_plan' },
  { collection: 'production_results', index: { tenantId: 1, tanggal: -1 }, name: 'idx_result_tenant_tanggal' },
  { collection: 'production_results', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_result_tenant_no', unique: true },
  {
    collection: 'production_results',
    index: { tenantId: 1, productionPlanId: 1 },
    name: 'uniq_result_tenant_plan_open',
    unique: true,
    partialFilterExpression: FP_OPEN_STATUS_FILTER,
  },
  { collection: 'kitchen_transfers', index: { tenantId: 1, id: 1 }, name: 'idx_xfer_tenant_id' },
  { collection: 'kitchen_transfers', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_xfer_tenant_no', unique: true },
  { collection: 'kitchen_transfers', index: { tenantId: 1, fromKitchenId: 1, createdAt: -1 }, name: 'idx_xfer_tenant_from' },
  { collection: 'kitchen_transfers', index: { tenantId: 1, toKitchenId: 1, createdAt: -1 }, name: 'idx_xfer_tenant_to' },
  { collection: 'production_batches', index: { tenantId: 1, id: 1 }, name: 'idx_batch_tenant_id' },
  { collection: 'production_batches', index: { tenantId: 1, batchNo: 1 }, name: 'idx_batch_tenant_no' },
  { collection: 'production_batches', index: { tenantId: 1, expiryDate: 1 }, name: 'idx_batch_tenant_expiry' },
  { collection: 'production_batches', index: { tenantId: 1, kitchenId: 1, expiryDate: 1 }, name: 'idx_batch_tenant_kitchen_expiry' },
  // W2-1 FEFO allocate by product + warehouse + status + expiry
  {
    collection: 'production_batches',
    index: { tenantId: 1, finishedGoodProductId: 1, warehouseKode: 1, status: 1, expiryDate: 1 },
    name: 'idx_batch_fefo_product_wh',
  },
  { collection: 'fefo_batch_reconcile_reports', index: { tenantId: 1, createdAt: -1 }, name: 'idx_fefo_recon_tenant_created' },
  // W2-5 ingredient lots
  { collection: 'ingredient_lots', index: { tenantId: 1, id: 1 }, name: 'idx_ilot_tenant_id' },
  { collection: 'ingredient_lots', index: { tenantId: 1, grnId: 1 }, name: 'idx_ilot_tenant_grn' },
  { collection: 'ingredient_lots', index: { tenantId: 1, productId: 1, warehouseKode: 1, status: 1, expiryDate: 1 }, name: 'idx_ilot_fefo_product_wh' },
  { collection: 'ingredient_lots', index: { tenantId: 1, expiryDate: 1 }, name: 'idx_ilot_tenant_expiry' },
  { collection: 'ingredient_lot_reconcile_reports', index: { tenantId: 1, createdAt: -1 }, name: 'idx_ilot_recon_tenant_created' },
  // W2-16 warehouse bins (addressing; stock grain remains warehouse)
  {
    collection: 'warehouse_bins',
    index: { tenantId: 1, warehouseKode: 1, kode: 1 },
    name: 'uniq_wbin_tenant_wh_kode',
    unique: true,
  },
  { collection: 'warehouse_bins', index: { tenantId: 1, id: 1 }, name: 'idx_wbin_tenant_id' },
  {
    collection: 'warehouse_bins',
    index: { tenantId: 1, warehouseKode: 1, isDefault: 1, aktif: 1 },
    name: 'idx_wbin_tenant_wh_default',
  },
  {
    collection: 'ingredient_lots',
    index: { tenantId: 1, warehouseKode: 1, binKode: 1 },
    name: 'idx_ilot_tenant_wh_bin',
    partialFilterExpression: { binKode: { $type: 'string', $gt: '' } },
  },
  // W2-17 bin balance ledger
  {
    collection: 'stok_bin',
    index: { tenantId: 1, stokId: 1, warehouseKode: 1, binKode: 1 },
    name: 'uniq_stok_bin_tenant_stok_wh_bin',
    unique: true,
  },
  { collection: 'stok_bin', index: { tenantId: 1, warehouseKode: 1, binKode: 1 }, name: 'idx_stok_bin_tenant_wh_bin' },
  { collection: 'stok_bin', index: { tenantId: 1, stokId: 1, warehouseKode: 1 }, name: 'idx_stok_bin_tenant_stok_wh' },
  { collection: 'stok_bin_reconcile_reports', index: { tenantId: 1, createdAt: -1 }, name: 'idx_stok_bin_recon_tenant_created' },
  // W2-25 KA follow-up orphan reconcile reports
  {
    collection: 'ka_follow_up_orphan_reconcile_reports',
    index: { tenantId: 1, createdAt: -1 },
    name: 'idx_ka_fu_orphan_recon_tenant_created',
  },
  // W2-27 KA open-case missing FU reconcile reports
  {
    collection: 'ka_open_case_missing_fu_reconcile_reports',
    index: { tenantId: 1, createdAt: -1 },
    name: 'idx_ka_open_case_missing_fu_recon_tenant_created',
  },
  // W2-18 putaway moves (bin-to-bin ledger docs)
  { collection: 'putaway_moves', index: { tenantId: 1, id: 1 }, name: 'idx_putaway_tenant_id' },
  {
    collection: 'putaway_moves',
    index: { tenantId: 1, noPutaway: 1 },
    name: 'uniq_putaway_tenant_no',
    unique: true,
  },
  { collection: 'putaway_moves', index: { tenantId: 1, status: 1, tanggal: -1 }, name: 'idx_putaway_tenant_status_tanggal' },
  { collection: 'putaway_moves', index: { tenantId: 1, warehouseKode: 1, tanggal: -1 }, name: 'idx_putaway_tenant_wh_tanggal' },

  { collection: 'kitchens', index: { tenantId: 1, kode: 1 }, name: 'uniq_kitchen_tenant_kode', unique: true, partialFilterExpression: { kode: { $type: 'string', $gt: '' } } },
  { collection: 'kitchens', index: { tenantId: 1, kitchenType: 1 }, name: 'idx_kitchen_tenant_type' },
  { collection: 'service_points', index: { tenantId: 1, id: 1 }, name: 'idx_sp_tenant_id' },
  { collection: 'service_points', index: { tenantId: 1, nama: 1 }, name: 'idx_sp_tenant_nama' },
  { collection: 'service_points', index: { tenantId: 1, kode: 1 }, name: 'uniq_sp_tenant_kode', unique: true, partialFilterExpression: { kode: { $type: 'string', $gt: '' } } },
  { collection: 'service_points', index: { tenantId: 1, kitchenId: 1 }, name: 'idx_sp_tenant_kitchen' },
  { collection: 'service_points', index: { tenantId: 1, jamKirim: 1 }, name: 'idx_sp_tenant_jam_kirim' },
  { collection: 'armadas', index: { tenantId: 1, id: 1 }, name: 'idx_armada_tenant_id' },
  { collection: 'armadas', index: { tenantId: 1, kode: 1 }, name: 'uniq_armada_tenant_kode', unique: true, partialFilterExpression: { kode: { $type: 'string', $gt: '' } } },
  { collection: 'armadas', index: { tenantId: 1, kitchenId: 1, aktif: 1 }, name: 'idx_armada_tenant_kitchen_aktif' },
  { collection: 'distribution_orders', index: { tenantId: 1, id: 1 }, name: 'idx_dist_tenant_id' },
  {
    collection: 'distribution_orders',
    index: { tenantId: 1, noDokumen: 1 },
    name: 'uniq_dist_tenant_no',
    unique: true,
    /** Draft tanpa nomor DST — partial agar banyak null/kosong tidak bentrok. */
    partialFilterExpression: { noDokumen: { $type: 'string', $gt: '' } },
  },
  { collection: 'distribution_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_dist_tenant_tanggal' },
  { collection: 'distribution_orders', index: { tenantId: 1, kitchenId: 1, tanggal: -1 }, name: 'idx_dist_tenant_kitchen_tanggal' },
  { collection: 'distribution_orders', index: { tenantId: 1, productionPlanId: 1, createdAt: -1 }, name: 'idx_dist_tenant_plan' },
  { collection: 'distribution_orders', index: { tenantId: 1, productionResultId: 1, createdAt: -1 }, name: 'idx_dist_tenant_result' },
  { collection: 'distribution_orders', index: { tenantId: 1, status: 1, tanggal: -1 }, name: 'idx_dist_tenant_status_tanggal' },
  { collection: 'temperature_logs', index: { tenantId: 1, id: 1 }, name: 'idx_temp_log_tenant_id' },
  { collection: 'temperature_logs', index: { tenantId: 1, recordedAt: -1 }, name: 'idx_temp_log_tenant_recorded' },
  { collection: 'temperature_logs', index: { tenantId: 1, kitchenId: 1, recordedAt: -1 }, name: 'idx_temp_log_tenant_kitchen_recorded' },
  { collection: 'temperature_logs', index: { tenantId: 1, alertStatus: 1, recordedAt: -1 }, name: 'idx_temp_log_tenant_alert_recorded' },
  { collection: 'temperature_logs', index: { tenantId: 1, stage: 1, tanggal: -1 }, name: 'idx_temp_log_tenant_stage_tanggal' },
  { collection: 'temperature_logs', index: { tenantId: 1, productionPlanId: 1, recordedAt: -1 }, name: 'idx_temp_log_tenant_plan' },
  { collection: 'temperature_thresholds', index: { tenantId: 1, id: 1 }, name: 'idx_temp_thr_tenant_id' },
  { collection: 'temperature_thresholds', index: { tenantId: 1, stage: 1 }, name: 'uniq_temp_thr_tenant_stage', unique: true },
  { collection: 'haccp_templates', index: { tenantId: 1, id: 1 }, name: 'idx_haccp_tpl_tenant_id' },
  { collection: 'haccp_templates', index: { tenantId: 1, kode: 1 }, name: 'uniq_haccp_tpl_tenant_kode', unique: true },
  { collection: 'haccp_results', index: { tenantId: 1, id: 1 }, name: 'idx_haccp_res_tenant_id' },
  { collection: 'haccp_results', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_haccp_res_tenant_no', unique: true },
  { collection: 'haccp_results', index: { tenantId: 1, productionBatchId: 1, createdAt: -1 }, name: 'idx_haccp_res_tenant_batch' },
  { collection: 'haccp_results', index: { tenantId: 1, status: 1, tanggal: -1 }, name: 'idx_haccp_res_tenant_status_tanggal' },
  { collection: 'haccp_results', index: { tenantId: 1, kitchenId: 1, tanggal: -1 }, name: 'idx_haccp_res_tenant_kitchen_tanggal' },
  { collection: 'supplier_price_book', index: { tenantId: 1, id: 1 }, name: 'idx_spb_tenant_id' },
  { collection: 'supplier_price_book', index: { tenantId: 1, productId: 1, harga: 1 }, name: 'idx_spb_tenant_product_harga' },
  { collection: 'supplier_price_book', index: { tenantId: 1, supplierId: 1, productId: 1 }, name: 'uniq_spb_tenant_supplier_product', unique: true, partialFilterExpression: { aktif: true } },
  { collection: 'qc_templates', index: { tenantId: 1, id: 1 }, name: 'idx_qc_tpl_tenant_id' },
  { collection: 'qc_templates', index: { tenantId: 1, kode: 1 }, name: 'uniq_qc_tpl_tenant_kode', unique: true },
  { collection: 'qc_results', index: { tenantId: 1, id: 1 }, name: 'idx_qc_res_tenant_id' },
  { collection: 'qc_results', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_qc_res_tenant_no', unique: true },
  { collection: 'qc_results', index: { tenantId: 1, productionPlanId: 1, createdAt: -1 }, name: 'idx_qc_res_tenant_plan' },
  { collection: 'qc_results', index: { tenantId: 1, tanggal: -1 }, name: 'idx_qc_res_tenant_tanggal' },
  { collection: 'ka_policies', index: { tenantId: 1, id: 1 }, name: 'idx_ka_pol_tenant_id' },
  { collection: 'ka_policies', index: { tenantId: 1, kode: 1 }, name: 'uniq_ka_pol_tenant_kode', unique: true },
  { collection: 'ka_policies', index: { tenantId: 1, capabilityId: 1, aktif: 1 }, name: 'idx_ka_pol_tenant_capability' },
  { collection: 'ka_monitoring_definitions', index: { tenantId: 1, id: 1 }, name: 'idx_ka_mdef_tenant_id' },
  { collection: 'ka_monitoring_definitions', index: { tenantId: 1, kode: 1 }, name: 'uniq_ka_mdef_tenant_kode', unique: true },
  { collection: 'ka_monitoring_definitions', index: { tenantId: 1, capabilityId: 1, aktif: 1 }, name: 'idx_ka_mdef_tenant_capability' },
  { collection: 'ka_observations', index: { tenantId: 1, signalKey: 1, status: 1 }, name: 'idx_ka_obs_tenant_signal_status' },
  { collection: 'ka_observations', index: { tenantId: 1, id: 1 }, name: 'idx_ka_obs_tenant_id' },
  { collection: 'ka_observations', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_ka_obs_tenant_no', unique: true },
  { collection: 'ka_observations', index: { tenantId: 1, status: 1, createdAt: -1 }, name: 'idx_ka_obs_tenant_status' },
  { collection: 'ka_observations', index: { tenantId: 1, category: 1, createdAt: -1 }, name: 'idx_ka_obs_tenant_category' },
  { collection: 'ka_safety_cases', index: { tenantId: 1, id: 1 }, name: 'idx_ka_scf_tenant_id' },
  { collection: 'ka_safety_cases', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_ka_scf_tenant_no', unique: true },
  { collection: 'ka_safety_cases', index: { tenantId: 1, status: 1, createdAt: -1 }, name: 'idx_ka_scf_tenant_status' },
  { collection: 'ka_safety_cases', index: { tenantId: 1, category: 1, status: 1 }, name: 'idx_ka_scf_tenant_category_status' },
  { collection: 'ka_safety_cases', index: { tenantId: 1, kitchenId: 1, status: 1 }, name: 'idx_ka_scf_tenant_kitchen_status' },
  {
    collection: 'ka_safety_cases',
    index: { tenantId: 1, sourceKey: 1 },
    name: 'uniq_ka_scf_open_source_key',
    unique: true,
    // Avoid $gt:'' (can fail on some Mongo builds); empty sourceKey never written by ensureOpenKaIssue.
    partialFilterExpression: {
      sourceKey: { $exists: true, $type: 'string' },
      status: { $in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'] },
    },
  },
  { collection: 'ka_follow_ups', index: { tenantId: 1, id: 1 }, name: 'idx_ka_kfu_tenant_id' },
  { collection: 'ka_follow_ups', index: { tenantId: 1, noDokumen: 1 }, name: 'uniq_ka_kfu_tenant_no', unique: true },
  { collection: 'ka_follow_ups', index: { tenantId: 1, status: 1, createdAt: -1 }, name: 'idx_ka_kfu_tenant_status' },
  { collection: 'ka_follow_ups', index: { tenantId: 1, safetyCaseId: 1 }, name: 'idx_ka_kfu_tenant_case' },
  {
    collection: 'ka_follow_ups',
    index: { tenantId: 1, safetyCaseId: 1 },
    name: 'uniq_ka_kfu_active_per_case',
    unique: true,
    partialFilterExpression: {
      safetyCaseId: { $exists: true, $type: 'string' },
      status: { $in: ['OPEN', 'DONE'] },
    },
  },
  { collection: 'ka_follow_ups', index: { tenantId: 1, kitchenId: 1, status: 1 }, name: 'idx_ka_kfu_tenant_kitchen_status' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, purchaseRequirementId: 1 }, name: 'idx_cpo_tenant_pr' },
  { collection: 'integration_links', index: { customerTenantId: 1, vendorTenantId: 1 }, name: 'uniq_integration_link', unique: true },
  { collection: 'integration_links', index: { webhookSecret: 1, status: 1 }, name: 'idx_integration_link_secret' },
  { collection: 'integration_links', index: { customerTenantId: 1, status: 1 }, name: 'idx_integration_link_customer' },
  { collection: 'vendor_tenants', index: { tenantId: 1, vendorTenantId: 1 }, name: 'uniq_vendor_tenants', unique: true },
  { collection: 'goods_receipts', index: { id: 1 }, name: 'uniq_grn_id', unique: true },
  { collection: 'hutang', index: { id: 1 }, name: 'uniq_hutang_id', unique: true },
  { collection: 'hutang', index: { tenantId: 1, tanggal: -1 }, name: 'idx_hutang_tenant_tanggal' },
  { collection: 'hutang_pembayaran', index: { hutangId: 1, tanggal: -1 }, name: 'idx_hutang_bayar_hutang' },
  { collection: 'webhook_inbox', index: { tenantId: 1, createdAt: -1 }, name: 'idx_webhook_inbox_tenant' },
  { collection: 'integration_settings', index: { tenantId: 1 }, name: 'uniq_integration_settings_tenant', unique: true },
  { collection: 'users', index: { email: 1, tenantId: 1 }, name: 'uniq_users_email_tenant', unique: true },
  { collection: 'tenant_settings', index: { tenantId: 1 }, name: 'uniq_tenant_settings', unique: true },
  { collection: 'produk_grup', index: { tenantId: 1, nama: 1 }, name: 'uniq_produk_grup', unique: true },
  { collection: 'produk_satuan', index: { tenantId: 1, nama: 1 }, name: 'uniq_produk_satuan', unique: true },
  { collection: 'product_uom', index: { tenantId: 1, productId: 1, satuan: 1 }, name: 'uniq_product_uom_tenant_product_satuan', unique: true },
  { collection: 'product_uom', index: { tenantId: 1, productId: 1 }, name: 'idx_product_uom_tenant_product' },
  {
    collection: 'product_uom',
    index: { tenantId: 1, barcode: 1 },
    name: 'uniq_product_uom_tenant_barcode',
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string', $gt: '' } },
  },
  { collection: 'products', index: { tenantId: 1, nama: 'text', kode: 'text', barcode: 'text' }, name: 'idx_products_text_search' },
  { collection: 'users', index: { emailNormalized: 1, tenantId: 1 }, name: 'uniq_users_email_norm_tenant', unique: true, partialFilterExpression: { emailNormalized: { $exists: true, $type: 'string' } } },
  { collection: 'transfer_stok', index: { tenantId: 1, tanggal: -1 }, name: 'idx_transfer_stok_tenant_tanggal' },
  { collection: 'transfer_stok', index: { tenantId: 1, noTransfer: 1 }, name: 'uniq_transfer_tenant_no', unique: true },
  { collection: 'inventory_releases', index: { tenantId: 1, maintenanceRequestId: 1 }, name: 'idx_inv_release_tenant_wr' },
  { collection: 'dashboard_snapshots', index: { expiresAt: 1 }, name: 'idx_dashboard_snapshot_expires', expireAfterSeconds: 0 },
];

async function safeCreateIndex(
  db: Db,
  collection: string,
  index: Record<string, number | string>,
  options: Record<string, unknown>,
) {
  try {
    await db.collection(collection).createIndex(index as IndexSpecification, options);
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err?.code !== 85 && err?.code !== 86) {
      console.warn(`Index ${options.name}:`, err.message);
    }
  }
}

async function dropIndexIfExists(db: Db, collection: string, name: string): Promise<void> {
  try {
    await db.collection(collection).dropIndex(name);
  } catch {
    /* index mungkin belum ada */
  }
}

async function prepareIndexData(db: Db): Promise<void> {
  await db.collection('products').updateMany(
    {
      $or: [
        { syncSource: { $exists: false } },
        { syncSource: null },
      ],
    },
    { $set: { syncSource: 'local' } },
  );
  // ADR-001: legacy products without itemRole behave as bahan baku for Food Production.
  await db.collection('products').updateMany(
    {
      $or: [
        { itemRole: { $exists: false } },
        { itemRole: null },
        { itemRole: '' },
      ],
    },
    { $set: { itemRole: 'INGREDIENT' } },
  );
  const { backfillEmailNormalized } = await import('@/lib/api/backfill-email-normalized');
  await backfillEmailNormalized(db);
}

async function runEnsureOperationalIndexes(db: Db): Promise<void> {
  // Selalu reconcile sekali per proses — early-return berbasis 1 index lama
  // membuat index FP baru (kitchen/recipe/menu/plan) bisa tidak pernah dibuat.
  await prepareIndexData(db);
  try {
    await db.collection('users').dropIndex('uniq_users_email');
  } catch {
    /* index lama mungkin sudah tidak ada */
  }
  try {
    await db.collection('products').dropIndex('uniq_products_tenant_kode');
  } catch {
    /* index lama mungkin sudah tidak ada */
  }
  await dropIndexIfExists(db, 'products', 'uniq_products_tenant_local_kode');
  await dropIndexIfExists(db, 'users', 'uniq_users_email_norm_tenant');
  await dropIndexIfExists(db, 'recipes', 'idx_recipes_tenant_kode_ver');
  await dropIndexIfExists(db, 'menus', 'idx_menus_tenant_kode_ver');
  // Ganti index non-unique lama → unique partial (cegah GRN dobel dari DO yang sama).
  await dropIndexIfExists(db, 'goods_receipts', 'idx_grn_tenant_delivery');
  // Recreate KA open-sourceKey unique index if prior partial filter was incompatible.
  await dropIndexIfExists(db, 'ka_safety_cases', 'uniq_ka_scf_open_source_key');
  // Recreate active-FU-per-case unique (fails until duplicate OPEN/DONE rows dibersihkan).
  await dropIndexIfExists(db, 'ka_follow_ups', 'uniq_ka_kfu_active_per_case');
  // Draft DST tanpa noDokumen — recreate unique partial.
  await dropIndexIfExists(db, 'distribution_orders', 'uniq_dist_tenant_no');
  for (const spec of INDEX_SPECS) {
    const opts: Record<string, unknown> = { name: spec.name };
    if (spec.unique) opts.unique = true;
    if (spec.partialFilterExpression) opts.partialFilterExpression = spec.partialFilterExpression;
    if (spec.expireAfterSeconds != null) opts.expireAfterSeconds = spec.expireAfterSeconds;
    await safeCreateIndex(db, spec.collection, spec.index, opts);
  }
  operationalIndexesEnsured = true;
}

/** Satu kali per proses — request paralel menunggu promise yang sama (hindari herd index ke Atlas). */
export async function ensureOperationalIndexes(db: Db): Promise<void> {
  if (operationalIndexesEnsured) return;
  if (!operationalIndexesInFlight) {
    operationalIndexesInFlight = runEnsureOperationalIndexes(db).finally(() => {
      operationalIndexesInFlight = null;
    });
  }
  await operationalIndexesInFlight;
}
