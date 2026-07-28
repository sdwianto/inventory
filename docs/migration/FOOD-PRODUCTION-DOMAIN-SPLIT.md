# Migration Execution Plan — Food Production Domain Split

> **Ini bukan ADR, bukan spesifikasi.** Ini checklist kerja harian. ADR-001 (Food Production Domain) dan ADR-002 (Kitchen Assurance) sengaja **belum** diamandemen — diperbarui setelah migrasi selesai (Sprint 4+), bukan sekarang.

**Status**: Living checklist — centang per item.
**Prinsip #1**: operator-first, bukan folder-first. Tujuan bukan memindahkan kode — tujuannya operator SPPG tidak merasa menjalankan SIPGN + Inventory + Food Production sebagai sistem terpisah.
**Prinsip #2**: *"Decouple Kitchen Assurance first, extract implementation second."* Boundary (kontrak fungsi) dipindah duluan; lokasi file menyusul kapan saja tanpa mematahkan siapa pun.

---

## Target akhir yang operator SPPG lihat

```
INVENTORY SPPG
1. Pengadaan     — Supplier, PO, Receiving
2. Persediaan    — Stok, Batch & Expiry, FEFO, Transfer/Adjustment
3. Produksi      — Menu, Recipe, Production Plan, Kebutuhan Bahan, Pengeluaran Bahan, Hasil Produksi
4. Distribusi    — Jumlah porsi, tujuan, barang keluar (bukan armada/rute/driver)
```

Tidak terlihat operator (bukan dihapus — bukan tanggung jawab mereka): QC, HACCP, Cold Chain, Armada, Forecast, Recommendation, Route Planning, Driver.

---

## Sprint 1 — Operator Simplification *(operator langsung merasakan perubahan, belum ada refactor besar)*

**STEP 0 — Freeze scope + bersihkan UI** *(1 hari, belum menyentuh backend)*

Edit `components/AppShell.tsx` saja:

- [x] Hide dari `NAV` array (pola sama seperti `Transfer Dapur disembunyikan`, route/API tetap hidup): `Quality Control`, `Cold Chain`, `HACCP`, `Armada`, `Forecast Bahan`, `Rekomendasi`
- [x] Keluarkan `qc`, `cold-chain`, `haccp`, `armada` dari `FP_OPS_ROUTES` — ini yang benar-benar memutus akses default role `GUDANG`. *(Koreksi: `forecast`/`recommendations` tidak pernah ada di `FP_OPS_ROUTES` — keduanya di `FP_MGMT_ROUTES`, dan `GUDANG` memang sudah tidak pernah diberi `FP_MGMT_ROUTES`. Perubahan untuk keduanya murni NAV visual, bukan permission migration.)*
- [x] **Tetap tampil** (tidak diubah): Kitchen, Recipe, Menu, Plan, MRP, Issue, Result, Report, Calendar, Batch, **Distribution (sementara — lihat catatan Sprint 4)**
- [x] Freeze Food Production feature development mulai efektif
- [x] Cleanup unused icon import (`Car`, `Thermometer`, `ShieldCheck`, `BadgeCheck`, `Lightbulb`) — konsekuensi langsung dari penghapusan NAV item, bukan scope tambahan

Efek yang diharapkan: operator role `GUDANG` login besok → sidebar Food Production hanya berisi item alur inti, tidak ada lagi "kenapa ada menu HACCP/QC/armada/forecast?"

### Sprint 1 Exit Verification

- [x] GUDANG hanya melihat alur Procurement → Production → Dispatch
- [x] QC/Cold Chain/HACCP/Armada tidak muncul di NAV GUDANG
- [x] Route/API lama tetap hidup (backward compatible) — tidak ada file di `app/food-production/{qc,cold-chain,haccp,armada}/` atau handler yang diubah/dihapus
- [x] Tidak ada perubahan collection/database
- [x] Tidak ada perubahan FEFO/Distribution logic
- [x] Unused import dibersihkan

**Baseline untuk sprint berikutnya**: Sprint 1 = UI boundary change · Sprint 2 = Contract boundary change · Sprint 3 = Core cleanup · Sprint 4 = Domain extraction.

