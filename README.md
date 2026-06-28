# Inventory App (Customer)

Fork dari **sales.app** — difokuskan untuk **customer gudang**: terima barang via webhook sales.app → GRN → stok masuk.

## Beda dengan sales.app

| | sales.app | inventory-app |
|---|-----------|-----------------|
| Port dev | 3000 | **3001** |
| Database | `kasir_db` / sales | **`inventory_customer`** |
| Session cookie | `kasir_session` | `inventory_session` |
| Peran | Vendor (jual) | Customer (terima) |

## Quick Start

```bash
cd ~/Assignment/inventory/inventory-app
cp .env.example .env.local
# Edit WEBHOOK_SECRET = secret dari sales.app → Integrasi API

npm install
npm run dev
```

- URL: http://localhost:3001
- Login: akun dibuat via **User Management** (role GUDANG / SUPERVISOR / ADMIN / OWNER)
- Halaman app dilindungi **proxy** (`proxy.ts`) — tanpa session cookie akan diarahkan ke login

## Integrasi sales.app

### Dev lokal (sudah diset)

`.env.local` sudah berisi key dev yang di-seed otomatis di sales.app saat server pertama kali jalan:

```env
SALES_APP_URL=http://localhost:3000
SALES_API_KEY=sk_inventory_dev_sync_only_local_not_production
SALES_VENDOR_TENANT_ID=default
```

Jika produk di sales.app ada di tenant lain (bukan `default`), ubah `SALES_VENDOR_TENANT_ID` ke ID tenant toko tersebut.

### Production / key baru

1. **sales.app** → Pelanggan → `customerTenantId` = `sppg`
2. **sales.app** → **Pengaturan → Integrasi API** → buat **API Key** → paste ke `SALES_API_KEY` di inventory `.env.local`
3. **sales.app** → Integrasi → webhook (URL: `https://<inventory-host>/api/webhooks/sales`):
   - `delivery.shipped` — GRN otomatis
   - `invoice.posted` — hutang vendor otomatis
   - `credit_note.posted` — koreksi hutang
   - `product.created` / `product.updated` — sync produk
4. Copy **webhook secret** → `WEBHOOK_SECRET` di inventory
5. **inventory** → Master Produk → **Sync dari sales.app** (tarik katalog awal)
6. Edit produk di sales.app → nama/satuan otomatis update di inventory

### Verifikasi integrasi

```bash
npm run verify:sales
# atau tenant tertentu:
npm run verify:sales -- --tenant=sppg
```

## Scripts

| Script | Fungsi |
|--------|--------|
| `npm run dev` | Dev server port 3001 |
| `npm run verify:sales` | Cek koneksi sales.app + status GRN/hutang |
| `npm run typecheck` | TypeScript check (seluruh proyek) |
| `npm run typecheck:strict` | Typecheck ketat (`noImplicitAny`) untuk modul inti |
| `npm run ci` | Typecheck + unit tests + build (lokal / pre-push) |
| `npm run test:unit` | Unit tests (Vitest) |
| `npm run test:e2e` | E2E tests (Playwright) |
| `npm run test` | Unit + E2E |
| `npm run test:phase5` | Regression semi-auto (default port 3001) |
| `npm run backfix:hutang` | Backfix hutang dari GRN posted |
| `npm run diag:hutang` | Diagnostik hutang (dry-run) |

## Gudang operasional

Setiap tenant memiliki **dua gudang tetap**:

- **GKERING** — Gudang Kering
- **GBASAH** — Gudang Basah

Satu SKU hanya boleh di satu gudang. Transfer antar GKERING ↔ GBASAH tidak diizinkan.

## MongoDB transactions (production)

Operasi kritis (GRN post, hutang, penyesuaian stok, transfer stok) memakai MongoDB transaction bila replica set tersedia. Untuk production, jalankan MongoDB sebagai replica set; di dev standalone, app otomatis fallback tanpa transaction.

Contoh dev dengan replica set (Docker):

```bash
docker run -d --name mongo-rs -p 27017:27017 mongo:7 --replSet rs0
docker exec mongo-rs mongosh --eval "rs.initiate()"
# MONGO_URL=mongodb://127.0.0.1:27017/?replicaSet=rs0
```

## Enterprise checklist

| Area | Status |
|------|--------|
| MongoDB transactions (GRN, hutang, penyesuaian, transfer) | ✅ dengan fallback dev |
| Audit trail (`audit_log`) | ✅ GRN, hutang, stok, release |
| Structured logging | ✅ `lib/api/logger.ts` |
| Unit + E2E tests | ✅ Vitest + Playwright |
| CI/CD | ✅ `.github/workflows/ci.yml` |
| CORS + session proxy | ✅ `CORS_ORIGINS`, `proxy.ts` |
| Type safety gradual | ✅ `tsconfig.strict.json` (modul inti) + `typecheck:strict` |
| Domain types | ✅ `types/integration.ts`, handler helpers |

## Testing

```bash
cp .env.example .env.local
npm install
npm run test:unit
npm run test:e2e   # butuh server — CI menjalankan build+start otomatis
```

## Push GitHub

```bash
git add .
git commit -m "Inventory app — customer GRN from sales.app webhook"
git remote add origin git@github.com:sdwianto/inventory.git
git push -u origin main
```
