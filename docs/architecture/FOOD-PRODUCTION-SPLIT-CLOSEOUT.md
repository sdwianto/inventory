# Food Production Domain Split — Architecture Closeout

**Status:** COMPLETED  
**Tanggal:** 2026-07-28  
**Owner:** Inventory Domain / Product Architecture  
**Program:** Food Production v1 domain split (Sprint 1–5)

> Ini bukan checklist kerja (itu ada di [docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md](../migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md)) dan bukan keputusan arsitektur baru (itu ada di [ADR-001](../adr/001-food-production-domain.md)/[002](../adr/002-kitchen-assurance.md)/[003](../adr/003-logistics-domain.md)). Ini adalah **penutupan resmi**: ringkasan satu halaman untuk siapa pun (termasuk diri sendiri enam bulan dari sekarang) yang perlu tahu *apa hasil akhirnya*, tanpa membaca ~250 baris migration log baris per baris.

---

## Pemicu (kenapa program ini dimulai)

SIPGN (sistem eksternal wajib MBG/SPPG) membutuhkan pemetaan yang jelas terhadap modul internal agar tidak tumpang tindih. Audit terhadap `inventory-app` modul Food Production menemukan bahwa modul ini sudah tumbuh menjadi *Kitchen Management System* — mencampur Dispatch (barang keluar gudang), Delivery (rute fisik/armada), dan Operational Safety (QC/HACCP/Cold Chain) dalam satu domain, satu dokumen (`distribution_orders`), dan satu bahasa. Keputusan: **Inventory harus menjadi Supply Chain & Production System**, bukan Kitchen Management System — memisahkan yang genuinely berbeda bounded context, bukan sekadar merapikan folder.

---

## Migrasi (Sprint 1–5) — ringkasan

| Sprint | Isi | Status |
|---|---|---|
| 1 | Operator Simplification — sembunyikan QC/Cold Chain/HACCP/Armada dari nav operator (`GUDANG`), route/API tetap hidup | ✅ DONE |
| 2 | Boundary Cleanup — Kitchen Assurance boundary (`getBatchAssuranceTrail()`, read model) + extract Armada ke `lib/logistics/` | ✅ DONE |
| 3 | Core Cleanup — dashboard KA boundary, hapus stub mobile kosong, perbaiki test regresi yang sudah pecah sejak Sprint 1 | ✅ DONE |
| 4 | Dispatch Mental Model — dokumentasi boundary di `distribution.ts` + verifikasi ulang independensi FEFO dari armada/route/stop/driver | ✅ DONE (checkpoint, sengaja berhenti sebelum rename) |
| 5.1 | Rename `DistributionOrderDoc`→`DispatchDoc` (+3 tipe terkait) — bahasa dulu, struktur belakangan | ✅ DONE |
| 5.2 | Extract `lib/logistics/delivery.ts` (Loading/Armada/Stop/Drop) dari `distribution.ts` | ✅ DONE |
| 5.3 | Service Point domain assessment (bukan implementasi) | ✅ DONE — Destination Master / shared, tidak dipindah |
| 5.4 | Role cleanup — `DRIVER` role-set pindah ke `lib/logistics/roles.ts` | ✅ DONE |

Detail eksekusi lengkap (per-file, per-commit, audit dependensi FEFO, dsb.): [docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md](../migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md).

**Dokumentasi arsitektur** direvisi setelahnya (commit `2c14f9b`, 2026-07-28): ADR-001 & ADR-002 diperbarui untuk mencerminkan state ini, ADR-003 (Logistics) dibuat baru.

---

## Result — domain akhir

```
✓ Food Production   — Master · Planning · Kitchen Operation (QC/Cold Chain/HACCP tetap di sini) · Dispatch · Management
✓ Logistics          — Armada · Delivery (loading/armada/stop/drop) · Roles (DRIVER)
✓ Kitchen Assurance   — operational guardrail, read model lintas domain — TIDAK berubah kepemilikan oleh migrasi ini
✓ Service Point       — Destination Master / shared supporting domain (bukan milik satu domain manapun)
```

- **Dispatch** (barang keluar gudang: qty, tujuan, FEFO) tetap `lib/food-production/distribution.ts` — terbukti lewat audit, bukan diasumsikan: 3 script FEFO nol referensi armada/route/stop/driver.
- **Logistics** lahir sebagai bounded context baru (ADR-003) — bahasa domain sendiri (loading, armada, rute, stop, drop), boundary yang terbukti aman dipisah.
- **Kitchen Assurance** (ADR-002) tidak berubah kepemilikan datanya — QC/HACCP/Cold Chain tetap Food Production; klarifikasi eksplisit ditambahkan justru untuk *mengunci* batas itu, bukan mengubahnya, setelah rencana revisi awal (Kitchen Assurance jadi "owner") ternyata salah arah.
- **Service Point** dinilai (Sprint 5.3) bukan Kitchen, bukan Dispatch, bukan Logistics — Destination Master, dikonsumsi lintas domain, sengaja tidak dipindah.

