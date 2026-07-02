# Setup Background Worker via cron-job.org (Gratis / Vercel Hobby)

ERP memakai antrian `bg_jobs` (sync katalog, hutang, GRN, PO vendor, webhook).
Di plan **Vercel Hobby**, cron bawaan Vercel **tidak boleh** tiap menit — gunakan [cron-job.org](https://cron-job.org) (gratis).

## 1. Generate secret (sekali)

Di terminal (WSL/Linux/macOS):

```bash
openssl rand -hex 32
```

Simpan hasilnya — ini `WORKER_SECRET`.

## 2. Set environment di Vercel

Untuk **kedua** project (Sales + Inventory), di **Settings → Environment Variables**:

| Name | Value | Environment |
|------|-------|-------------|
| `WORKER_SECRET` | *(secret dari langkah 1)* | Production (+ Preview opsional) |

Opsional: `CRON_SECRET` dengan nilai sama (kompatibel Bearer).

Redeploy kedua app setelah menyimpan env.

## 3. Daftar akun cron-job.org

1. Buka https://console.cron-job.org/signup
2. Buat akun gratis → login → **Cronjobs** → **Create cronjob**

Buat **4 cronjob** (atau minimal 2 untuk worker):

### A. Sales — proses background jobs (wajib)

| Field | Nilai |
|-------|--------|
| Title | `DAWAM Sales — bg worker` |
| URL | `https://sales-dawam.vercel.app/api/bg-jobs/process` |
| Schedule | Every **2** minutes (atau 5 menit jika ingin hemat) |
| Request method | `GET` |
| Enabled | ✓ |

**Headers** (tab Advanced / Request headers):

```
Authorization: Bearer <WORKER_SECRET>
```

Ganti `<WORKER_SECRET>` dengan secret yang sama seperti di Vercel.

Alternatif header (sama efeknya):

```
X-Worker-Secret: <WORKER_SECRET>
```

### B. Inventory — proses background jobs (wajib)

| Field | Nilai |
|-------|--------|
| Title | `DAWAM Inventory — bg worker` |
| URL | `https://penarukan2.vercel.app/api/bg-jobs/process` |
| Schedule | Every **2** minutes |
| Request method | `GET` |

Header sama seperti Sales.

### C & D. Keep-warm (disarankan — kurangi cold start Vercel)

| App | URL |
|-----|-----|
| Sales | `https://sales-dawam.vercel.app/api/health` |
| Inventory | `https://penarukan2.vercel.app/api/health` |

| Field | Nilai |
|-------|--------|
| Schedule | Every **10** or **15** minutes |
| Request method | `GET` |
| Headers | *(kosong — endpoint public)* |

Tanpa keep-warm, request pertama setelah idle bisa lambat 3–8 detik.

## 4. Verifikasi

Dari mesin lokal (setelah deploy + env):

```bash
# Sales
WORKER_SECRET='your-secret' npm run test:worker -- https://sales-dawam.vercel.app

# Inventory
WORKER_SECRET='your-secret' npm run test:worker -- https://penarukan2.vercel.app
```

Respon sukses contoh:

```json
{ "processed": 0, "results": [], "at": "2026-..." }
```

`processed: 0` normal jika tidak ada job `PENDING`.

### Uji end-to-end sync

1. Inventory → **Integrasi** → Sync Katalog → tunggu 2–5 menit → job `DONE`
2. **Hutang** → Sync invoice → idem
3. **Penerimaan** → Sync DO → idem

## 5. Troubleshooting

| Gejala | Penyebab | Solusi |
|--------|----------|--------|
| HTTP 401 | Secret salah / belum di-set | Cek `WORKER_SECRET` di Vercel + header cron-job.org |
| Job tetap `PENDING` | Cron belum jalan / URL salah | Cek **Execution history** di cron-job.org |
| Deploy Vercel gagal (cron) | Masih ada `* * * * *` di vercel.json | Pastikan crons Vercel sudah dihapus (pakai cron-job.org) |
| Sync lama | Interval cron 5+ menit | Turunkan ke 2 menit |

## 6. Bootstrap production (sekali)

Setelah deploy pertama atau migrasi DB lama, jalankan dari mesin dengan `MONGO_URL` production:

```bash
# Sales
cd sales && MONGO_URL='...' DB_NAME='...' npm run migrate:bootstrap

# Inventory
cd inventory-app && MONGO_URL='...' DB_NAME='...' npm run migrate:bootstrap
```

Ini men-set flag `*_bootstrap_complete` di `system_meta` tanpa menunggu request user pertama.
Aman dijalankan ulang — idempotent jika bootstrap sudah selesai.

## 7. Dev lokal (tanpa cron-job.org)

```bash
# Terminal 1 — app
npm run dev

# Terminal 2 — worker (sales port 3000, inventory 3001)
WORKER_INTERNAL_URL=http://localhost:3001 WORKER_SECRET=dev-secret npm run worker:bg-jobs
```

## Ringkasan URL production

| App | Worker | Health |
|-----|--------|--------|
| Sales | `https://sales-dawam.vercel.app/api/bg-jobs/process` | `.../api/health` |
| Inventory | `https://penarukan2.vercel.app/api/bg-jobs/process` | `.../api/health` |
