# ADR-001: Food Production Domain Architecture (MBG-first)

**Status:** ACCEPTED  
**Tanggal:** 2026-07-15  
**Owner:** Inventory Domain / Product Architecture  
**App host:** Inventory App  
**Revisi:** Management & Intelligence phase + domain Management — 2026-07-15  
**Revisi:** Post-migrasi Sprint 1–5 — Armada + Delivery keluar ke domain Logistics (ADR-003); Distribution terbelah Dispatch (tetap di sini) / Delivery (Logistics); Service Point diklasifikasi Destination Master / shared supporting domain (tidak dipindah) — 2026-07-28

---

## Filosofi

> **Simple for Kitchen Operators, Powerful for Management.**

| Peran | Yang dilihat |
|-------|----------------|
| **Operator dapur** | Hari ini masak apa? Ambil bahan. Hasil berapa porsi? |
| **Kepala dapur / manajer** | Target, budget, nutrisi, QC, forecast |
| **Direktur** | Dashboard, cost, AI, tren |

Satu modul — **informasi berbeda per peran**. Tidak bersaing dengan SAP di jumlah fitur; berbeda di **bahasa operasional** + **kecerdasan manajemen** yang muncul setelah dapur jalan.

**Prinsip layar operasional (Phase 1–2):**

```
Hari ini masak apa? → Berapa porsi? → Bahan cukup?
  → Beli apa? → Barang datang? → Ambil bahan → Masak → Selesai berapa porsi?
```

**Fitur strategis** (Nutrisi, Cost, QC, Forecast, AI) **tidak dihapus** — diposisikan di **Management (Phase 3)** agar tidak mengganggu MVP dapur.

| ERP tradisional | Dawam UI |
|-----------------|----------|
| Bill of Material | Resep |
| Production Order | Rencana Produksi |
| MRP | Perhitungan Kebutuhan Bahan |
| Goods Issue | Pengambilan Bahan |
| Production Confirmation | Hasil Produksi |

---

## Keputusan inti

1. **Aggregate Root = Production Plan** (Rencana Produksi).
2. **Business Flow Driven** — alur bisnis → dokumen.
3. Modul di **Inventory App** (bukan Stream E / Manufacturing app).
4. Master item = **`products.itemRole`** (bukan collection Ingredient terpisah).
5. **Kitchen** = nama + gudang default + PIC.
6. PR → **auto Draft CPO**.
7. Stok hanya lewat **`postStockMutation()`** (Phase 0).
8. **Nutrisi · Cost · QC · Forecast · AI** = domain **Management**, Phase 3 — bukan Phase 1–2.
9. **Tanpa** Work Center, Routing, Assembly, Production Line, Org hierarchy di roadmap inti.

---

## Domain (stabil)

```
Food Production
├── Master
│   ├── Ingredient
│   ├── Recipe
│   ├── Menu
│   └── Kitchen
├── Planning
│   ├── Production Plan              ← aggregate root
│   ├── Material Requirement
│   └── Purchase Requirement
├── Operation
│   ├── Material Issue
│   ├── Production Result
│   └── Production Report
└── Management                       ← bukan “Analytics” saja
    ├── Cost Accounting
    ├── Nutrition Analysis
    ├── Quality Control
    ├── Forecasting
    ├── AI Recommendation
    └── Dashboard
```

**Domain stabil.** Roadmap menentukan *kapan* cabang Management diisi — bukan *apakah* dihapus.

---

## Revisi pasca-migrasi Sprint 1–5 (2026-07-28)

Diagram di atas ditulis untuk cakupan Phase 0–3 (2026-07-15) dan tidak pernah di-backfill saat Phase 4/5 menambah Titik Layanan, Distribusi, Cold Chain, HACCP, dan Armada (Sprint 13–24). Eksekusi migrasi `docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md` (Sprint 1–5, selesai 2026-07-28) mengeluarkan sebagian kapabilitas itu ke domain terpisah. Bagian ini mencatat *state* domain saat ini — diagram di atas tetap dipertahankan sebagai catatan sejarah keputusan Phase 0–3, bukan dihapus.