**Commit** (tunggal, terpisah dari Sprint 2 — supaya audit history tidak kabur):
```
refactor(food-production): simplify operator navigation boundary
```
Isi: `components/AppShell.tsx` saja. Jangan digabung dengan `kitchen-assurance/index.ts`, adapter, extract Armada, atau perubahan docs ADR — itu masuk commit Sprint 2 terpisah.

**Status Sprint 1**: ✅ DONE (setelah commit di atas).

---

## Sprint 2 — Boundary Cleanup *(kontrak dulu, bukan pindah file)*

**STEP 1 — Kitchen Assurance boundary (bukan extract file)** — ✅ DONE

⚠️ **Koreksi dari rencana awal, ditemukan saat implementasi**: kontrak `getBatchAssuranceStatus()` (status ringkas PASS/FAIL) **tidak cocok** dengan pemakaian nyata. `production-batches.ts` tidak butuh status ringkas — dia menyusun **audit trail kronologis per event** (tiap baris temp log, tiap dokumen QC, tiap dokumen HACCP, dengan timestamp/summary/statusOrAlert masing-masing) untuk export CSV/JSON, memakai tipe `BatchTrailEvent[]` yang sudah ada di `batch-audit-trail.ts`. Kontrak yang dibuat disesuaikan dengan pemakaian nyata, bukan tebakan awal:

- [x] Dibuat `lib/kitchen-assurance/index.ts` — `getBatchAssuranceTrail(db, scopeAuth, { productionBatchId, productionPlanId })` → `{ events: BatchTrailEvent[], entityIds: string[] }`. Implementasi di dalamnya masih query `qc_results`/`temperature_logs`/`haccp_results` di lokasi lama (`lib/food-production/*`) — sesuai prinsip "boundary dulu, folder belakangan"
- [x] `lib/api/handlers/production-batches.ts` tidak lagi impor/query `QC_RESULTS_COLLECTION`/`TEMPERATURE_LOGS_COLLECTION`/`HACCP_RESULTS_COLLECTION` sama sekali — diganti satu panggilan `getBatchAssuranceTrail()`. `entityIds` (untuk korelasi `audit_log`) juga sekarang datang dari kontrak ini, bukan di-assemble manual dari 3 list terpisah
- [x] Verifikasi: `tsc --noEmit` clean (0 error) di seluruh project setelah perubahan
- [ ] *(Belum dikerjakan, boleh menyusul kapan saja — tidak wajib bersamaan)*: `kitchen-assurance/attention.ts`/`analytics.ts`/`reports.ts`/`adapters/cold-chain.ts` masih baca `temperature-log.ts` langsung, belum lewat kontrak baru ini — beda kebutuhan (mereka butuh signal real-time untuk monitoring, bukan trail historis), jadi TIDAK di-refactor di step ini, dicatat sebagai potensi penyelarasan lanjutan
- [x] *(Production Result tetap tidak disentuh — terbukti tidak coupled ke QC/ColdChain/HACCP sama sekali, tidak butuh adapter apa pun)*

**Commit terpisah untuk Step 1** (jangan gabung dengan Armada/Step 2):
```
refactor(kitchen-assurance): decouple production-batches from QC/temp-log/HACCP collections
```
Isi: `lib/kitchen-assurance/index.ts` (baru), `lib/api/handlers/production-batches.ts`.

**STEP 2 — Extract Armada** *(risiko: Rendah — 1 consumer, tidak menyentuh transaksi stok)*

