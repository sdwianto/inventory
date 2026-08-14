# ADR-004: Food Safety (Disposition Control & Audit Lens)

**Status:** ACCEPTED  
**Tanggal:** 2026-08-10  
**Owner:** Inventory Domain / Product Architecture  
**App host:** Inventory App  
**Lahir dari:** [FOOD-SAFETY-MODULE-FIT-GAP.md](../architecture/FOOD-SAFETY-MODULE-FIT-GAP.md) — audit scope "Food Safety Module (SCOPE LOCKED)" terhadap codebase existing  
**Relates:** ADR-001 (Food Production owns QC / HACCP / Cold Chain), ADR-002 (Kitchen Assurance owns Finding / Follow Up)  
**Supersedes sebagian:** ADR-001 §Phase 5 (HACCP evidence dianggap DONE), ADR-002 §Frozen (Checklist Engine)

---

## Prinsip

> Food Safety controls the **disposition** of food, but does not own the underlying production or inventory data.

Food Safety bukan bounded context keempat. Ia adalah **lensa audit + kontrol disposisi** di atas domain yang sudah ada. Menu "Food Safety" boleh ada di UI sebagai satu pintu masuk audit; di layer data ia agregasi, bukan pemilik.

```
                    FOOD SAFETY
                    (Audit Lens)
                         │
          ┌──────────────┴──────────────┐
          │                             │
   FOOD PRODUCTION              KITCHEN ASSURANCE
          │                             │
   ┌──────┼────────┐             ┌──────┼──────┐
   │      │        │             │      │      │
  QC    HACCP   Temperature    Finding Action Verification
   │      │        │
   └──────┴────────┘
             │
       Production Batch
             │
       foodSafetyStatus
             │
      ┌──────┴──────┐
      │             │
    HOLD         RELEASED
      │             │
      └──────┬──────┘
             ▼
      FEFO / Distribution
```

---

## Context

Scope "Food Safety Module — Final" meminta modul dengan tiga area (Prerequisite, HACCP, Assurance) dan 20 entity MVP. Audit codebase menemukan bahwa sebagian besar kapabilitas itu **sudah ada dan tersebar**: Food Production memiliki checklist (`qc_*`, `haccp_*`), monitoring suhu (`temperature_logs`), batch, dan lot; Kitchen Assurance memiliki finding (`ka_safety_cases`), corrective action (`ka_follow_ups`), dan verifikasi berbukti.

Menerjemahkan scope secara literal menjadi module baru akan melanggar ADR-001 (HACCP milik Food Production) dan ADR-002 (KA eksplisit menolak duplikasi QC/HACCP/Cold Chain).

---

## Problem

Audit menemukan satu celah yang jauh lebih mendesak daripada kelengkapan entity:

**Batch yang diketahui gagal food safety control tetap bisa keluar dari dapur.**

Buktinya berlapis di codebase:

- `production_batches.status` hanya `ACTIVE | EXPIRED | CONSUMED` — tidak ada konsep penahanan.
- `fefo-consume.ts` memilih kandidat dengan `status: { $in: ['ACTIVE', 'EXPIRED'] }`, tanpa join ke `haccp_results` maupun `qc_results`.
- `assertHaccpCanComplete()` memblokir dokumen menjadi COMPLETED saat CCP wajib FAIL. Efeknya justru terbalik: kegagalan **tidak menjadi record formal**, dokumen menggantung di DRAFT, dan batch tetap `ACTIVE` serta tetap ikut FEFO.
- `KaResolutionType.HOLD_BATCH` dan `inventoryHoldRef` hanya label — tidak pernah dibaca kode mana pun.

P0 ADR ini menjawab tepat satu pertanyaan:

> "Bisakah makanan yang diketahui gagal food-safety control tetap keluar dari dapur?"

Setelah P0, jawabannya harus: **tidak.**

---

## Decision

### 1. Ownership matrix

| Domain | Memiliki |
|--------|----------|
| Inventory | Lot (`ingredient_lots`), stok, GRN |
| Food Production | Batch (`production_batches`), QC, HACCP, Temperature Log |
| Kitchen Assurance | Finding (`ka_safety_cases`), Corrective Action (`ka_follow_ups`), Verification |
| **Food Safety** | **Disposition** (`foodSafetyStatus`) + read model audit readiness |
| Audit Readiness | Membaca evidence lintas domain — tidak menulis |

