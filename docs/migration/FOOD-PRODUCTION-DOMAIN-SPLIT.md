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

- [ ] Pindahkan `lib/food-production/armada.ts` (collection `armadas`) → `lib/logistics/armada.ts`
- [ ] Pindahkan `app/food-production/armada/page.tsx` → route Logistics baru
- [ ] Pindahkan `lib/api/handlers/armadas.ts` → handler namespace Logistics
- [ ] Update satu-satunya consumer: `lib/api/handlers/distribution-orders.ts` (impor `ARMADAS_COLLECTION`)
- [ ] Tidak ada perubahan logika bisnis — murni pindah lokasi

---

## Sprint 3 — Food Production Core Cleanup

- [ ] Rapikan MRP embedded ke Plan (sudah begitu di UI — pastikan tidak ada jejak nav/dokumentasi yang menyiratkan halaman berdiri sendiri)
- [ ] Konsolidasi `rencana-kebutuhan.ts` → `material-requirement.ts` (duplikasi logic explode resep)
- [ ] `portion-target.ts` — dikonfirmasi tetap Core, didokumentasikan sebagai submodule resmi
- [ ] Hapus stub kosong `app/food-production/mobile/{issue,qc,result}` (diklaim "DONE" ADR-001 Sprint 24, tidak ada `page.tsx`)
- [ ] Dashboard: arahkan `food-dashboard.ts` (1 KPI QC) ke `getBatchAssuranceStatus()`/kontrak KA, bukan query `QC_RESULTS_COLLECTION` langsung

---

## Sprint 4 — Dispatch / Logistics *(baru masuk sini — bukan Sprint 1-3)*

**Distribution — JANGAN rename dulu.** FEFO, stok, shipment, return sudah bergantung padanya (dependency audit sebelumnya). Tahap pertama cukup ubah mental model, bukan kode:

- [ ] Tambahkan komentar dokumentasi di `lib/food-production/distribution.ts`:
```ts
/**
 * Inventory Dispatch Document
 * Historical collection name: distribution_orders (belum di-rename — lihat migration plan Sprint 4)
 */
```
- [ ] Baru setelah tim nyaman dengan mental model ini: rename tipe (`DistributionOrderDoc`→`DispatchDoc`) — collection Mongo rename **paling akhir**, terpisah, dengan migration script sendiri

**Service Point — JANGAN dipindah dulu.** Audit menemukan coupling **dua arah** (`service-point.ts` ↔ `distribution-orders.ts`) — pindah sekarang = migration kecil yang tidak memberi value operator. Prioritas: operator sederhana → Inventory stabil → baru Logistics.

Baru di sprint ini (setelah Distribution stabil sebagai konsep):
- [ ] Ekstrak `DistributionLoading`/`DistributionArmada`/`DistributionArmadaStop`/`DistributionStopDrop` → `lib/logistics/delivery.ts`, mereferensikan `dispatchId` (FK), tidak mewarisi struktur
- [ ] Pindahkan Service Point → Logistics (sekarang coupling dua arahnya sudah jelas, bisa direfactor sekaligus)
- [ ] Pindahkan role `DRIVER` → role-set Logistics
- [ ] Pindahkan `DistributionScheduleDocument.tsx` → Logistics
- [ ] Sederhanakan nav `Jadwal Pengiriman` jadi tampilan Dispatch murni (jumlah/tujuan/barang keluar) untuk operator
- [ ] Regression check: pastikan 3 script FEFO tetap 100% di sisi Dispatch setelah split

---

## Kickoff besok (3 hari pertama)

| Hari | Pekerjaan |
|---|---|
| 1 | AppShell cleanup · Role `GUDANG` cleanup · Freeze UI scope (Sprint 1 STEP 0) |
| 2 | Kitchen Assurance boundary adapter · Lepas direct query di `production-batches.ts` (Sprint 2 STEP 1) |
| 3 | Extract Armada (Sprint 2 STEP 2) |

Setelah tiga hal ini selesai, baru masuk migrasi besar (Sprint 3-4).

---

## Fase 4 (dulu) — Revisi dokumen besar, setelah kode stabil

- [ ] Update ADR-001 → "Inventory Production Domain" (Procurement → Dispatch)
- [ ] Update ADR-002 → "Operational Assurance Layer" (owner QC/Cold Chain/HACCP)
- [ ] ADR baru untuk domain Logistics
- [ ] Update Regulatory Support Layer (dokumen terpisah, paused) — titik singgung Organoleptik (`rasa_tekstur`) sekarang di Kitchen Assurance

---

## Exit criteria Freeze

> Freeze selesai ketika seluruh modul Food Production hanya berisi fitur yang mendukung alur **Procurement → Inventory → Production Planning → Material Requirement → Material Issue → Production Result → Dispatch**, dan seluruh fitur di luar alur tersebut sudah dipindahkan (Kitchen Assurance / Logistics), disederhanakan, atau ditandai Future.