- [x] Pindahkan `lib/food-production/armada.ts` (collection `armadas`) → `lib/logistics/armada.ts` — isi identik, hanya header komentar ditambah
- [x] Pindahkan `app/food-production/armada/page.tsx` → `app/logistics/armada/page.tsx` (URL baru: `/logistics/armada`) — isi identik, hanya 1 baris impor diubah
- [x] `lib/api/handlers/armadas.ts` **tidak dipindah lokasi** (koreksi dari rencana awal) — konvensi `lib/api/handlers/*` di repo ini flat, tidak ada subfolder per-domain untuk handler manapun (termasuk Kitchen Assurance). Yang diubah hanya impor internalnya, dari `@/lib/food-production/armada` → `@/lib/logistics/armada`. API route `/api/armadas` tidak berubah — konsumen page tidak perlu tahu.
- [x] Update konsumen: `lib/api/handlers/distribution-orders.ts` (impor `ARMADAS_COLLECTION`) — dan **1 konsumen tambahan yang ditemukan saat sweep akhir**, tidak tercatat di rencana awal: `<Link href="/food-production/armada">` di `app/food-production/distribution/page.tsx` (baris "Belum ada armada aktif — Buat armada dulu") → diupdate ke `/logistics/armada`
- [x] Nav: grup baru **Logistics** ditambahkan di `AppShell.tsx` (`key: 'logistics'`) berisi Armada — sebelumnya di Sprint 1 armada cuma "disembunyikan", sekarang benar-benar punya rumah baru. Role `SUPERVISOR`/`ADMIN`/`OWNER` diberi akses (`LOGISTICS_ROUTES`, konsisten dengan hak akses armada sebelum Sprint 1); `GUDANG` tetap tidak diberi, sesuai tujuan operator-simplification
- [x] Tidak ada perubahan logika bisnis — murni pindah lokasi + 1 link diupdate
- [x] Verifikasi: `tsc --noEmit` clean (0 error) setelah seluruh perubahan; sweep repo-wide untuk `food-production/armada` mengonfirmasi tidak ada referensi tersisa (kecuali komentar historis di file baru)

**Commit terpisah untuk Step 2** (jangan gabung dengan Step 1):
```
refactor(logistics): extract armada domain from food-production
```
Isi: `lib/logistics/armada.ts` (baru), `app/logistics/armada/page.tsx` (baru), hapus `lib/food-production/armada.ts` + `app/food-production/armada/page.tsx`, `lib/api/handlers/armadas.ts`, `lib/api/handlers/distribution-orders.ts`, `app/food-production/distribution/page.tsx`, `components/AppShell.tsx`.

**Status Sprint 2 Step 2**: ✅ DONE.

---

## Sprint 3 — Food Production Core Cleanup — ✅ DONE

- [x] **Rapikan MRP embedded ke Plan** — diverifikasi, sudah bersih. `app/food-production/mrp/page.tsx` tetap redirect murni ke `/food-production/plan`; sweep `grep "Kebutuhan Bahan"` di seluruh `app`/`components` tidak menemukan referensi standalone lain. Tidak ada perubahan kode, murni verifikasi.
- [x] **`rencana-kebutuhan.ts` vs `material-requirement.ts`** — diinvestigasi, **tidak dikonsolidasi** (koreksi dari rencana awal). Bukan duplikasi murni: `rencana-kebutuhan.ts` mengagregasi **banyak Plan sekaligus** untuk preview/print (`buildRencanaKebutuhanLines(plans: [...])`), sedangkan `material-requirement.ts`'s `explodeMaterialRequirements()` bekerja per **satu Plan** untuk dokumen MRP resmi. Keduanya sudah pure function dan sudah berbagi helper level-bawah (`scaleRecipeIngredientQty`, `roundQty`). Konsolidasi yang aman berarti menulis ulang loop multi-plan agar memanggil `explodeMaterialRequirements()` per plan lalu digabung — refactor nyata, bukan sekadar hapus duplikasi, berisiko mengubah angka kebutuhan bahan. **Ditunda**, tetap tercatat sebagai technical debt "kerjakan kapan longgar" sesuai rencana awal — sengaja tidak dipaksakan di sesi ini.
- [x] `portion-target.ts` — dikonfirmasi tetap Core, ditambahkan doc-comment header resmi di file (bukan hanya di dokumen migrasi)
- [x] Hapus stub kosong `app/food-production/mobile/{issue,qc,result}` — dikonfirmasi ada test regresi (`food-production-phase5-sprint24.test.ts`) yang justru **menegaskan** file-file itu seharusnya sudah tidak ada; penghapusan folder kosong konsisten dengan intent yang sudah terdokumentasi, test tetap hijau (4/4) setelahnya
- [x] Dashboard: `food-dashboard.ts` KPI `openQc` tidak lagi query `QC_RESULTS_COLLECTION` langsung — diganti `countOpenQcResults(db, scopeAuth)`, fungsi baru di `lib/kitchen-assurance/index.ts` (kontrak Sprint 2 Step 1 diperluas dengan consumer kedua)
- [x] **Ditemukan & diperbaiki di luar rencana**: `tests/unit/food-production-enterprise-gate.test.ts` sudah **pecah sejak Sprint 1** (bukan dari Sprint 3) — test lama menjaga `/food-production/cold-chain`/`/food-production/haccp` tetap ada di `AppShell.tsx`, padahal Sprint 1 sengaja menghapusnya. Test diupdate untuk menjaga arsitektur baru (QC/Cold Chain/HACCP/Armada keluar dari `FP_OPS_ROUTES`, grup nav Logistics ada) alih-alih membatalkan migrasi
- [x] Verifikasi: `tsc --noEmit` clean (0 error); seluruh 14 file test `food-production-*` hijau (termasuk yang diperbaiki); 12 test gagal lain (`w2-1`/`w2-4`/`w2-5`/`w2-7`/dll.) dikonfirmasi **tidak terkait** — `ReferenceError: crypto is not defined` di package `uuid`, masalah environment pre-existing