```
Food Production (domain ini)
├── Master
│   ├── Ingredient · Recipe · Menu · Kitchen
├── Planning
│   ├── Production Plan              ← aggregate root
│   ├── Material Requirement
│   └── Purchase Requirement
├── Kitchen Operation
│   ├── Material Issue · Production Result · Production Report
│   ├── Quality Control (QC) — pencatatan tetap di sini (FP_OPS_WRITE_ROLES)
│   ├── Cold Chain (Temperature Log)
│   └── HACCP
├── Dispatch                          ← barang keluar gudang, BUKAN pengiriman fisik
│   └── DispatchDoc (lines, fefoConsume/fefoRestore) — lib/food-production/distribution.ts
└── Management
    ├── Cost Accounting · Nutrition Analysis · Forecasting · AI Recommendation · Dashboard

Shared / Supporting domain (bukan milik Food Production maupun Logistics)
└── Service Point (Destination Master) — lib/food-production/service-point.ts
    Dikonsumsi lintas domain: Dispatch (sizing alokasi) & Logistics/Delivery (routing).
    Sengaja TIDAK dipindah — Sprint 5.3 Decision Record (docs/migration/…, alasan lengkap di sana).
    Kalau nanti direstrukturisasi, target folder BUKAN lib/logistics/ — namespace netral
    (lib/destination/, lib/location/, atau lib/master-data/).

Logistics — domain terpisah, lahir dari pemisahan ini (lihat ADR-003)
├── Armada          — lib/logistics/armada.ts (Sprint 2 Step 2)
├── Delivery         — lib/logistics/delivery.ts: loading/armada/stop/drop, rute (Sprint 5.2)
└── Roles            — lib/logistics/roles.ts: LOGISTICS_DELIVERY_STATUS_ROLES / DRIVER (Sprint 5.4)

Kitchen Assurance — domain terpisah, sudah ada sejak ADR-002 (bukan hasil migrasi ini)
└── Observer/aggregator atas QC/Cold Chain/HACCP milik Food Production di atas — TIDAK memiliki
    data itu. Lihat ADR-002 (revisi klarifikasi Capability Ownership) untuk detail batasnya.
```

**Yang berubah secara konkret**:
- **Distribution/Dispatch/Delivery split** — dokumen `DispatchDoc` (dulu `DistributionOrderDoc`) tetap di `lib/food-production/distribution.ts`; field `loadings`/`armadas` (rute/jam/armada) diekstrak ke `lib/logistics/delivery.ts` sebagai tipe `Delivery*`. Tiga script FEFO (`dist-fefo-ship.ts`, `dist-fefo-shortfall-reconcile.ts`, `dist-return-fefo-shortfall-reconcile.ts`) diverifikasi hanya bergantung pada Dispatch, nol referensi Armada/route/stop — batas ini yang membuat pemisahan aman.
- **Armada** keluar total dari Food Production ke `lib/logistics/armada.ts` (Sprint 2 Step 2) — bukan lagi bagian domain ini.
- **Service Point** dinilai ulang (Sprint 5.3): bukan Kitchen, bukan Dispatch, bukan Logistics secara eksklusif — Destination Master / shared supporting domain. Tetap fisik di `lib/food-production/service-point.ts` untuk sekarang (menghindari churn), tapi klasifikasi konseptualnya sudah dikunci lewat Decision Record, bukan "dilupakan di lokasi lama".
- **QC / Cold Chain / HACCP TIDAK pindah** — tetap kapabilitas Food Production. Yang berubah hanya *siapa boleh membaca untuk apa*: Kitchen Assurance (ADR-002) membaca lewat `getBatchAssuranceTrail()`/`countOpenQcResults()` (`lib/kitchen-assurance/index.ts`, Sprint 2.1) sebagai read-model, bukan pemilik baru.
- **DRIVER role** kepemilikan definisinya pindah ke `lib/logistics/roles.ts` (`LOGISTICS_DELIVERY_STATUS_ROLES`, Sprint 5.4) — rute yang diakses DRIVER tidak berubah.

**Dokumen terkait revisi ini**: [docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md](../migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md) (checklist eksekusi lengkap Sprint 1–5), ADR-002 (revisi klarifikasi Kitchen Assurance), ADR-003 (Logistics Domain, baru).

---

## Business flow operasional

```
Menu / Resep
  → Rencana Produksi
  → Perhitungan Kebutuhan Bahan
  → Purchase Requirement → Draft CPO
  → GRN (barang datang)
  → Pengambilan Bahan
  → Masak
  → Hasil Produksi → Stock Posting (otomatis; approval opsional nanti)
  → Production Report
```

Management tools mengonsumsi data Plan / Result / stok / pembelian — tidak menjadi langkah wajib sebelum memasak.

---

## Model ramping (Phase 0–2)

### Kitchen

Nama · Gudang default · PIC

### `itemRole`

`INGREDIENT` | `FINISHED_GOOD` | `PACKAGING` | `CONSUMABLE`  
(`SEMI_FINISHED` cadangan enum — UI belakangan)

### Production Result (Operation)

