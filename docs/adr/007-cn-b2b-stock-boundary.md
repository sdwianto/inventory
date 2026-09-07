# ADR-007 — Sales CN B2B Stock Boundary (mirror)

| Meta | Nilai |
|------|--------|
| Status | **Accepted** |
| Tanggal | 2026-09-07 |
| Canonical | Sales [`ADR-007-CN-B2B-STOCK-BOUNDARY.md`](../../../sales/docs/architecture/ADR-007-CN-B2B-STOCK-BOUNDARY.md) |

## Ringkas (Inventory)

- CN manual B2B dari Sales: **finansial saja** (`credit-note-posted` → hutang). Field wire `storeRestockStatus=SKIPPED_B2B` disimpan di trail `hutang.creditNotes[]` (audit; tidak mengubah stok).
- **Tidak** ada inbound `sales-return-posted` yang IN stok gudang buyer (melawan RTV).
- Physical return gudang = ADR-005/006 (RTV).
- Apply hutang / clear transit tidak mengubah perilaku stok karena flag ini.

Lihat juga [005-goods-return-credit-note.md](./005-goods-return-credit-note.md).