**Commit terpisah untuk Sprint 3** (jangan gabung dengan Sprint 1/2):
```
refactor(food-production): Sprint 3 core cleanup — mobile stub, portion-target docs, dashboard KA boundary
```
Isi: hapus `app/food-production/mobile/`, `lib/food-production/portion-target.ts`, `lib/api/handlers/food-dashboard.ts`, `lib/kitchen-assurance/index.ts`, `tests/unit/food-production-enterprise-gate.test.ts`.

**Status Sprint 3**: ✅ DONE — kecuali item `rencana-kebutuhan.ts` konsolidasi yang sengaja ditunda (technical debt, tidak menghambat).

---

## Sprint 4 — Dispatch Mental Model *(Tahap 1 saja — ✅ DONE, checkpoint)*

```
Sprint 4
──────────────
✔ Mental model established     — komentar "Inventory Dispatch Document" di distribution.ts
✔ FEFO independence verified   — diverifikasi ulang (bukan diasumsikan): 3 script FEFO nol
                                  referensi armada/driver/route/stop
✔ Documentation updated        — docs/migration ini + header file
✔ Regression green             — tsc clean, 12/12 test distribution/FEFO (w2-2/w2-3/w2-14)
──────────────
STOP — jangan lanjut ke rename/ekstraksi di sprint yang sama
```

- [x] Tambahkan komentar dokumentasi di `lib/food-production/distribution.ts` (mental model, bukan rename tipe)
- [x] Verifikasi ulang independensi FEFO terhadap armada/route/stop/driver (regression, bukan asumsi baru)
- [x] `tsc --noEmit` clean + 12/12 test distribution/FEFO hijau

**Kenapa berhenti di sini (bukan keterbatasan teknis)**: rename (`DistributionOrderDoc`→`DispatchDoc`) adalah **pekerjaan bahasa, bukan pekerjaan teknis** — begitu istilah "Dispatch" dipakai di kode, seluruh tim harus otomatis membaca "Dispatch = dokumen inventory", bukan "Dispatch = pengiriman truck". Kalau bahasa itu belum jadi acuan bersama, rename hanya menambah friksi review. Mental model perlu "mengendap" dulu sebelum struktur berubah.

**Commit untuk Sprint 4 Tahap 1** (perubahan komentar di file implementasi, bukan docs-only):
```
refactor(distribution): clarify inventory dispatch boundary
```
Isi: `lib/food-production/distribution.ts` (komentar mental model).

**Status Sprint 4 Tahap 1**: ✅ DONE. Rename tipe, ekstraksi Logistics, dan pemindahan Service Point **sengaja dipindah ke Sprint 5** — lihat di bawah, bukan dikerjakan di sprint yang sama.

---

## Sprint 5 — Dispatch/Logistics Rename & Extraction

**Gerbang dibuka**: prasyarat "mental model sudah jadi acuan tim" dinyatakan terpenuhi oleh Principal. Dikerjakan bertahap 5.1 → 5.2 → 5.3 → 5.4, masing-masing commit terpisah dengan satu tujuan, bukan satu refactor besar.