Tanggal · Kitchen · Production Plan · Target porsi · Actual porsi · Waste (opsional) · Catatan  
→ **Stock posting otomatis** setelah selesai.

---

## Roadmap

```
Phase 0  Platform Readiness
    ↓
Phase 1  Planning & Procurement
    ↓
Phase 2  Kitchen Operation
    ↓
Phase 3  Management & Intelligence
    ↓
Phase 4  Enterprise Scaling
    ↓
Phase 5  MBG Scale & Compliance  (DONE)
```

### Phase 0 — Platform Readiness

Stock API (`postStockMutation`) · Document helpers tipis · Kitchen · `itemRole` · Job bus siap dipakai

**Target:** Fondasi teknis tanpa menambah kerja Kepala Dapur.

### Phase 1 — Planning & Procurement

Ingredient · Recipe · Menu · Production Plan · Material Requirement · Inventory check · Purchase Requirement · Draft CPO

**Recipe (Sprint 2):** FG product · version · effectiveDate · yield porsi · waste% · lines (productId + qty + satuan)

**Menu (Sprint 2):** version · effectiveDate · items (recipeId + porsi) · targetCostPerPorsi

**Production Plan (Sprint 3):** noDokumen (RPN) · tanggal · kitchen (+ warehouse denorm) · lines (menu × targetPorsi · menuVersion) · status lifecycle · history

**Material Requirement / MRP (Sprint 4):** noDokumen (KBH) · `productionPlanId` · explode Menu→Recipe→bahan · qtyGross / qtyOnHand / qtyNet · shortage

**Target:** Kepala dapur tahu **apa yang harus dibeli**.

### Phase 2 — Kitchen Operation

GRN (reuse) · Material Issue · Cooking (proses dapur) · Production Result · Stock Posting · Production Report

**Cooking (bukan dokumen terpisah):** fase antara PBL `COMPLETED` dan HSL `COMPLETED`, tercermin sebagai plan `PROCESSING`. Tidak ada collection/doc Cooking — hindari double entry untuk dapur.

**Production Report:** agregat read-only Plan + PBL + HSL + fase cooking + integrity gate (`/food-production/report`).

**Target:** Kepala dapur tahu **apa yang sudah dimasak**.

### Phase 3 — Management & Intelligence

Semua yang **penting untuk MBG/ERP/produk**, tanpa mengganggu MVP dapur:

| Area | Isi (arah) |
|------|------------|
| **Cost Accounting** | Standard / actual food cost, cost per porsi, budget vs actual, variance |
| **Nutrition Analysis** | Kalori, protein, karbo, lemak, vitamin, mineral, AKG — dihitung dari Recipe (**inti MBG**) |
| **Quality Control** | Checklist produksi / kebersihan / distribusi · QC result · QC report — sederhana, bisa dicatat dapur (bukan ISO penuh) |
| **Forecasting** | Forecast bahan / pembelian / produksi / budget · horizon 7 / 14 / 30 hari |
| **AI Recommendation** | Bukan chat: saran menu alternatif, supplier lebih murah, pengganti bahan, optimasi stok, prediksi shortage, deteksi boros — berbasis data ERP |
| **Dashboard** | Ringkas per peran (kepala dapur / direktur) |

**Target:** Keputusan manajemen — Powerful for Management.

### Phase 4 — Enterprise Scaling

Multi Kitchen · Central Kitchen · Calendar · Batch · Expiry · API public (+ API keys)

### Phase 5 — MBG Scale & Compliance

Setelah dapur multi-site + API + rekomendasi data siap, fokusasikan ke **skala MBG / kepatuhan / distribusi** tanpa memecah MVP dapur.

| Area | Isi (arah) | Prioritas |
|------|------------|-----------|
| **Titik Layanan / Distribusi** | Master titik makan / sekolah / tray · packing list dari Plan/HSL · status distribusi | P0 |
| **Cold chain & suhu** | Log suhu receiving / cooking / holding · alert threshold · tautan QC | P0 |
| **HACCP / jejak kepatuhan** | Checklist kritis + evidence foto (reuse media) · export audit trail per batch | P1 |
| **SLA & observability FP** | Latency/error rate handler FP · smoke gate CI · dash Ops khusus FP | P1 |
| **Integrasi supplier harga** | Multi-supplier price book · bandingkan CHEAPER_SUPPLY vs catalogue vendor | P1 |
| **Mobile / mode sederhana dapur** | UI sederhana menggunakan (Issue/Result/QC) · offline draft queue (opsional) | P2 |
| **BI export** | Export Cost / Nutrition / Forecast / Recommendations (CSV/Parquet) | P2 |

