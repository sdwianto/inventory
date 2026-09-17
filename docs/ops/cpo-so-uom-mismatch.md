# Audit & repair — CPO ↔ SO satuan mismatch

Mencegah / memperbaiki kasus di mana baris CPO Inventory memakai satuan order (mis. **KG**, **BAK**) tetapi `vendorUomId` tercap ke satuan dasar Sales (**ONS**, **PTG**), sehingga SO tampil beda satuan atau understate qty.

## Root cause (ringkas)

1. Setelah Sync Katalog, `uomId` lokal di baris CPO bisa usang.
2. Fallback `vendorBaseUomId` (selalu satuan dasar) distamp tanpa cek kecocokan satuan.
3. Sales inbound mempercayai `uomId` di atas label `satuan` (harga + qtyBase).

## Guard di kode

- Inventory: `resolveVendorUomId` menolak `vendorUomId` yang beda satuan; `vendorBaseUomIdIfCompatible` dipakai di map CPO/PRB.
- Inventory: `enrichPoItemsForVendor` — label satuan baris menang atas `uomId` lokal yang conflict; hard-fail bila mapping vendor tetap mismatch; push mem-persist binding ke CPO.
- Inventory: Sync Katalog **single + bulk** memanggil rematch CPO open (`SUBMITTED`/`APPROVED`/`PARTIAL_*`/dll.) by satuan.
- Sales inbound: pricing satuan-first (abaikan `uomId` bila `satuan` ada) + attach `preferSatuanOnUomConflict`.

## Audit / repair data

```bash
cd ~/workspace/projects/inventory
set -a && . ../sales/.env.docker && set +a

# Dry-run
INV_DB_NAME=sppg_penarukan2 SALES_DB_NAME=dawam_erp SALES_TENANT=uddawam \
  node scripts/audit-repair-cpo-so-uom.mjs

# Rebind CPO saja
INV_DB_NAME=sppg_penarukan2 SALES_DB_NAME=dawam_erp SALES_TENANT=uddawam \
  node scripts/audit-repair-cpo-so-uom.mjs --apply

# + restore SO DRAFT ke satuan/qty CPO (review soRepairs dulu — Tahu BAK↔PTG mengubah nilai)
INV_DB_NAME=sppg_penarukan2 SALES_DB_NAME=dawam_erp SALES_TENANT=uddawam \
  node scripts/audit-repair-cpo-so-uom.mjs --apply --repair-so
```

Catatan:

- SO **non-DRAFT** tidak di-rewrite otomatis.
- PRB tidak menyimpan `uomId` — mapping terjadi saat buat Draft CPO; script ini hanya CPO (+ SO opsional).