### Sprint 5.1 — Rename language — ✅ DONE

Target: selaraskan ubiquitous language, **tanpa** pindah folder, **tanpa** ubah behavior.

Tipe yang di-rename (envelope dokumen — genuinely domain Dispatch/Inventory per mental model Sprint 4):
- `DistributionOrderDoc` → `DispatchDoc`
- `DistributionSourceType` → `DispatchSourceType`
- `DistributionStatus` → `DispatchStatus`
- `DistributionLine` → `DispatchLine`

**Sengaja TIDAK di-rename** (nested types — domain Delivery/Logistics per mental model, menunggu ekstraksi fisik di 5.2 baru dapat nama yang pas di konteks Logistics, bukan "Dispatch*" yang salah domain): `DistributionLoading`, `DistributionArmada`, `DistributionArmadaStop`, `DistributionStopDrop`, `buildDistributionLoadings`, `buildDistributionArmadas`. Juga **tidak** disentuh: nama file (`distribution.ts`, sesuai "tidak ada perpindahan folder"), dan `DISTRIBUTION_ORDERS_COLLECTION`/collection Mongo `distribution_orders` (rename storage adalah langkah terpisah paling akhir, di luar Sprint 5.1).

- [x] Katalog lengkap 9 export bernama `Distribution*` di `distribution.ts` — 4 di-rename, 5 dibiarkan (lihat pembagian di atas)
- [x] 7 file consumer diupdate: `lib/food-production/distribution.ts`, `dist-fefo-ship.ts`, `lib/api/dist-fefo-shortfall-reconcile.ts`, `lib/api/dist-return-fefo-shortfall-reconcile.ts`, `lib/api/handlers/distribution-orders.ts`, `app/food-production/distribution/page.tsx`, `components/food-production/DistributionScheduleDocument.tsx`
- [x] Verifikasi: sweep repo-wide untuk 4 nama lama mengonfirmasi nol residu; `tsc --noEmit` clean (0 error); 41/41 test terkait hijau (`w2-2`/`w2-3`/`w2-14`-distribution-fefo, `food-production-enterprise-gate`, `food-production-phase5-sprint19`)
- [x] Test files dicek terpisah — tidak ada test yang mengimpor tipe-tipe ini langsung (semua lewat runtime/collection), jadi tidak perlu diedit

**Commit untuk Sprint 5.1** (rename saja, tidak dicampur logic change):
```
refactor(distribution): rename document envelope types to Dispatch (Sprint 5.1)
```
Isi: 7 file di atas.

**Status Sprint 5.1**: ✅ DONE.

### Sprint 5.2 — Logistics extraction — ✅ DONE

**Koreksi lingkup, penting dibaca sebelum Sprint 5.3**: rencana awal menyebut *"referensi ke `DispatchDoc` via `dispatchId` (FK), tidak mewarisi struktur"*. Yang benar-benar dieksekusi adalah **ekstraksi tipe/fungsi ke modul terpisah** (`lib/logistics/delivery.ts`), **bukan** pemisahan storage/collection. `DispatchDoc.loadings`/`DispatchDoc.armadas` tetap embedded di dokumen/collection yang sama (`distribution_orders`) — belum ada collection `deliveries` baru, belum ada `dispatchId` FK sungguhan. Alasan: builder Logistics (`buildDeliveryLoadings`) butuh snapshot penuh `DispatchLine[]` (qtyPorsi, porsiByKategori, kapasitasPorsi, jamKirim) untuk menyusun rute — bukan sekadar ID — jadi ini domain **referensi tipe**, bukan referensi storage. Pemisahan collection sungguhan (dengan migration script + rewrite handler untuk atomic write) adalah pekerjaan terpisah, lebih besar, di luar langkah ini.

Konsekuensi teknis yang jujur perlu dicatat: `lib/logistics/delivery.ts` meng-import `type DispatchLine` + `scalePorsiByKategoriForQty` dari `distribution.ts`, dan `distribution.ts` meng-import `DeliveryLoading`/`DeliveryArmada` dari `lib/logistics/delivery.ts` (untuk field `DispatchDoc.loadings`/`.armadas` serta signature `summarizeDistLines`). Ini adalah **circular import yang disengaja** — bukan kesalahan desain, karena arah data memang dua arah: Logistics butuh snapshot Dispatch untuk membangun rute, Dispatch butuh tipe Delivery untuk merepresentasikan jadwal yang sudah tertanam di dokumennya. Aman secara runtime (hanya deklarasi fungsi/tipe di top-level, tidak ada eksekusi saat modul dimuat).