**Target:** Dapur tetap cepat; manajemen & auditor MBG punya jejak & distribusi yang andal.

**Sprint proposal:**

| Sprint | Isi | Status |
|--------|-----|--------|
| 19 | Titik layanan + packing/distribusi dari Plan/HSL | **DONE (codebase)** |
| 20 | Cold-chain temperature logs + alert | **DONE (codebase)** |
| 21 | HACCP evidence + batch audit export | **DONE (codebase)** |
| 22 | FP observability (Ops) + CI enterprise smoke gate | **DONE (codebase)** |
| 23 | Supplier price book → feed CHEAPER_SUPPLY | **DONE (codebase)** |
| 24 | Mobile-simplified kitchen surfaces (optional) | **DONE (codebase)** |

Perubahan fase / urutan sprint membutuhkan revisi ADR.

---

## Sprint awal

| Sprint | Isi | Status |
|--------|-----|--------|
| 1 | Phase 0 — `postStockMutation`, doc helpers, `itemRole`, Kitchen API/UI | **DONE** |
| 2 | Recipe + Menu | **DONE** |
| 3 | Production Plan | **DONE** |
| 4 | MRP / Material Requirement | **DONE (codebase)** |
| 5 | Purchase Requirement → Draft CPO | **DONE (codebase)** |
| 6 | Material Issue (PBL) + stock OUT | **DONE (codebase)** |
| 7 | Production Result (HSL) + stock IN | **DONE (codebase)** |
| 8 | Nutrition Analysis (MBG) | **DONE (codebase)** |
| 9 | Cost Accounting (standard/actual) | **DONE (codebase)** |
| 10 | Quality Control (checklist) | **DONE (codebase)** |
| 11 | Forecasting 7/14/30 | **DONE (codebase)** |
| 12 | Management Dashboard + rule tips | **DONE (codebase)** |
| 18 | AI Recommendation (rule/data — bukan chat) | **DONE (codebase)** |
| 13 | Multi-Kitchen polish (kode/tipe, scope bar, filter Issue/Result) | **DONE (codebase)** |
| 14 | Central Kitchen + Kitchen Transfer (XFR) | **DONE (codebase)** |
| 15 | Production Calendar | **DONE (codebase)** |
| 16 | Batch + Expiry tracking | **DONE (codebase)** |
| 17 | API public FP + API keys | **DONE (codebase)** |
| 19 | Titik layanan + packing/distribusi (DST) | **DONE (codebase)** |
| 20 | Cold-chain temperature logs + alert | **DONE (codebase)** |
| 21 | HACCP evidence + batch audit export | **DONE (codebase)** |
| 22 | FP observability (Ops) + CI enterprise smoke gate | **DONE (codebase)** |
| 23 | Supplier price book → feed CHEAPER_SUPPLY | **DONE (codebase)** |
| 24 | Mobile-simplified kitchen surfaces | **DONE (codebase)** |

Phase 2 kitchen loop tertutup. Phase 3 Management & Intelligence (Sprint 8–12 + **18 AI Recommendation**) tersedia di host Inventory. Phase 4 Enterprise Scaling (Sprint 13–17) tersedia di host Inventory. Phase 5 MBG Scale & Compliance **selesai** (Sprint 19–24 DONE).

### Sprint 1 deliverables (code)

| Artifact | Path |
|----------|------|
| `itemRole` | `lib/food-production/item-role.ts` + products handler + Produk UI |
| Stock API | `lib/api/stock-mutation.ts` → `postStockMutation()` |
| Doc helpers | `lib/food-production/document.ts` |
| Kitchen | `lib/food-production/kitchen.ts`, `lib/api/handlers/kitchens.ts`, `app/food-production/kitchen/page.tsx` |
| Nav | AppShell group **Food Production** → Dapur |

### Sprint 2 deliverables (code)

| Artifact | Path |
|----------|------|
| Recipe | `lib/food-production/recipe.ts`, `lib/api/handlers/recipes.ts`, `app/food-production/recipe/page.tsx` |
| Menu | `lib/food-production/menu.ts`, `lib/api/handlers/menus.ts`, `app/food-production/menu/page.tsx` |
| Nav | Food Production → Resep, Menu |

### Sprint 3 deliverables (code)

| Artifact | Path |
|----------|------|
| Production Plan | `lib/food-production/production-plan.ts`, `lib/api/handlers/production-plans.ts`, `app/food-production/plan/page.tsx` |
| Doc number | `nextFpDocNumber` → prefix **RPN** |
| Nav | Food Production → Rencana Produksi |

