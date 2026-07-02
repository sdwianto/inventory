/** Central React Query keys — keep stable for cache invalidation. */

export const queryKeys = {
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
  },
  integrations: {
    all: ['integrations'] as const,
    status: (probe?: boolean) => ['integrations', 'status', probe ? 'probe' : 'fast'] as const,
  },
  goodsReceipts: {
    all: ['goods-receipts'] as const,
  },
  hutang: {
    all: ['hutang'] as const,
  },
} as const;