---

## Deferred (sengaja ditunda, bukan terlupa)

| Item | Alasan ditunda | Lihat |
|---|---|---|
| Service Point storage split (folder netral `lib/destination/`, `lib/location/`, atau `lib/master-data/`) | Belum ada pemilik tunggal; memindah sekarang salah arah | Sprint 5.3, ADR-001 §Revisi, ADR-003 §Cakupan |
| Delivery collection split (`deliveries` terpisah + `dispatchId` FK asli) | `buildDeliveryLoadings()` butuh snapshot `DispatchLine[]` penuh, bukan sekadar ID — pemisahan storage adalah migrasi lebih besar, di luar kebutuhan operasional saat ini | Sprint 5.2, ADR-003 §Model data |
| `kitchen-assurance/attention.ts`/`analytics.ts`/`reports.ts`/`adapters/cold-chain.ts` belum lewat kontrak `getBatchAssuranceTrail()` | Beda kebutuhan — mereka butuh signal real-time untuk monitoring, bukan trail historis | Sprint 2 Step 1 |
| Regulatory Support Layer update (repo `sales.app`) | Titik singgung Organoleptik (`rasa_tekstur`) sekarang di Kitchen Assurance, bukan Food Production langsung — cross-repo, sengaja dikerjakan setelah `inventory-app` benar-benar selesai (menghindari sales↔inventory berubah bolak-balik selagi boundary belum stabil) | Di luar cakupan closeout ini |

**Selesai setelah closeout ditulis** (2026-07-28, sesi yang sama): `rencana-kebutuhan.ts` vs `material-requirement.ts` — diekstrak rumus skala resep yang identik (`computeRecipeLineContributions()`, `material-requirement.ts`) tanpa menyentuh kontrol alur masing-masing (fail-fast vs permissive) — lebih konservatif dari rencana konsolidasi awal, angka kebutuhan bahan diverifikasi tidak berubah (`tests/unit/food-production-sprint4.test.ts`).

---

## Non Goals (sengaja tidak dikerjakan, bukan gap)

- Route planning / optimasi rute otomatis, tracking GPS real-time, driver mobile app terpisah — belum ada kebutuhan operasional terverifikasi.
- Memaksakan Service Point ke salah satu domain "demi kerapian struktur" — ditolak eksplisit di Sprint 5.3.
- Rename halaman "Jadwal Pengiriman" jadi label Dispatch-murni — akan salah merepresentasikan kapasitas SUPERVISOR/ADMIN yang memang mengelola rute penuh di halaman yang sama; gating role (`canManage`/`canUpdateStatus`) sudah cukup untuk operator.
- Mengubah ADR-002 jadi "Operational Assurance Layer" / owner QC-HACCP-Cold Chain — rencana awal ini secara eksplisit dibatalkan setelah audit menemukan itu membalik keputusan ADR-002 yang sudah ACCEPTED.

---

## Exit criteria — terpenuhi

> Freeze selesai ketika seluruh modul Food Production hanya berisi fitur yang mendukung alur **Procurement → Inventory → Production Planning → Material Requirement → Material Issue → Production Result → Dispatch**, dan seluruh fitur di luar alur tersebut sudah dipindahkan (Kitchen Assurance / Logistics), disederhanakan, atau ditandai Future.

Terpenuhi: 41/41 test regresi hijau, `tsc --noEmit` clean, 3 script FEFO diverifikasi independen dari Logistics, dokumentasi arsitektur (ADR-001/002/003) sinkron dengan kode.

---

## Status program

**Food Production v1 domain split dinyatakan COMPLETED per 2026-07-28.** Deferred items di atas adalah technical debt / cross-repo work yang eksplisit, dijadwalkan terpisah — bukan pekerjaan yang tertinggal dari program ini.

## Dokumen terkait

- [docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md](../migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md)
- [ADR-001 — Food Production Domain](../adr/001-food-production-domain.md)
- [ADR-002 — Kitchen Assurance](../adr/002-kitchen-assurance.md)
- [ADR-003 — Logistics Domain](../adr/003-logistics-domain.md)
- [ADR REGISTER](../adr/REGISTER.md)