### Sprint 4 deliverables (code)

| Artifact | Path |
|----------|------|
| MRP explode | `lib/food-production/material-requirement.ts` |
| API | `lib/api/handlers/material-requirements.ts` |
| UI | `app/food-production/mrp/page.tsx` (+ tombol dari Plan) |
| Doc number | prefix **KBH** |
| Nav | Food Production → Kebutuhan Bahan |

### Sprint 5 deliverables (code)

| Artifact | Path |
|----------|------|
| Purchase Requirement | `lib/food-production/purchase-requirement.ts` |
| API | `lib/api/handlers/purchase-requirements.ts` (auto Draft CPO) |
| UI | `app/food-production/purchase-requirement/page.tsx` (+ tombol dari MRP) |
| Doc number | prefix **PRB** |
| Nav | Food Production → Kebutuhan Beli |

**Sprint 5 kontrak (gap-closed):**

- Sumber: MRP **APPROVED** dengan shortage (`qtyNet > 0`).
- Create (tx + unique open index): validate period-lock/produk → jika prior DRAFT punya CPO non-supersedable maka **blok** → dalam transaksi supersede DRAFT lama + batalkan Draft CPO → insert CPO+PR. Race → **409**.
- Non-tx fallback (dev standalone): jika insert gagal setelah supersede → **restore** prior DRAFT PR + Draft CPO + hapus orphan CPO baru.
- Unique partial index: satu PR terbuka (`DRAFT|SUBMITTED|APPROVED|PROCESSING`) per `(tenantId, materialRequirementId)`.
- Recreate Draft CPO: atomic insert+update; orphan CPO dibersihkan jika update gagal.
- Batalkan PR → Draft CPO tertaut ikut dibatalkan.
- Deep-link `/pembelian-po?highlight=<cpoId>` (+ `GET /customer-purchase-orders/:id` fallback; highlightDone selalu di-set).
- Write UI gated untuk `ADMIN|OWNER|SUPERVISOR|MASTER` (GUDANG read-only di UI).

### Sprint 6–7 / Phase 2 deliverables (code)

| Artifact | Path |
|----------|------|
| Material Issue | `lib/food-production/material-issue.ts`, `lib/api/handlers/material-issues.ts`, `app/food-production/issue/page.tsx` |
| Production Result | `lib/food-production/production-result.ts`, `lib/api/handlers/production-results.ts`, `app/food-production/result/page.tsx` |
| Production Report | `lib/food-production/production-report.ts`, `handlers/production-reports.ts`, `app/food-production/report` |
| Stock | `postStockMutation` — Issue OUT (`FP_ISSUE`), Result IN (`FP_RESULT`) on **COMPLETED** |
| Doc numbers | **PBL** / **HSL** |
| Nav | Food Production → Pengambilan Bahan, Hasil Produksi, Laporan Produksi |

**Phase 2 kontrak (gap-closed):**

- Issue/Result: `productionPlanId` wajib; plan status `APPROVED|PROCESSING`.
- Satu dokumen terbuka per plan (unique partial index).
- Issue seed dari MRP qtyGross (atau explode); Result seed plan→menu→recipe FG.
- Transisi Issue/Result: `APPROVED → COMPLETED` diizinkan (tanpa wajib lewat `PROCESSING`) agar UI post stok jalan.
- COMPLETED: produk aktif · period-lock (`postingDateFromIso` noon UTC) · **wajib** Mongo replica-set transaction · `postStockMutation`; tanpa session → **fail-closed** (503). Batalkan ditolak setelah COMPLETED.
- Result COMPLETED **hard-gate**: minimal satu PBL `COMPLETED` + tidak ada PBL terbuka.
- Issue COMPLETED → plan `PROCESSING` (+ history otomatis); plan `COMPLETED` hanya jika ada PBL selesai + tidak ada Issue/Result terbuka — berlaku untuk auto (`maybeCompletePlan`) **dan** manual `POST /production-plans/:id/status`.
- Deep-link: Plan/MRP → Issue (`productionPlanId` + `materialRequirementId`); Plan → Result / Laporan.
- UI: filter status/tanggal, riwayat, Suspense `useSearchParams`; `PROCESSING → COMPLETED` tidak dead-end.
- Unique open indexes memakai `FP_OPEN_DOC_STATUSES` (satu sumber kebenaran).
- COMPLETE re-check produk aktif + gate Issue **di dalam** transaksi (TOCTOU).
- Cooking = fold ke plan PROCESSING; Report = agregat read-only (bukan dokumen mutasi).

