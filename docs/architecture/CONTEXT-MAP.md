# Context Map — Inventory App (Food Production Platform)

**Status:** LIVING DOCUMENT  
**Tanggal:** 2026-07-28  
**Revisi:** Food Safety ditambahkan sebagai lensa (bukan bounded context) — 2026-08-10, lihat ADR-004  
**Owner:** Inventory Domain / Product Architecture  
**Lahir dari:** [FOOD-PRODUCTION-SPLIT-CLOSEOUT.md](./FOOD-PRODUCTION-SPLIT-CLOSEOUT.md) — domain sekarang cukup jelas untuk dipetakan.

> Ini bukan ADR (keputusan) dan bukan migration log (eksekusi). Ini peta relasi antar bounded context **saat ini** — dibaca sebelum menyentuh kode lintas domain, atau saat onboarding. Diperbarui setiap kali relasi domain berubah, bukan hanya saat migrasi besar.

---

## Peta

```
                    ┌───────────────────────┐
                    │   Food Production      │
                    │  (Master/Planning/     │
                    │   Kitchen/Dispatch/    │
                    │   Management)          │
                    └───────────┬────────────┘
                                │
              DispatchLine snapshot (qty, tujuan, kategori porsi)
                                │
                                ▼
                    ┌───────────────────────┐
                    │      Logistics         │
                    │ (Armada/Delivery/      │
                    │  Roles)                │
                    └───────────┬────────────┘
                                │ consumes (routing: jamKirim, drops, alamat)
                                ▼
                    ┌───────────────────────┐
                    │     Service Point      │
                    │  (Destination Master — │
                    │   shared, tak dimiliki)│
                    └───────────▲────────────┘
                                │ consumes (sizing: kapasitasPorsi, porsiByKategori)
                                │
                    ┌───────────┴────────────┐
                    │   Food Production       │
                    │       (Dispatch)        │
                    └─────────────────────────┘

                    ┌───────────────────────┐
                    │   Kitchen Assurance    │
                    │ (operational guardrail)│
                    └───────────▲────────────┘
                                │ observes/aggregates (read model)
                                │ getBatchAssuranceTrail(), countOpenQcResults()
                    ┌───────────┴────────────┐
                    │   Food Production        │
                    │ (QC · HACCP · Cold Chain)│
                    └───────────────────────────┘


                    ┌───────────────────────┐
                    │      Food Safety       │
                    │  (lensa — bukan box)   │
                    └───────────┬────────────┘
                                │ controls disposition only
                                ▼
                    production_batches.foodSafetyStatus
                                │
                                ▼
                        FEFO / Distribution gate
```

Food Safety sengaja **tidak** digambar sebagai kotak sejajar dengan tiga domain di atas — ia tidak memiliki collection sendiri. Lihat bagian khusus di bawah.

---

## Relasi (dengan pola DDD)

| Dari → Ke | Pola | Arah dependensi | Mekanisme | Kenapa |
|---|---|---|---|---|
| Food Production (Dispatch) → Logistics (Delivery) | **Customer/Supplier**, dua arah pada level tipe | Bidirectional type reference, satu arah data nyata (Dispatch → Delivery) | `lib/logistics/delivery.ts` import `type DispatchLine` dari `distribution.ts`; `distribution.ts` import `DeliveryLoading`/`DeliveryArmada` untuk field `DispatchDoc.loadings`/`.armadas` | Delivery butuh snapshot penuh baris Dispatch (qty, kategori) untuk menyusun rute — bukan sekadar ID. Disengaja, bukan coupling yang belum selesai dipisah (lihat ADR-003 §Model data) |
| Logistics → Service Point | **Customer** (downstream, read-only) | Logistics → Service Point | Baca langsung `jamKirim`/`drops`/`alamat`/`pic` untuk membangun rute | Service Point tidak tahu/tidak peduli Logistics ada — tidak ada dependensi balik |
| Food Production (Dispatch) → Service Point | **Customer** (downstream, read-only) | Dispatch → Service Point | Baca `kapasitasPorsi`/`porsiByKategori` untuk sizing alokasi | Sama seperti Logistics — Service Point tidak tahu siapa konsumennya |
| Kitchen Assurance → Food Production (QC/HACCP/Cold Chain) | **Customer/Supplier**, Food Production sebagai **Open Host Service** | Kitchen Assurance → Food Production | `getBatchAssuranceTrail()`, `countOpenQcResults()` (`lib/kitchen-assurance/index.ts`) — read model, query collection Food Production langsung | Kitchen Assurance **tidak boleh** memiliki salinan data ini (ADR-002 §Capability Ownership, ditolak eksplisit sejak awal) |
| Food Safety → Food Production (batch) | **Conformist** — menulis satu field disposisi pada aggregate milik Food Production | Food Safety → Food Production | `production_batches.foodSafetyStatus` + `foodSafetyHistory[]`, dipicu dari QC/HACCP/Temperature milik Food Production sendiri | Disposisi harus melekat pada batch agar gate FEFO bisa menolaknya di satu titik. Membuat collection hold terpisah akan memecah kebenaran ke dua tempat (ADR-004 §Decision 2) |
| Food Safety → Kitchen Assurance (case) | **Customer/Supplier** | Food Safety → Kitchen Assurance | Auto safety case saat kegagalan disimpan, idempoten via `sourceKey`; `proposedHoldBatchIds[]` untuk kegagalan inferensial | Finding & corrective action tetap milik KA — Food Safety tidak membuat engine finding sendiri (ADR-002 tetap berlaku) |
| Food Production ↔ Logistics ↔ Kitchen Assurance | **Bukan** Shared Kernel | — | — | Sengaja dihindari — tidak ada model/tipe yang "dimiliki bersama" antar tiga domain ini. Yang terlihat seperti shared kernel (Service Point) justru diberi status eksplisit sendiri, bukan digabung ke domain manapun |

