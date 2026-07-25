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