### Sprint 8–12 / Phase 3 deliverables (code)

| Area | Path |
|------|------|
| Nutrition | `lib/food-production/nutrition.ts`, `handlers/nutrition-profiles.ts`, `app/food-production/nutrition` |
| Cost | `lib/food-production/cost.ts`, `handlers/food-costs.ts`, `app/food-production/cost` |
| QC | `lib/food-production/qc.ts`, `handlers/qc.ts`, `app/food-production/qc` · prefix **QCR** |
| Forecast | `lib/food-production/forecast.ts`, `handlers/food-forecasts.ts`, `app/food-production/forecast` |
| Dashboard | `lib/food-production/dashboard.ts`, `handlers/food-dashboard.ts`, `app/food-production/dashboard` |
| AI Recommendation | `lib/food-production/recommendations.ts`, `handlers/food-recommendations.ts`, `app/food-production/recommendations` |

**Phase 3 kontrak:**

- Gizi bahan di `products.nutrition` (PER_UNIT | PER_100G); analisis Recipe/Menu/Plan + % AKG (`ANAK_SD` / `DEWASA`).
- Cost: standard = resep × `hargaBeli` (+ waste%); actual = PBL completed × `hargaBeli` / actual porsi HSL; variance %.
- QC: template master (auto-seed) + hasil QCR tertaut plan opsional; COMPLETE menolak required FAIL/NA.
  Write checklist/create/submit: `FP_OPS_WRITE_ROLES` (GUDANG+); APPROVE/COMPLETE/CANCEL/template: manage.
- Forecast: histori PBL completed → avg harian × horizon vs on-hand → risk SHORT/LOW/OK.
- Dashboard: KPI + tips rule-based (bukan chat); tautan ke halaman operasional.
- **AI Recommendation (bukan chat):** SHORTAGE, WASTE, STOCK_OPT, SUBSTITUTE, MENU_ALT, CHEAPER_SUPPLY — `GET /api/food-recommendations`; audiens kitchen/management; deep-link CTA.
- Nav Food Production: Gizi, Biaya, QC, Forecast, Rekomendasi, Dashboard FP.

### Sprint 13–17 / Phase 4 deliverables (code)

| Area | Path |
|------|------|
| Kitchen model | `lib/food-production/kitchen.ts` — `kode`, `kitchenType` CENTRAL\|SATELLITE, `centralKitchenId` |
| Kitchen scope | `kitchen-scope.ts`, `acting-kitchen-client.ts`, `KitchenScopeBar` pada Issue/Result/Transfer/Calendar/Batch |
| Transfer (XFR) | `kitchen-transfer.ts`, `handlers/kitchen-transfers.ts`, `/food-production/transfer` |
| Calendar | `production-calendar.ts`, `handlers/production-calendar.ts`, `/food-production/calendar` |
| Batch/Expiry | `production-batch.ts` — stamp on Result COMPLETE; `/food-production/batch` |
| API public | `handlers/fp-public.ts` (`/api/fp-public/*`), scope `food-production:read` |
| API keys | `handlers/api-keys.ts`, `/utiliti/api-keys` |

**Phase 4 kontrak:**

- Dapur: Central tidak boleh punya `centralKitchenId`; satelit boleh link ke Central aktif.
- Scope: query `kitchenId` > header `x-acting-kitchen-id` > semua dapur.
- Transfer: dapur asal ≠ tujuan; warehouse sama → allocation-only (tanpa stok); berbeda → `postStockMutation` OUT/IN `FP_XFER` pada COMPLETE (replica-set tx).
- Calendar: agregat read-only plan per hari (from/to), filter dapur opsional.
- Batch: `batchNo` + `expiryDate` di Result COMPLETE; list FEFO/expiry watch; default shelf life FG 3 hari.
- Public API: keyed client wajib scope `food-production:read`; session manage roles bypass.
- API key: role `INTEGRATION` (bukan ADMIN); hanya `/api/fp-public/*` (+ mint scopes read/integrations saja). Route lain menolak `isApiKey` (dispatch + `resolveOperationalScope` default + `requireRole`).
- `fp-public` plans/results/batches/kitchens: hormati `resolveKitchenIdFilter` (query/header).
- Batch: overdue `ACTIVE` dipersist jadi `EXPIRED` on-read; public batches hanya lot aktif belum lewat expiry.
- XFR COMPLETE: produk aktif di-check (create + in-tx); UI multi-line + batalkan.
- Result COMPLETE: UI kirim `batchNo`/`expiryDate` opsional.
- Plan list (+ UI ScopeBar): hormati `resolveKitchenIdFilter` sama seperti Issue/Result.
- Nav: Kalender, Transfer Dapur, Batch & Expiry (+ Utiliti → API Keys untuk ADMIN/OWNER/MASTER).