Food Safety tidak membuat master duplikat untuk ingredient, supplier, employee, equipment, recipe, menu, lot, maupun batch.

### 2. Production Batch adalah unit disposisi food safety

Bukan Production Result, bukan Production Plan, bukan Menu, bukan Recipe.

Model existing sudah benar: `production-results.ts` membuat **satu batch per finished good per result**. Ini dipertahankan karena memungkinkan disposisi selektif dalam satu kali masak:

```
Result HSL-000123
├── Nasi ayam → Batch A → RELEASED
├── Sayur     → Batch B → HOLD
└── Buah      → Batch C → RELEASED
```

Usulan awal "satu result = satu batch" **ditolak** karena akan memaksa penahanan seluruh hasil masak hanya karena satu menu bermasalah.

### 3. Pemisahan status (dua sumbu, tidak pernah dicampur)

**Sumbu inventory** — `production_batches.status`:

```
ACTIVE · EXPIRED · CONSUMED
```

**Sumbu food safety** — `production_batches.foodSafetyStatus`:

```
PENDING · PASS · HOLD · RELEASED
```

`IN_PROGRESS` **bukan** persisted state; bila UI membutuhkannya, ia diturunkan. Dilarang membuat `status = HOLD` karena itu mencampur lifecycle inventory dengan disposisi keamanan pangan.

**Sumbu dokumen** — `haccp_results.status` tetap `DRAFT · SUBMITTED · APPROVED · COMPLETED · CANCELLED`.

**Sumbu hasil** — `haccp_results.disposition` baru: `PENDING · PASS · FAIL`.

FAIL **bukan** lifecycle state dan tidak boleh masuk state machine dokumen. Kombinasi berikut valid dan justru diperlukan:

```
status = COMPLETED   disposition = FAIL    → pemeriksaan selesai, hasilnya gagal
status = DRAFT       disposition = FAIL    → kegagalan sudah tersimpan, dokumen belum selesai
```

`COMPLETED` berarti **pemeriksaan telah selesai dilakukan**, bukan berarti lolos.

### 4. Tiga flag: required, critical, holdOnFail

Hari ini `required` menanggung tiga makna sekaligus. Dipecah menjadi:

| Flag | Mengatur | Konsekuensi |
|------|----------|-------------|
| `required` | Kelengkapan record | Item wajib dijawab PASS/FAIL, tidak boleh NA |
| `critical` | Klasifikasi kegagalan | Kegagalan keamanan pangan → severity finding naik |
| `holdOnFail` | Aksi pada batch | Produk belum layak dilepas → batch ditahan |

**Core invariant:**

```
holdOnFail = true  ⇒  critical = true
```

Ditegakkan di normalizer, bukan konvensi.

**Semantik peralihan P0B → dicabut di P0C.** P0B sempat memakai `required` sebagai penentu disposition sementara. Sejak P0C, basis final berlaku:

```
P0B  required   + FAIL → disposition FAIL      (sementara — DICABUT)
P0C  critical   + FAIL → disposition FAIL      (final)
     holdOnFail + FAIL → kandidat HOLD
P0D  holdOnFail + FAIL + batchId → foodSafetyStatus HOLD
```

`required` kembali bermakna tunggal: wajib dijawab PASS/FAIL. Template lama tanpa field `critical`/`holdOnFail` dibaca lewat `effectiveHaccpItemFlags()` (CCP+required → keduanya true) agar tidak ada jendela regresi.

**Konsekuensi P0B pada gate COMPLETED.** CCP gagal tidak lagi memblokir transisi ke COMPLETED. Gate lama membuat dokumen gagal menggantung sehingga kegagalan tidak pernah tercatat resmi — persis kebalikan dari yang dibutuhkan audit. Yang tetap memblokir hanyalah kelengkapan pengisian: item wajib belum diisi, masih NA, atau evidence foto belum ada. Karena `status = COMPLETED` tidak lagi menyiratkan "semua CCP lolos", setiap pembaca `haccp_results` wajib memakai `disposition`, bukan `status`, untuk menyimpulkan hasil pemeriksaan.

