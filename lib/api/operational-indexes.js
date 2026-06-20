// Index operasional — sekali per proses, mempercepat query laporan & kasir.

let operationalIndexesEnsured = false;

const INDEX_SPECS = [
  { collection: 'transactions', index: { tenantId: 1, tanggal: -1 }, name: 'idx_trx_tenant_tanggal' },
  { collection: 'transactions', index: { tenantId: 1, id: 1 }, name: 'idx_trx_tenant_id' },
  { collection: 'jurnal', index: { tenantId: 1, tanggal: -1 }, name: 'idx_jurnal_tenant_tanggal' },
  { collection: 'stok_kartu', index: { tenantId: 1, stokId: 1, tanggal: 1 }, name: 'idx_stok_kartu_tenant_stok_tgl' },
  { collection: 'piutang', index: { tenantId: 1, pelangganId: 1, status: 1 }, name: 'idx_piutang_tenant_pelanggan' },
  { collection: 'hutang', index: { tenantId: 1, supplierId: 1, status: 1 }, name: 'idx_hutang_tenant_supplier' },
  { collection: 'hutang', index: { tenantId: 1, vendorInvoiceId: 1 }, name: 'idx_hutang_vendor_invoice' },
  { collection: 'hutang', index: { tenantId: 1, approvalStatus: 1, approvedAt: -1 }, name: 'idx_hutang_tenant_approval_at' },
  { collection: 'hutang', index: { tenantId: 1, noPO: 1 }, name: 'idx_hutang_tenant_nopo' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_cpo_tenant_tanggal' },
  { collection: 'customer_purchase_orders', index: { tenantId: 1, noPO: 1 }, name: 'idx_cpo_tenant_nopo' },
  { collection: 'pembelian', index: { tenantId: 1, tanggal: -1 }, name: 'idx_pembelian_tenant_tanggal' },
  { collection: 'purchase_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_po_tenant_tanggal' },
  { collection: 'purchase_orders', index: { tenantId: 1, noPO: 1 }, name: 'idx_po_tenant_nopo' },
  { collection: 'api_keys', index: { keyHash: 1 }, name: 'uniq_api_key_hash', unique: true },
  { collection: 'webhook_subscriptions', index: { tenantId: 1, event: 1 }, name: 'idx_webhook_tenant_event' },
  { collection: 'sales_orders', index: { tenantId: 1, tanggal: -1 }, name: 'idx_so_tenant_tanggal' },
  { collection: 'sales_orders', index: { tenantId: 1, noSO: 1 }, name: 'idx_so_tenant_noso' },
  { collection: 'deliveries', index: { tenantId: 1, salesOrderId: 1 }, name: 'idx_do_tenant_so' },
  { collection: 'invoices', index: { tenantId: 1, tanggal: -1 }, name: 'idx_inv_tenant_tanggal' },
  { collection: 'customer_price_lists', index: { tenantId: 1, pelangganId: 1, stokId: 1 }, name: 'uniq_customer_price', unique: true },
  { collection: 'document_sequences', index: { tenantId: 1, docType: 1 }, name: 'uniq_doc_sequence', unique: true },
  { collection: 'goods_receipts', index: { tenantId: 1, tanggal: -1 }, name: 'idx_grn_tenant_tanggal' },
  { collection: 'webhook_inbox', index: { dedupeKey: 1 }, name: 'uniq_webhook_dedupe', unique: true },
  { collection: 'goods_receipts', index: { tenantId: 1, status: 1, 'items.vendorKode': 1 }, name: 'idx_grn_tenant_status_kode' },
  { collection: 'products', index: { tenantId: 1, kode: 1 }, name: 'uniq_products_tenant_kode', unique: true },
  { collection: 'vendor_tenants', index: { tenantId: 1, vendorTenantId: 1 }, name: 'uniq_vendor_tenants', unique: true },
  { collection: 'users', index: { email: 1 }, name: 'uniq_users_email', unique: true },
  { collection: 'tenant_settings', index: { tenantId: 1 }, name: 'uniq_tenant_settings', unique: true },
  { collection: 'products', index: { tenantId: 1, barcode: 1 }, name: 'idx_products_tenant_barcode' },
  { collection: 'products', index: { tenantId: 1, id: 1 }, name: 'idx_products_tenant_id' },
  { collection: 'produk_grup', index: { tenantId: 1, nama: 1 }, name: 'uniq_produk_grup', unique: true },
  { collection: 'produk_satuan', index: { tenantId: 1, nama: 1 }, name: 'uniq_produk_satuan', unique: true },
];

async function safeCreateIndex(db, collection, index, options) {
  try {
    await db.collection(collection).createIndex(index, options);
  } catch (e) {
    if (e?.code !== 85 && e?.code !== 86) {
      console.warn(`Index ${options.name}:`, e.message);
    }
  }
}

export async function ensureOperationalIndexes(db) {
  if (operationalIndexesEnsured) return;
  for (const spec of INDEX_SPECS) {
    const opts = { name: spec.name };
    if (spec.unique) opts.unique = true;
    await safeCreateIndex(db, spec.collection, spec.index, opts);
  }
  operationalIndexesEnsured = true;
}
