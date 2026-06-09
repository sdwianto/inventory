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
- Login: `admin@inventory.local` / `admin123` (tenant: `sppg`)

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
3. **sales.app** → Integrasi → webhook (URL sama: `http://localhost:3001/api/webhooks/sales`):
   - `delivery.shipped` — GRN otomatis
   - `invoice.posted` — hutang vendor otomatis
   - `credit_note.posted` — koreksi hutang
   - `product.created` / `product.updated` — sync produk
4. Copy **webhook secret** → `WEBHOOK_SECRET` di inventory
5. **inventory** → Master Produk → **Sync dari sales.app** (tarik katalog awal)
6. Edit produk di sales.app → nama/satuan otomatis update di inventory

## Push GitHub

```bash
git add .
git commit -m "Inventory app — customer GRN from sales.app webhook"
git remote add origin git@github.com:USERNAME/inventory-app.git
git push -u origin main
```