### Sprint 19 / Phase 5 (awal) deliverables

| Area | Path |
|------|------|
| Service Point | `lib/food-production/service-point.ts`, `handlers/service-points.ts`, `/food-production/service-point` |
| Distribution (DST) | `lib/food-production/distribution.ts`, `handlers/distribution-orders.ts`, `/food-production/distribution` |
| Doc | `FP_DIST` / prefix **DST** |
| Nav | Titik Layanan, Distribusi (`FP_OPS_ROUTES`) |

**Sprint 19 kontrak:**

- Master titik: kode unik, jenis SEKOLAH/TRAY/TITIK_MAKAN/LAINNYA, dapur penyalur opsional, kapasitas porsi, soft-deactivate (UI + API).
- DST dari Plan (`targetPorsi`) atau HSL COMPLETED (`actualPorsi`); alokasi otomatis berbobot kapasitas (atau equal).
- Jika HSL COMPLETED sudah ada untuk plan → DST harus dari HSL (bukan Plan).
- Over-allocation vs sumber ditolak (termasuk DST non-CANCELLED; baris orphan ditolak; sumber wajib ada).
- Consumed lines scoped ke sumber yang sama (RESULT ≠ Plan) agar key menu vs menu|fg tidak bentrok.
- Alokasi otomatis memakai sisa budget (bukan full source setiap kali).
- Titik harus aktif; jika punya `kitchenId` harus cocok dengan dapur dokumen.
- Status: DRAFT→…→PROCESSING (dikirim)→COMPLETED (diterima) — tidak loncat APPROVED→COMPLETED.
- W2-2: APPROVED→PROCESSING posts FG OUT + FEFO when linked HSL has FG stock (`FP_DIST`); FOOD_TRAY-only (no FG) tetap tanpa mutasi stok.
- W2-3: PROCESSING→COMPLETED with `qtyDikembalikan` restocks FG (`FP_DIST_RETURN`) + restores FEFO from ship allocations.
- Deep-link: Plan/Result → `/food-production/distribution?productionPlanId=` / `productionResultId=` (Plan auto-switch ke HSL bila COMPLETED ada).
- Scope dapur pada list titik/distribusi; write UI gated manage roles.

### Sprint 20 / Phase 5 deliverables

| Area | Path |
|------|------|
| Temperature log + threshold | `lib/food-production/temperature-log.ts`, `handlers/temperature-logs.ts` |
| UI | `/food-production/cold-chain` |
| Nav | Cold Chain (`FP_OPS_ROUTES`) |

**Sprint 20 kontrak:**

- Log suhu stages: RECEIVING / COOKING / HOLDING; `suhuC` wajib; dapur opsional (kitchen scope).
- Default threshold per stage + override tenant (`temperature_thresholds`); `alertStatus` dihitung saat write (OK / WARN / OUT_OF_RANGE / CRITICAL).
- Soft link opsional ke Plan / Batch / QC / Titik Layanan.
- Alert terbuka: `GET /temperature-logs/alerts` (counts via aggregate, items capped); acknowledge `PUT …/:id/ack`.
- Append-mostly (tidak edit °C); tanpa mutasi stok.
- Write log: `FP_OPS_WRITE_ROLES` (termasuk GUDANG); threshold CRUD: manage roles; one-off min/max divalidasi `normalizeThresholdNumbers`.
- Sandbox: purge `temperature_logs`, keep `temperature_thresholds`.
- Threshold field kosong (`null`) meng-$unset override → kembali ke default stage.

### Sprint 21 / Phase 5 deliverables

| Area | Path |
|------|------|
| HACCP template + result | `lib/food-production/haccp.ts`, `handlers/haccp.ts`, `/food-production/haccp` |
| Batch audit trail | `lib/food-production/batch-audit-trail.ts`, `GET /production-batches/:id/audit-trail` |
| Doc | `FP_HACCP` / prefix **HCP** |
| Nav | HACCP (`FP_OPS_ROUTES`); export trail di Batch |

**Sprint 21 kontrak:**

