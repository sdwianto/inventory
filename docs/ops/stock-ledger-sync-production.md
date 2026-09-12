# Production rollout — Stock ledger sync

Sinkronisasi `stok_lokasi` / saldo gudang / panduan / pengeluaran / kartu / penyesuaian / transfer ke **saldo kartu stok** sebagai sumber kebenaran.

## Apa yang di-deploy (kode)

- Outbound (release, transfer, `postStockMutation`) dibatasi `min(lokasi, max(0, kartu))`
- Tampilan saldo / picker produk / panduan release: satu gudang home + capped kartu
- Penyesuaian tetap boleh koreksi (tidak di-cap)
- API:
  - `POST /api/stok/kartu/reconcile` — per SKU (`clearNegative` optional, default off)
  - `POST /api/stok/kartu/reconcile-all` — **default dry-run**; butuh `dryRun: false` untuk apply

## Urutan production (wajib)

### 1. Deploy kode saja (tanpa mutate data)

Deploy branch/PR stock sync. Guard oversell aktif segera setelah release.

Smoke staging/prod:

- [ ] `/stok/saldo` — tidak ada qty phantom di gudang non-home
- [ ] `/stok/pengeluaran` picker — qty ≤ kartu
- [ ] Panduan release — SOH tidak > kartu
- [ ] Release qty > kartu → ditolak
- [ ] Penyesuaian (+/−) masih bisa disimpan
- [ ] Kartu stok urutan terbaru di atas

### 2. Audit drift (read-only)

```bash
# di host yang punya akses MONGO prod + env DB_NAME/MONGO_URL
npx tsx scripts/reconcile-stok-lokasi-to-ledger.ts <tenantId>
```

Atau API (acting tenant sudah dipilih):

```http
POST /api/stok/kartu/reconcile-all
{ "dryRun": true }
```

Simpan output: `driftCount`, `wouldClearNegative`, daftar `issues`.

### 3. Apply lokasi (tanpa hapus kartu negatif dulu)

```bash
npx tsx scripts/reconcile-stok-lokasi-to-ledger.ts <tenantId> --apply
```

```http
POST /api/stok/kartu/reconcile-all
{ "dryRun": false, "clearNegative": false }
```

Efek: purge phantom multi-gudang + set qty home = `max(0, kartu)`. Kartu negatif **tetap** (audit trail) sampai langkah 4.

### 4. Clear kartu negatif (ops explicit)

Hanya setelah review nilai/qty:

```bash
npx tsx scripts/reconcile-stok-lokasi-to-ledger.ts <tenantId> --apply --clear-negative
```

```http
POST /api/stok/kartu/reconcile-all
{ "dryRun": false, "clearNegative": true }
```

Menulis `penyesuaian_stok` + baris kartu `PENYESUAIAN (+)` per SKU negatif.

### 5. Stock opname (jika fisik ≠ kartu)

Buat **Penyesuaian Stok** manual untuk selisih fisik.

## Rollback

- Kode: revert PR / redeploy previous release — guard hilang, data tidak otomatis rollback.
- Data: penyesuaian `REPAIR_LEDGER_LOKASI_DRIFT` bisa dilacak di `penyesuaian_stok.source`; koreksi balik via penyesuaian manual (jangan hapus history kartu).

## Catatan

- Satu SKU = satu `gudangKode` home. Duplikat kode antar vendor (Puspita/Uddawam) adalah desain multi-vendor, bukan bug.
- Jangan jalankan `--clear-negative` di production tanpa audit dry-run.