- [x] Ekstrak `DistributionLoading`→`DeliveryLoading`, `DistributionArmada`→`DeliveryArmada`, `DistributionArmadaStop`→`DeliveryArmadaStop`, `DistributionStopDrop`→`DeliveryStopDrop`, `DistLoadingInput`→`DeliveryLoadingInput`, `DistLoadingArmadaInput`→`DeliveryArmadaAssignmentInput` + fungsi `resolveDistLoadings`→`resolveDeliveryLoadings`, `loadingLabel`→`deliveryLoadingLabel`, `splitStopIntoDrops`, `sumPorsiByKategoriMaps`, `buildDistributionLoadings`→`buildDeliveryLoadings`, `buildDistributionArmadas`→`buildDeliveryArmadas` ke `lib/logistics/delivery.ts` (file baru)
- [x] `scalePorsiByKategoriForQty` **sengaja tetap** di `distribution.ts` (tidak ikut pindah) — dipakai baik oleh Dispatch-domain code (`allocatePorsiAcrossPoints`, alokasi porsi lintas titik layanan) maupun Delivery-domain code (`splitStopIntoDrops`, `buildDeliveryLoadings`); memindahkannya hanya akan membalik arah coupling, bukan menghilangkannya
- [x] `distLineKey` **sengaja tetap** di `distribution.ts` — dipakai 9× untuk identitas baris Dispatch umum (`normalizeDistLines`, settle/actuals), tidak spesifik Loading/Armada
- [x] `DispatchDoc.loadings`/`.armadas` field types diupdate ke `DeliveryLoading[]`/`DeliveryArmada[]`; `summarizeDistLines` opts type diikutkan
- [x] 4 consumer diupdate: `lib/api/handlers/distribution-orders.ts`, `app/food-production/distribution/page.tsx`, `components/food-production/DistributionScheduleDocument.tsx`, `tests/unit/food-production-phase5-sprint19.test.ts`
- [x] Verifikasi: sweep repo-wide untuk nama lama (`Distribution{Armada,Loading,StopDrop}`, `DistLoading*Input`, `buildDistribution*`, `resolveDistLoadings`, bare `loadingLabel`/`splitStopIntoDrops`/`sumPorsiByKategoriMaps`) mengonfirmasi nol residu di luar `lib/logistics/delivery.ts` sendiri; `tsc --noEmit` clean (0 error); 41/41 test terkait hijau (`w2-2`/`w2-3`/`w2-14`-distribution-fefo, `food-production-enterprise-gate`, `food-production-phase5-sprint19`)
- [x] Masih **tanpa** menyentuh Service Point — sesuai batas yang disetujui

**Commit untuk Sprint 5.2** (extraction saja, tidak dicampur Sprint 5.3):
```
refactor(logistics): extract delivery loading/armada domain from distribution
```
Isi: `lib/logistics/delivery.ts` (baru), `lib/food-production/distribution.ts`, `lib/api/handlers/distribution-orders.ts`, `app/food-production/distribution/page.tsx`, `components/food-production/DistributionScheduleDocument.tsx`, `tests/unit/food-production-phase5-sprint19.test.ts`.

**Status Sprint 5.2**: ✅ DONE.

### Sprint 5.3 — Service Point assessment — ✅ DONE (domain assessment, bukan refactor)

**Audit ulang (bukan asumsi lama)**: klaim dependency audit sebelumnya — "Service Point menyentuh Distribution, Kitchen, Production, Portal, Planning, Delivery, Reporting, Dashboard" — **tidak terbukti** saat di-grep ulang terhadap kode aktual pasca-Sprint 5.2. Konsumen nyata `lib/food-production/service-point.ts` hanya: `service-points.ts` handler + halamannya sendiri (CRUD), Dispatch (`distribution.ts`, `distribution-orders.ts`, halaman & dokumen cetak distribusi — butuh `kapasitasPorsi`/`porsiByKategori` untuk sizing alokasi), `lib/logistics/delivery.ts` (butuh `jamKirim`/`drops` untuk menyusun rute), dan `temperature-logs.ts` (Kitchen Assurance, tag lokasi cold-chain). Tidak ada coupling ke dashboard, report, forecast, recommendations, portal (`fp-public`), atau kitchen/plan module.