- Template CCP (seed HCP-COOK/COOL/HOLD) + result per `productionBatchId` wajib.
- Evidence foto via `storeBase64Image` (prefix `haccp`) — URL di dokumen, bukan base64 di Mongo.
- Soft gate COMPLETE: required PASS + `needsPhoto` punya evidence.
- Write checklist: `FP_OPS_WRITE_ROLES` (GUDANG+); COMPLETE/CANCEL/template: manage roles.
- Export trail batch (JSON/CSV): Plan + HSL + temp logs + QC + HACCP + audit_log terkait; manage roles; CSV formula-safe.
- Seed template idempotent (race 11000 ditelan); insert result tangani bentrok noDokumen (409).
- Sandbox: purge `haccp_results`, keep `haccp_templates`.
- Tanpa mutasi stok.
- Soft gate photo: doc-level evidence memenuhi `needsPhoto` (UI capture di level dokumen).

### Sprint 22 / Phase 5 deliverables

| Area | Path |
|------|------|
| Request metrics | `lib/api/request-metrics.ts` |
| Timing | `app/api/[[...path]]/route.ts` (`api_slow_request`, FP duration) |
| Ops FP panel | `handlers/ops-dashboard.ts` → `fpObservability`, `/utiliti/ops` |
| CI smoke | `npm run test:fp:enterprise` (+ CI step) |

**Sprint 22 kontrak:**

- Catat latency FP route → bucket (issue/result/plan/haccp/…) + p50/p95; slow >2s → `api_slow_request`.
- Ring failure FP (5xx) di memori proses; tampil di Ops MASTER.
- Hotpath SLO (issue/result/plan/transfer/haccp) p95 vs 2000ms.
- Enterprise smoke gate eksplisit di CI (`test:fp:enterprise`).

### Sprint 23 / Phase 5 deliverables

| Area | Path |
|------|------|
| Price book | `lib/food-production/supplier-price-book.ts`, `handlers/supplier-price-book.ts` |
| UI | `/food-production/price-book` (`FP_MGMT_ROUTES`) |
| Recs | `recommendCheaperSupply` prefer book vs GRN |

**Sprint 23 kontrak:**

- Master harga multi-supplier (`supplier_price_book`); unique aktif per (supplier, product).
- Effective window + soft deactivate; CRUD manage; GET mgmt read.
- CHEAPER_SUPPLY: bandingkan `hargaBeli` vs best book (prioritas) dan/atau GRN terakhir (≥8%).
- Sandbox: keep `supplier_price_book`. Options/list endpoint mendukung `?q=` search.

### Sprint 24 / Phase 5 deliverables

| Area | Path |
|------|------|
| Hub | `/food-production/mobile` (`FP_OPS_ROUTES`) |
| Surfaces | `/food-production/mobile/issue`, `…/result`, `…/qc` |
| API | Reuse `material-issues` / `production-results` / `qc-results` (tanpa endpoint baru) |

**Sprint 24 kontrak:**

- UI sederhana menggunakan touch-first untuk Issue / Result / QC; tombol status besar; fokus hari ini.
- Tidak menambah mutasi stok baru — sama gate role & API dengan halaman penuh.
- Offline draft queue **opsional / dilewati** (tidak wajib di sprint ini).
- Nav: Mode Dapur di Food Production ops.

---

## Yang tidak dikembalikan

Work Center · Routing · Assembly · Operation Sequence · Production Line · Business-rules novel · Manufacturing compatibility package.

Yang diubah posisi (bukan dihapus): **Nutrition, Cost, QC, Forecast, AI** → Phase 3 Management.

---

## Coding standards (ringkas)

1. Fitur Phase 1–2: “Apakah operator/kepala dapur memakai ini hari ini untuk masak & beli?”  
2. Fitur Phase 3: boleh kaya, tapi **jangan** memblokir alur Issue/Result.  
3. Nutrisi & cost dihitung dari Recipe (+ actuals dari Result/GRN) — satu sumber kebenaran master.  
4. AI = rekomendasi berbasis data, bukan chatbot wajib di dapur.  
5. Nav/roles: Operator (GUDANG) lihat Master/Planning/Operation **+ QC** (dapur mencatat); Management/Cost/Nutrition/Forecast/AI/Dashboard gated `SUPERVISOR|ADMIN|OWNER|MASTER` (API + nav).  
6. Aggregate commands mereferensikan `productionPlanId` bila terkait transaksi produksi.

---

## Konsekuensi

- MVP dapur tetap tipis dan cepat dipakai.
- Visi produk (Nutrisi MBG, Cost ERP, QC pangan, Forecast, AI) tetap di blueprint resmi.
- Perubahan yang memindahkan Management ke Phase 1, atau mengembalikan manufaktur penuh, butuh revisi ADR.

## Dokumen terkait

- [REGISTER.md](./REGISTER.md)
- Sales execution platform (job bus)
- Canvas: workspace `canvases/adr-001-food-production-blueprint.canvas.tsx`