### 5. CCP invariant — holdOnFail bersifat derived, bukan configurable

Untuk item berkategori CCP:

```
CCP  ⇒  critical   = true      (derived)
     ⇒  holdOnFail = true      (derived)
     ⇒  tidak dapat dimatikan
```

Kombinasi `CCP + holdOnFail = false` adalah **invalid state**, ditolak normalizer — bukan sekadar "default true" yang bisa diubah.

Alasannya definisional: sebuah titik disebut CCP justru karena hilangnya kendali di situ menimbulkan risiko kesehatan yang tidak dapat diterima. Bila hold-nya bisa dimatikan, ia bukan CCP.

Bila suatu item terasa terlalu keras untuk menahan produk, cara memperbaikinya adalah **menurunkan klasifikasinya** menjadi item QC atau prerequisite — bukan mematikan flag. Flag bukan alat untuk melunakkan CCP.

Untuk QC dan prerequisite, `critical` dan `holdOnFail` configurable dengan **default mati**, hanya dapat diubah `FP_MANAGE_ROLES`, dan perubahannya masuk audit log. `GUDANG` boleh mencatat hasil tetapi tidak menentukan apa yang menahan produk.

**Uji kelayakan `holdOnFail`** (ketiganya harus ya):

1. Kegagalan menyentuh produk yang sudah jadi pada batch tertentu, bukan hanya kondisi umum.
2. Ada jalur bahaya yang masuk akal ke makanan itu (biologis, kimia, fisik).
3. Memperbaiki kondisinya sekarang tetap tidak memulihkan keamanan produk yang terlanjur dibuat.

```
Suhu inti masak < batas          → ya, ya, ya   → holdOnFail
Benda asing dalam produk         → ya, ya, ya   → holdOnFail
Matang kontak dengan bahan mentah→ ya, ya, ya   → holdOnFail
Termometer belum terkalibrasi    → ya, ya, tidak→ critical, tanpa hold
Label miring                     → tidak         → keduanya mati
```

### 6. Blast radius — auto-hold hanya bila tautannya deterministik

```
Terikat batch (deterministik)          →  AUTO HOLD
  HACCP result      (productionBatchId wajib)
  Temperature       (COOKING/HOLDING + productionBatchId)
  QC                (productionBatchId, setelah P0-1E)

Terikat lingkungan (inferensial)       →  PROPOSED HOLD
  Prerequisite checklist (dapur + rentang waktu)
  QC lama tanpa productionBatchId
        ↓
  Safety Case + proposedHoldBatchIds[]
        ↓
  Konfirmasi supervisor
        ↓
  HOLD
```

Menahan berdasarkan inferensi rentang waktu dapat membekukan seluruh output dapur hanya karena satu centang sanitasi. Otomatiskan yang tautannya pasti; serahkan pada manusia yang tautannya inferensi.

Stage `RECEIVING` pada temperature log terkait GRN/lot, bukan batch, sehingga tidak memicu hold batch.

### 7. HOLD lifecycle — tahan lebih awal, lepas belakangan

HOLD dipicu **saat kegagalan disimpan**, termasuk ketika dokumen masih DRAFT. Bukan saat pemeriksaan selesai.

```
CCP FAIL
   ↓
save result           ← HOLD terjadi di sini
   ↓
batch HOLD
   ↓
KA Safety Case (auto, idempoten via sourceKey)
   ↓
Corrective Action (ka_follow_ups)
   ↓
Evidence → VERIFIED
   ↓
RELEASED
```

Bila HOLD menunggu COMPLETED, operator yang mencatat CCP FAIL lalu meninggalkan dokumennya di DRAFT menghasilkan persis celah yang sedang ditutup. `disposition` difinalkan di COMPLETED; penahanan tidak menunggu itu.

Riwayat disimpan embedded di `production_batches.foodSafetyHistory[]` menggunakan turunan `DocHistoryEntry` (`at`, `fromStatus`, `toStatus`, `userId`, `userName`, `note`) ditambah `sourceType` dan `sourceId`. Tidak ada entity history baru.

### 8. Release authority