---

## Service Point — kenapa digambar terpisah, bukan di dalam salah satu kotak

Service Point **bukan** Shared Kernel klasik (tidak ada tim yang sengaja berbagi model demi menghindari duplikasi) dan **bukan** milik satu domain yang "dipinjam" domain lain. Sprint 5.3 Decision Record menyimpulkan ini genuinely *shared supporting domain* — bukti dari bentuk datanya sendiri: separuh field (`jamKirim`, `drops`, `alamat`, `pic`) murni kebutuhan Logistics, separuh lain (`kapasitasPorsi`, `porsiByKategori`) murni kebutuhan Dispatch. Tidak ada domain yang bisa mengklaim kepemilikan tanpa membuat domain lain bergantung pada folder domain lain untuk data perencanaannya sendiri.

Lokasi fisik saat ini (`lib/food-production/service-point.ts`) adalah kebetulan sejarah, bukan pernyataan kepemilikan — lihat ADR-001 §Revisi dan ADR-003 §Cakupan.

---

## Kitchen Assurance — kenapa panah observasi, bukan panah kepemilikan

Ini titik yang paling sering disalahpahami (termasuk sempat salah arah di rencana migrasi sebelum dikoreksi — lihat `docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md` §Revisi dokumen arsitektur). Kitchen Assurance **mengamati** QC/HACCP/Cold Chain milik Food Production, bukan **memiliki**-nya. Kalau ada perubahan yang membuat Kitchen Assurance mulai menyimpan salinan/turunan data QC/HACCP sendiri (bukan lagi query langsung), itu pertanda arsitektur sedang menyimpang dari ADR-002 — bukan evolusi yang wajar.

---

## Food Safety — kenapa lensa, bukan kotak

Food Safety tidak memiliki satu pun collection. Ia mengendalikan **disposisi** (boleh keluar atau tidak) dan membaca evidence lintas domain untuk kesiapan audit. Lot tetap milik Inventory, batch tetap milik Food Production, finding tetap milik Kitchen Assurance.

Satu-satunya jejak tulis Food Safety adalah `foodSafetyStatus` dan `foodSafetyHistory[]` pada `production_batches` — dan itu pun diletakkan pada aggregate milik Food Production, bukan pada collection baru, supaya gate FEFO punya satu sumber kebenaran.

Tanda arsitektur sedang menyimpang dari ADR-004: munculnya collection `food_safety_*`, master ingredient/supplier/employee/equipment versi Food Safety, atau engine finding kedua di luar `ka_safety_cases`.

---

## Yang sengaja tidak dipetakan di sini

- **sales.app ↔ inventory-app** (webhook + Execution Platform outbox, dua aplikasi terpisah) — relasi antar-aplikasi, bukan antar bounded-context dalam satu app. Kalau dibutuhkan, itu peta terpisah.
- **SIPGN** (Sistem Informasi Pemenuhan Gizi Nasional) — External Mandatory System, sudah dipetakan lewat Regulatory Architecture Pattern di `sales.app` (ADR-002 EMS Boundary, Domain Specification RSL). Tidak diulang di sini karena inventory-app tidak berinteraksi langsung dengannya.

---

## Cara memperbarui dokumen ini

Update saat ada perubahan **relasi** (bukan setiap perubahan file): domain baru lahir, domain lama dibubarkan/digabung, arah dependensi berbalik, atau pola relasi berubah (mis. read model berubah jadi ownership — seharusnya tidak pernah terjadi tanpa revisi ADR terlebih dahulu).

## Dokumen terkait

- [FOOD-PRODUCTION-SPLIT-CLOSEOUT.md](./FOOD-PRODUCTION-SPLIT-CLOSEOUT.md)
- [ADR-001 — Food Production Domain](../adr/001-food-production-domain.md)
- [ADR-002 — Kitchen Assurance](../adr/002-kitchen-assurance.md)
- [ADR-003 — Logistics Domain](../adr/003-logistics-domain.md)
- [ADR-004 — Food Safety](../adr/004-food-safety.md)
- [FOOD-SAFETY-MODULE-FIT-GAP.md](./FOOD-SAFETY-MODULE-FIT-GAP.md)
