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
| Index | `sales/docs/engineering/README.md` |
| Reliability policy | `sales/docs/engineering/reliability-policy.md` |
| Release checklist | `sales/docs/engineering/release-checklist.md` |
| Definition of Done | `sales/docs/engineering/definition-of-done.md` |
| Code review | `sales/docs/engineering/code-review-checklist.md` |

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