**Temuan arsitektural** (bukan sekadar hasil grep, tapi kesimpulan domain): `ServicePointDoc` sendiri terbelah dua secara struktural — `alamat`/`pic`/`picNoTelp`/`jamKirim`/`drops` adalah data tujuan pengiriman (bentuknya identik dengan konsep destination Logistics), sedangkan `kapasitasPorsi`/`porsiByKategori` adalah input perencanaan alokasi (kebutuhan Dispatch). `kitchenId` cuma tautan balik ke dapur sumber, bukan bukti kepemilikan Kitchen.

**Keputusan (Decision Record)** — ditetapkan oleh Principal, bukan hasil default algoritmik:

> **Service Point bukan subdomain Logistics maupun Dispatch. Ia adalah *shared supporting domain* yang merepresentasikan Destination Master**, dikonsumsi lintas domain (Dispatch untuk sizing, Logistics untuk routing, Kitchen Assurance untuk tagging lokasi) tanpa dimiliki eksklusif oleh satu pun.

Konsekuensi keputusan ini:
- [x] **Tidak ada refactor kode.** `lib/food-production/service-point.ts` **tetap di lokasi sekarang** — bukan karena alasan historis/kemalasan, tapi karena "shared supporting domain, dikonsumsi lintas domain" berarti belum ada pemilik tunggal yang berhak menariknya ke folder domainnya. Memindahkan ke `lib/logistics/` (asumsi awal sebelum assessment) akan salah — itu akan membuat Dispatch bergantung pada folder Logistics untuk data perencanaan alokasinya sendiri, kebalikan dari tujuan pemisahan domain.
- [x] **Target restrukturisasi folder di masa depan, jika terjadi, BUKAN `lib/logistics/`** — melainkan namespace netral: `lib/destination/`, `lib/location/`, atau `lib/master-data/` (dipilih nanti sesuai arah arsitektur jangka panjang, bukan sekarang).
- [x] Status konseptual di dokumen ini diperbarui: Service Point diklasifikasikan sebagai **Destination Master / Shared Supporting Domain**, bukan Kitchen/Dispatch/Logistics.

**Kenapa ini hasil yang baik, bukan jalan buntu**: assessment ini membuktikan bahwa asumsi awal ("Service Point kemungkinan milik Logistics", tercermin di frasa Sprint 5.3 versi sebelumnya) **tidak didukung model domain aktual**. Sprint 5.3 selesai sebagai *domain assessment* murni — outputnya adalah keputusan tertulis, bukan file yang berpindah, persis skenario yang sudah diantisipasi di rencana awal ("Kalau belum jelas, biarkan di tempatnya").

### Sprint 5.4 — Role cleanup — ✅ DONE

