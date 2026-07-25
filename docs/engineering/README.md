# Engineering Playbook — Inventory

Playbook canonical ada di **Sales repo**:

```
~/Assignment/sales/sales/docs/engineering/
```

Inventory mengikuti policy yang sama.

## Sebelum PR integration

Baca di Sales repo:

| Dokumen | Path |
|---------|------|
| **W1-7 Conventions** | `sales/docs/architecture/W1-7-ENGINEERING-CONVENTIONS.md` |
| **W2-1 FEFO Batch Consume** | `sales/docs/architecture/W2-1-FEFO-BATCH-CONSUME.md` |
| **W2-2 Distribution FEFO** | `sales/docs/architecture/W2-2-DISTRIBUTION-FEFO.md` |
| **W2-3 Dist Return Restock** | `sales/docs/architecture/W2-3-DISTRIBUTION-RETURN-RESTOCK.md` |
| **W2-4 Cycle Count** | `sales/docs/architecture/W2-4-CYCLE-COUNT.md` |
| **W2-5 Ingredient Lot Stamp** | `sales/docs/architecture/W2-5-INGREDIENT-LOT-STAMP.md` |
| **W2-6 Issue Ingredient FEFO** | `sales/docs/architecture/W2-6-ISSUE-INGREDIENT-FEFO.md` |
| **W2-7 Lot vs Stok Repair** | `sales/docs/architecture/W2-7-INGREDIENT-LOT-VS-STOK-REPAIR.md` |
| **W2-8 Cycle Count Ingredient Lots** | `sales/docs/architecture/W2-8-CYCLE-COUNT-INGREDIENT-LOTS.md` |
| **W2-9 Issue FEFO Shortfall Detect** | `sales/docs/architecture/W2-9-ISSUE-FEFO-SHORTFALL-DETECT.md` |
| **W2-10 Dist FEFO Shortfall Detect** | `sales/docs/architecture/W2-10-DIST-FEFO-SHORTFALL-DETECT.md` |
| **W2-11 Release FEFO Shortfall Detect** | `sales/docs/architecture/W2-11-RELEASE-FEFO-SHORTFALL-DETECT.md` |
| **W2-12 Transfer FEFO** | `sales/docs/architecture/W2-12-TRANSFER-FEFO.md` |
| **W2-13 Transfer Lot FEFO** | `sales/docs/architecture/W2-13-TRANSFER-LOT-FEFO.md` |
| **W2-14 Dist Return FEFO Shortfall Detect** | `sales/docs/architecture/W2-14-DIST-RETURN-FEFO-SHORTFALL-DETECT.md` |
| **W2-15 HSL Yield/Waste Write-off** | `sales/docs/architecture/W2-15-HSL-YIELD-WASTE-WRITEOFF.md` |
| **W2-16 Slotting Foundation** | `sales/docs/architecture/W2-16-SLOTTING-FOUNDATION.md` |
| **W2-17 Bin Balance Ledger** | `sales/docs/architecture/W2-17-BIN-BALANCE-LEDGER.md` |
| **W2-18 Putaway Move** | `sales/docs/architecture/W2-18-PUTAWAY-MOVE.md` |
| **W2-19 Soft OUT Bin Consume** | `sales/docs/architecture/W2-19-OUT-BIN-CONSUME.md` |
| **W2-20 Release/Transfer Bin OUT** | `sales/docs/architecture/W2-20-RELEASE-TRANSFER-BIN-OUT.md` |
| **W2-21 Transfer IN Bin Putaway** | `sales/docs/architecture/W2-21-TRANSFER-IN-BIN-PUTAWAY.md` |
| **W2-22 Soft Bin LT Repair** | `sales/docs/architecture/W2-22-STOK-BIN-LT-REPAIR.md` |
| **W2-23 Soft Bin GT Reverse** | `sales/docs/architecture/W2-23-STOK-BIN-GT-REVERSE.md` |
| **W2-24 Warehouse Slotting Closeout** | `sales/docs/architecture/W2-24-WAREHOUSE-SLOTTING-CLOSEOUT.md` |
| **W2-25 KA Follow-up Orphan Reconcile** | `sales/docs/architecture/W2-25-KA-FOLLOW-UP-ORPHAN-RECONCILE.md` |
| Guardrails | `sales/docs/architecture/IMPLEMENTATION-GUARDRAILS.md` |
| Index | `sales/docs/engineering/README.md` |
| Reliability policy | `sales/docs/engineering/reliability-policy.md` |
| Release checklist | `sales/docs/engineering/release-checklist.md` |
| Definition of Done | `sales/docs/engineering/definition-of-done.md` |
| Code review | `sales/docs/engineering/code-review-checklist.md` |

```bash
npm run check:no-peer-fetch
```

## Verifikasi Inventory

```bash
cd ~/Assignment/inventory/inventory-app
npm run typecheck
npm run build

# Dev E2E
node scripts/procurement-e2e-test.mjs

# Prod (dari sales repo)
cd ~/Assignment/sales/sales && npm run p0:stabilize -- --prod
```

## Repair cepat (prod)

```bash
cd ~/Assignment/inventory/inventory-app
npm run replay:po-vendor -- --noPO=CPO2607000006 --apply
node scripts/repair-procurement.mjs --apply --tenant=sppg
```
