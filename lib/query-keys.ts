/** Central React Query keys — keep stable for cache invalidation. */

export const queryKeys = {
  dashboard: {
    all: ['dashboard'] as const,
  },
  workspace: {
    all: ['workspace'] as const,
    bootstrap: (scopeKey: string) => ['workspace', 'bootstrap', scopeKey] as const,
  },
  pages: {
    penerimaan: (cursor?: string | null) => ['pages', 'penerimaan', cursor || ''] as const,
    hutang: (params: { status?: string; approvalStatus?: string } = {}) =>
      ['pages', 'hutang', params] as const,
    produk: (q = '') => ['pages', 'produk', q] as const,
  },
  products: {
    all: ['products'] as const,
    list: (params: { limit?: number; withWarehouseStock?: boolean } = {}) =>
      ['products', 'list', params] as const,
  },
  productMeta: {
    all: ['product-meta'] as const,
    grup: (tenantId = '') => ['product-meta', 'grup', tenantId] as const,
    satuan: (tenantId = '') => ['product-meta', 'satuan', tenantId] as const,
  },
  integrations: {
    all: ['integrations'] as const,
    status: (probe?: boolean) => ['integrations', 'status', probe ? 'probe' : 'fast'] as const,
    vendorTiers: ['integrations', 'vendor-tiers'] as const,
  },
  goodsReceipts: {
    all: ['goods-receipts'] as const,
    detail: (id: string) => ['goods-receipts', 'detail', id] as const,
  },
  vendorReturns: {
    all: ['vendor-returns'] as const,
    list: (params: { status?: string; q?: string } = {}) =>
      ['vendor-returns', 'list', params] as const,
    detail: (id: string) => ['vendor-returns', 'detail', id] as const,
    eligible: ['vendor-returns', 'eligible'] as const,
  },
  hutang: {
    all: ['hutang'] as const,
    detail: (id: string) => ['hutang', 'detail', id] as const,
  },
  transfer: {
    all: ['transfer'] as const,
    list: ['transfer', 'list'] as const,
  },
  penyesuaian: {
    all: ['penyesuaian'] as const,
    list: ['penyesuaian', 'list'] as const,
  },
  inventoryReleases: {
    all: ['inventory-releases'] as const,
    list: ['inventory-releases', 'list'] as const,
  },
  stokSaldo: {
    all: ['stok-saldo'] as const,
    list: ['stok-saldo', 'list'] as const,
    rows: (params: { q?: string } = {}) => ['stok-saldo', 'rows', params] as const,
    trend: (trendMonths: string) => ['stok-saldo', 'trend', trendMonths] as const,
    report: (params: { q?: string; trendMonths?: string } = {}) =>
      ['stok-saldo', 'report', params] as const,
  },
  panduanRelease: {
    all: ['panduan-release'] as const,
    list: (params: { warehouseKode?: string } = {}) =>
      ['panduan-release', 'list', params] as const,
  },
  stokKartu: {
    all: ['stok-kartu'] as const,
    detail: (params: { productId: string; from?: string; to?: string }) =>
      ['stok-kartu', 'detail', params] as const,
  },
  lokasi: {
    all: ['lokasi'] as const,
    list: (params: { tenantId?: string } = {}) => ['lokasi', 'list', params] as const,
  },
  warehouseBins: {
    all: ['warehouse-bins'] as const,
    list: (params: { tenantId?: string; warehouseKode?: string } = {}) =>
      ['warehouse-bins', 'list', params] as const,
  },
  putawayMoves: {
    all: ['putaway-moves'] as const,
    list: (params: { tenantId?: string; warehouseKode?: string; status?: string } = {}) =>
      ['putaway-moves', 'list', params] as const,
    detail: (id: string) => ['putaway-moves', 'detail', id] as const,
  },

  procurementExpenses: {
    all: ['procurement-expenses'] as const,
    report: (params: { from: string; to: string }) =>
      ['procurement-expenses', 'report', params] as const,
  },
  customerPurchaseOrders: {
    all: ['customer-purchase-orders'] as const,
    list: ['customer-purchase-orders', 'list'] as const,
  },
  tenants: {
    all: ['tenants'] as const,
    list: ['tenants', 'list'] as const,
  },
  tenantSettings: {
    all: ['tenant-settings'] as const,
    detail: (tenantId: string) => ['tenant-settings', tenantId] as const,
  },
  users: {
    all: ['users'] as const,
    list: ['users', 'list'] as const,
  },
  sandbox: {
    all: ['sandbox'] as const,
    status: ['sandbox', 'status'] as const,
    preview: (params: { tenantId?: string; includeSales?: boolean; profile?: string } = {}) =>
      ['sandbox', 'preview', params] as const,
  },
  maintenance: {
    assets: {
      all: ['assets'] as const,
      list: (params: { q?: string; status?: string } = {}) => ['assets', 'list', params] as const,
      detail: (id: string) => ['assets', 'detail', id] as const,
    },
    requests: {
      all: ['maintenance-requests'] as const,
      cursor: (status = '') => ['maintenance-requests', 'cursor', status] as const,
      detail: (id: string) => ['maintenance-requests', 'detail', id] as const,
    },
    schedules: {
      all: ['maintenance-schedules'] as const,
      cursor: (status = '') => ['maintenance-schedules', 'cursor', status] as const,
    },
    reports: {
      all: ['maintenance-reports'] as const,
      report: (params: { from?: string; to?: string; assetId?: string } = {}) =>
        ['maintenance-reports', 'report', params] as const,
    },
    serviceOrders: {
      all: ['maintenance-service-orders'] as const,
    },
  },
  ops: {
    dashboard: ['ops', 'dashboard'] as const,
  },
  audit: {
    list: (params: Record<string, unknown>) => ['audit', 'list', params] as const,
  },
} as const;