- [x] `FP_DIST_STATUS_ROLES` (`lib/food-production/roles.ts`) dipindah + di-rename jadi `LOGISTICS_DELIVERY_STATUS_ROLES` di `lib/logistics/roles.ts` (file baru). Isi role-set tidak berubah (`DRIVER`, `ADMIN`, `OWNER`, `SUPERVISOR`, `MASTER`) — yang pindah adalah kepemilikan konseptual: mengatur siapa yang boleh mengeksekusi aksi fisik pengiriman (status Dikirim/Selesai) adalah keputusan Logistics, meski dokumen yang dimutasi (`DispatchDoc`) tetap milik Dispatch
- [x] Konsumen diupdate: `lib/api/handlers/distribution-orders.ts` (authorization check status transition), `app/food-production/distribution/page.tsx` (`STATUS_ROLES` UI gate — sebelumnya literal `'DRIVER'` ter-duplikasi lokal, sekarang mengacu ke satu sumber kebenaran `LOGISTICS_DELIVERY_STATUS_ROLES`)
- [x] `components/AppShell.tsx` — **tidak ada perpindahan route**. Ditambahkan komentar di blok `ROLE_PERMISSIONS.DRIVER` mendokumentasikan kenapa: Service Point tetap Destination Master/shared (Sprint 5.3), Distribution tetap route Dispatch (belum di-rename), sehingga rute yang diakses DRIVER tidak berubah — yang berubah cuma kepemilikan role-set di kode
- [x] **Diaudit, bukan dikerjakan ulang**: nav `Jadwal Pengiriman` (`/food-production/distribution`) sudah punya pemisahan tampilan operator vs manajemen sejak sebelum Sprint 5 — `canManage` (ADMIN/OWNER/SUPERVISOR/MASTER, sekarang identik dengan `LOGISTICS_DELIVERY_STATUS_ROLES` dikurangi DRIVER) menggerbangi create/edit/assign loading-armada; `canUpdateStatus`/`STATUS_ROLES` (`LOGISTICS_DELIVERY_STATUS_ROLES` — termasuk DRIVER) hanya menggerbangi tombol ubah status. GUDANG tidak masuk kedua set ini → read-only. Hasil: DRIVER/GUDANG sudah melihat tampilan Dispatch murni (qty/tujuan/status), tidak ada UI routing/armada yang perlu disembunyikan lebih lanjut. Tidak ada perubahan kode untuk item ini — label nav tetap "Jadwal Pengiriman" karena dipakai bersama oleh SUPERVISOR/ADMIN yang memang mengelola loading & rute penuh di halaman yang sama; me-rename label akan salah merepresentasikan kapasitas mereka
- [x] Sweep repo-wide: nol residu `FP_DIST_STATUS_ROLES` di luar doc-comment referensi historis di `lib/logistics/roles.ts` sendiri
- [x] Regression check final: `tsc --noEmit` clean (0 error); 41/41 test hijau (`w2-2`/`w2-3`/`w2-14`-distribution-fefo, `food-production-enterprise-gate`, `food-production-phase5-sprint19`) — 3 script FEFO tetap 100% di sisi Dispatch, tidak tersentuh perubahan role

**Commit untuk Sprint 5.4** (role cleanup saja):
```
refactor(logistics): move driver delivery-status role-set out of food-production
```
Isi: `lib/logistics/roles.ts` (baru), `lib/food-production/roles.ts`, `lib/api/handlers/distribution-orders.ts`, `app/food-production/distribution/page.tsx`, `components/AppShell.tsx`.

**Status Sprint 5.4**: ✅ DONE. **Sprint 5 (Dispatch/Logistics Rename & Extraction) selesai seluruhnya** — 5.1 rename, 5.2 extraction, 5.3 domain assessment (Service Point tetap, tidak dipindah), 5.4 role cleanup.

---

## Kickoff besok (3 hari pertama)

| Hari | Pekerjaan |
|---|---|
| 1 | AppShell cleanup · Role `GUDANG` cleanup · Freeze UI scope (Sprint 1 STEP 0) |
| 2 | Kitchen Assurance boundary adapter · Lepas direct query di `production-batches.ts` (Sprint 2 STEP 1) |
| 3 | Extract Armada (Sprint 2 STEP 2) |

Setelah tiga hal ini selesai, baru masuk migrasi besar (Sprint 3-5).

---

## Revisi dokumen arsitektur (setelah Sprint 5 selesai — bukan sekarang)

- [ ] Update ADR-001 → "Inventory Production Domain" (Procurement → Dispatch)
- [ ] Update ADR-002 → "Operational Assurance Layer" (owner QC/Cold Chain/HACCP)
- [ ] ADR baru untuk domain Logistics
- [ ] Update Regulatory Support Layer (dokumen terpisah, paused) — titik singgung Organoleptik (`rasa_tekstur`) sekarang di Kitchen Assurance

---

## Exit criteria Freeze

> Freeze selesai ketika seluruh modul Food Production hanya berisi fitur yang mendukung alur **Procurement → Inventory → Production Planning → Material Requirement → Material Issue → Production Result → Dispatch**, dan seluruh fitur di luar alur tersebut sudah dipindahkan (Kitchen Assurance / Logistics), disederhanakan, atau ditandai Future.