- Hanya `FP_MANAGE_ROLES` yang boleh melepas batch dari HOLD. `GUDANG` tidak pernah bisa.
- Pelepasan hanya sah bila follow-up terkait berstatus `VERIFIED` — dan `assertFollowUpCanVerify()` sudah mensyaratkan evidence.
- Alasan dan `sourceId` wajib tercatat di `foodSafetyHistory[]`.

### 9. FEFO / Distribution enforcement

`foodSafetyStatus = HOLD` harus ditolak oleh seluruh jalur pengeluaran: FEFO allocate, FEFO consume, dan dist FEFO ship. Pesan shortfall wajib menyebut alasan penahanan agar operator tidak mengira stok hilang.

Untuk P0, hanya `PENDING`, `HOLD`, dan `RELEASED` yang berkonsekuensi; gate memblokir `HOLD` saja. `PASS` bersifat informatif sampai Fase HACCP Study ada, karena sebelum `HaccpPlan` sistem belum tahu gate apa saja yang seharusnya berlaku bagi suatu batch. Sistem tidak mengklaim jaminan yang belum dimilikinya.

**Menyaring kandidat FEFO saja tidak cukup.** Pada `distribution_orders` dan `inventory_releases`, mutasi stok diposting sebelum FEFO consume berjalan, sehingga filter `foodSafetyStatus != HOLD` hanya membuat batch tertahan dilewati — barang tetap terkirim dengan shortfall diam bila tidak ada batch pengganti. Karena itu P0G wajib menambahkan pra-validasi yang **menggagalkan dokumen sebelum transaksi dimulai**, bukan sekadar mengandalkan filter kandidat.

P0G juga mencakup kanal baca publik: `/fp-public/batches` saat ini menampilkan seluruh batch `ACTIVE` tanpa menyaring disposisi, sehingga batch tertahan akan tampil sebagai normal di kanal yang dilihat pihak luar.

**Relokasi antar-gudang bukan pengeluaran, tetapi tetap dapat mencuci disposisi.** `relocateBatchesFefo` memindahkan batch tanpa memblokirnya (mutasi stok sudah terjadi lebih dulu; menolak relokasi justru membuat lokasi batch melenceng dari buku stok). Invariannya: klon di gudang tujuan **wajib mewarisi** `foodSafetyStatus` dan `foodSafetyHistory`, dan penggabungan ke batch tujuan hanya sah bila disposisinya sama. Pemblokiran transfer itu sendiri adalah gate tingkat dokumen di P0G.

### 10. Traceability — read model, bukan ledger

Tidak ada perubahan fundamental pada transaction model. Rantai direkonstruksi dari data existing:

```
Production Batch
 → productionPlanId + finishedGoodProductId
 → Recipe
 → material_requirements.lines[].sources[]   (recipeId, qty)
 → material_issues.fefoConsume[].allocations[]
 → ingredient_lots
 → GRN
 → Supplier
```

Atribusi lot bersifat proporsional dan **wajib dilabeli eksplisit**:

> Traceability attribution is a candidate-lot inference based on recorded material allocation, not a physical observation.

Untuk recall, candidate **superset** lebih benar daripada subset. `lastConsumedBy` dilarang dipakai sebagai sumber traceability karena bersifat last-write-wins, bukan ledger.

`ingredient_lots` menyimpan `supplierId` dan `grnId`; nama supplier diambil dari master, tidak disimpan sebagai field otoritatif.

---

## Entity reuse (tidak dibuat ulang)

`qc_templates` · `qc_results` · `haccp_templates` · `haccp_results` · `temperature_logs` · `temperature_thresholds` · `production_batches` · `ingredient_lots` · `material_issues` · `material_requirements` · `production_plans` · `production_results` · `distribution_orders` · `ka_safety_cases` · `ka_follow_ups` · `ka_observations` · audit log · media/evidence storage

---

## Ditolak

Entity yang **tidak** dibuat:

- `HaccpProduct` — plan langsung menyimpan `recipeIds[]` dan `menuIds[]`
- `HaccpPlanVersion` — versioning inline (`version`, `effectiveDate`, `supersededById`) dengan unique partial index pada plan aktif
- Collection `haccp_process_steps` — embedded di `HaccpPlan`
- Generic checklist engine baru — pakai engine QC yang ada
- `FoodSafetyEvidence` terpusat — evidence tetap melekat pada dokumen sumbernya
- Traceability ledger / production-batch allocation entity
- Standalone Food Safety dashboard
- Training Record, Supplier Check, Instrument Check (ditunda)
- CCP determination engine, risk matrix engine, CAPA/NCR/Audit/Compliance/Incident/Document Management System

