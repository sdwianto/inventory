# ADR-008 — Price Error / Commercial Adjustment (bukan retur fisik)

| Meta | Nilai |
|------|--------|
| Status | **Accepted** |
| Versi | **v2** |
| Tanggal | 2026-09-07 |
| Related | [ADR-005](./005-goods-return-credit-note.md) · [ADR-007](./007-cn-b2b-stock-boundary.md) · Sales ADR-006 §8 · Sales ADR-007 |

## Konteks

Kasus umum: invoice salah harga / salah PPN, **barang tetap di gudang Inventory buyer**, dan secara komersial perlu koreksi nilai (kadang diikuti dokumen pengganti / “kirim ulang” nota — bukan fisik).

RTV (ADR-005/006) **mengurangi stok** (OUT + transit). Memakai RTV untuk kasus ini salah: neraca qty rusak, transit GL terbuka tanpa barang keluar.

## Keputusan

### 1. Salah harga + barang tetap = **bukan RTV**

**Keputusan:** Jangan buat / post RTV. Stok Inventory tidak berubah.

### 2. Koreksi nilai = draft CN / DN finansial (Sales), digenerate dari Inventory

**Keputusan:**

| Situasi | Cara |
|---------|------|
| Overcharge (harga invoice terlalu tinggi) | Di Tagihan Vendor → **Koreksi harga** → pilih baris + harga benar → Inventory `POST …/request-price-cn` → Sales `POST /integrations/price-adjustment-cn` membuat CN **DRAFT** `source=price_adjustment`. Qty CN = qty dikoreksi; harga CN = selisih (tagihan − benar). |
| Undercharge (harga benar **lebih tinggi** dari tagihan) | Inventory `POST …/request-price-dn` → Sales `POST /integrations/price-adjustment-dn` membuat DN **DRAFT** `source=price_adjustment`. Qty DN = qty dikoreksi; harga DN = selisih (benar − tagihan). **Bukan CN** — CN menurunkan hutang, salah arah. |
| Post CN / DN | Vendor/admin post di Sales (CN bukan lewat `/decide`). ADR-007: `SKIPPED_B2B` saat post B2B (stok diam). |
| Setelah post DN | Sales naikkan piutang; push `debit_note.posted` → Inventory `applyDebitNoteFromVendor` (hutang `total`/`sisa` naik). |

### 3. “Kirim ulang” komersial vs fisik

| Maksud | Jalur |
|--------|-------|
| **Nota / harga ulang** (barang sudah di gudang) | CN (overcharge) atau DN (undercharge). **Tanpa** GRN kedua (hindari stok dobel). |
| **Barang fisik diganti** (tukar barang) | RTV fisik (OUT) + vendor ACCEPTED + **PO pengganti** / CPO baru → SO → DO → GRN (stok IN lagi). |
| Vendor menolak klaim harga | Tidak ada CN/DN; negosiasi manual / claim di luar sistem. |

### 4. UI / ops guidance

- `/hutang` detail → **Koreksi harga**: overcharge → draft CN; undercharge → draft DN (stok diam). Vendor post di Sales; hutang turun (CN) atau naik (DN) via webhook/push.
- `/retur-vendor`: “Salah harga tanpa barang keluar? Gunakan Koreksi harga di Tagihan Vendor — bukan RTV.”
- Sales `/penjualan/debit-note`: daftar / buat / post Debit Note B2B.
- PO Pengganti dari RTV hanya untuk tindak lanjut **REJECTED fisik** (sudah ada), bukan price error.

### 5. Di luar scope v2 (tetap)

- Counter-offer qty/harga di `/decide` (Sales ADR-006 §8).
- Auto-post CN/DN dari Inventory (v2 = draft saja; post tetap di Sales).

## Konsekuensi

- E2E skenario G memverifikasi CN manual B2B → `SKIPPED_B2B` + hutang berkurang tanpa mutasi stok Inventory.
- Undercharge memakai jalur DN: Inventory request → Sales draft → post → `ENSURE_PUSH_DEBIT_NOTE` → hutang naik; stok diam.
- RTV tetap khusus klaim fisik (rusak, salah kirim, reject quality).
