// Buku stok: satu-satunya modul yang boleh menulis stok_lokasi / stok_kartu / stok_bin / ingredient_lots
// (dijaga ESLint). Mutasi transaksi → postStockMovements (lotPolicy untuk lot bahan).
// Master/perbaikan → master-stock. Bin manual/rekonsiliasi → bin*. Migrasi skema lama → legacy-migrations.

export {
  STOCK_QTY_DP,
  STOCK_QTY_EPS,
  STOCK_UNIT_COST_DP,
  STOCK_MONEY_DP,
  roundStockQty,
  roundQty,
  roundUnitCost,
  roundMoney,
  qtyLt,
  qtyGt,
  qtyEq,
  isZeroQty,
} from '@/lib/stock-ledger/precision';

export {
  postStockMovements,
  type StockSourceType,
  type StockMovementLine,
  type PostStockMovementsInput,
  type PostStockMovementsResult,
  type PostedStockLine,
  type StockLotPolicy,
  type StockLotCreateInput,
  type LotPostingResult,
} from '@/lib/stock-ledger/post-stock-movements';

export type { StockActor, StockCostSource } from '@/lib/stock-ledger/kartu';

export {
  ledgerSaldoForProducts,
  availableQtyAgainstLedger,
  shouldEnforceLedgerOnOutbound,
  getAvailableQtyAtLokasi,
  type LedgerSaldoInfo,
} from '@/lib/stock-ledger/ledger-saldo';

export { recomputeProductStok, purgeNonHomeLokasiRows } from '@/lib/stock-ledger/balance';

export {
  setProductWarehouseStock,
  applyMasterProductStockChange,
  relocateProductWarehouseWithAudit,
  reconcileProductStockFromLedger,
  backfillProductGudangForTenant,
  backfillAllProductGudang,
  type SetWarehouseStockResult,
  type MasterStockChangeResult,
  type RelocateWarehouseResult,
  type StockLedgerProduct,
} from '@/lib/stock-ledger/master-stock';

export { migrateStokLokasiFromProducts, migrateLegacyStokLokasi } from '@/lib/stock-ledger/legacy-migrations';