---

## Dampak terhadap ADR sebelumnya

### ADR-001 (Food Production)

Phase 5 menyatakan "HACCP evidence" DONE. **Direvisi:** yang selesai adalah *checklist CCP + evidence foto*, bukan HACCP study (hazard analysis, CCP determination, critical limit terstruktur). Selain itu Food Production kini memiliki `foodSafetyStatus` pada batch dan `disposition` pada `haccp_results`. Kepemilikan QC/HACCP/Cold Chain **tidak berubah** — tetap Food Production.

### ADR-002 (Kitchen Assurance)

Checklist Engine tetap **frozen di KA** — ADR ini tidak membukanya. Checklist prerequisite dibangun di atas engine QC milik Food Production, sehingga larangan duplikasi ke KA tetap utuh.

Yang berubah: `ka_safety_cases` mendapat `proposedHoldBatchIds[]`, dan `KaResolutionType.HOLD_BATCH` yang selama ini hanya label akhirnya memiliki arti operasional. KA tetap tidak memiliki QC/HACCP/Temperature.

---

## Migration & rollout

1. Backfill `foodSafetyStatus = PENDING` untuk seluruh batch existing, dengan skrip bermode dry-run lebih dulu (mengikuti pola skrip repair yang sudah ada).
2. Gate FEFO dirilis di belakang **flag per tenant**. Filter HOLD akan memunculkan shortfall mendadak di dapur yang sedang berjalan.
3. `qc_results.productionBatchId` bersifat opsional; dokumen lama tanpa batch masuk jalur proposed hold, bukan diblokir.
4. Template existing diberi `critical`/`holdOnFail` default mati, kecuali item berkategori CCP yang otomatis derived true.

---

## Non-goals

ISO 22000 / FSSC 22000, compliance framework generik, supplier risk scoring, predictive analytics, AI hazard analysis, IoT / sensor otomatis, statistical process control, enterprise document control, recall workflow penuh.

Sistem **tidak menetapkan** batas keamanan pangan. Nilai hazard, CCP, dan critical limit harus divalidasi pihak yang kompeten; aplikasi hanya menyimpan keputusan yang telah disahkan. Template bawaan berlabel contoh, bukan acuan.

---

## Consequences

**Positif**

- Celah "gagal CCP tetap terkirim" tertutup, dan tertutup di titik penyimpanan kegagalan, bukan di titik penyelesaian dokumen.
- Disposisi selektif per finished good tanpa mengubah model produksi.
- Kegagalan menjadi record formal yang dapat diaudit, bukan dokumen menggantung.
- Tidak ada domain baru, tidak ada master duplikat, tidak ada ledger baru.

**Negatif / biaya**

- Dapur akan mengalami shortfall yang sebelumnya tidak ada. Perlu flag per tenant dan pesan error yang menjelaskan sebab.
- `qc_results` bertambah field dan UI QC perlu pemilih batch.
- `PASS` belum bermakna penuh sampai HACCP Study selesai — keterbatasan ini harus dinyatakan di UI, bukan disembunyikan.
- Semua batch dari satu result masih berbagi satu `expiryDate` (dihitung sekali di luar loop) padahal umur simpan tiap menu berbeda. Dicatat sebagai utang, di luar P0.

---

## Addendum — UI hub Keamanan Pangan (2026-08-13)

**Keputusan:** Food Safety sebagai *audit lens* boleh punya **satu pintu UI** (“Keamanan Pangan”) dengan empat mode kerja (Setup · Operasi · Temuan · Audit) yang menuntun non-ahli. Ini **tidak** memindahkan ownership data: QC/HACCP/Cold Chain/Batch tetap Food Production; Finding/Follow-up tetap Kitchen Assurance.

**Acuan UX:** [docs/haccp/haccp-ux-flow.md](../haccp/haccp-ux-flow.md) · **Baseline BGN:** [docs/haccp/bgn-requirement-matrix.md](../haccp/bgn-requirement-matrix.md).
