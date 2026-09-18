# Remediasi RTV2609000001 (SPPG × Zulmy)

**Status keputusan (2026-09-08):** eksekusi sesuai ADR-008 plan — stok buku dipertahankan (1 set); surplus fisik dikembalikan ke vendor **tanpa** RTV/CN baru; CN lama + hutang `INV2609000008` tetap; `CPO2609000045` dibatalkan.

### Checklist eksekusi

| Langkah | Status | Catatan |
|---------|--------|---------|
| Stempel audit `opsRemediationNote` pada hutang4, hutang8, RTV, GRN65, CPO42 | Done | 2026-09-08 |
| Cancel `CPO2609000045` | Done | status `CANCELLED` + outbox `ENSURE_PUSH_CANCEL_SO` |
| Kembalikan surplus fisik ke Zulmy (packing list) | **Ops gudang** | Tanpa RTV/CN/penyesuaian OUT |
| Brief SPPG: Koreksi harga CN/DN, bukan RTV | Done | Lihat panduan di bawah; banner di `/retur-vendor` |

## Kronologi (sudah diverifikasi di DB)

| Waktu UTC | Dokumen | Efek |
|-----------|---------|------|
| 2026-09-02 | `GRN2609000048` / `INV2609000004` | Stok IN awal |
| 2026-09-04 | `RTV2609000001` + `CN2609000001` | 14 baris stok OUT; hutang turun Rp 5.493.468 (reason: salah harga — **salah jalur**) |
| 2026-09-05 | `CPO2609000042` → `GRN2609000065` / `INV2609000008` | 14 baris stok IN lagi; hutang baru Rp 5.096.250 |
| 2026-09-05 | `CPO2609000045` SUBMITTED | PO lanjutan mirip (16 baris) — **dibatalkan** |

DB: `sppg_penarukan2`, tenant `sppg`, vendor `zulmy`.

## Keputusan komersial (Fase 2)

**Pertahankan** `CN2609000001` + hutang `INV2609000008`.

Alasan: tagihan ulang vendor sudah tercatat; membatalkan CN/GRN65 berisiko merusak jurnal hutang/piutang berpasangan. Setelah surplus fisik keluar, buku (1 set) selaras dengan sisa barang di gudang.

| Invoice | Total | Terbayar/CN | Sisa |
|---------|-------|-------------|------|
| `INV2609000004` | 5.675.968 | 5.493.468 (CN) | 182.500 |
| `INV2609000008` | 5.096.250 | 0 | 5.096.250 |

## Selaras stok (Fase 1) — tindakan gudang

**Kondisi buku:** setelah RTV OUT + GRN65 IN, net buku untuk SKU overlap ≈ **1× qty RTV** (bukan 2×).

**Kondisi fisik (asumsi terkonfirmasi ops):** barang RTV tidak keluar + GRN65 masuk → fisik ≈ **2×**.

**Perbaikan:** kembalikan **1 set surplus** ke Zulmy (packing list di bawah).

- **Jangan** buat RTV / CN baru (akan memotong buku lagi → understock).
- **Jangan** penyesuaian stok OUT sejumlah surplus (buku sudah 1×; OUT membuat buku 0× sementara fisik jadi 1×).
- Catat BA serah terima: `koreksi double RTV2609000001 / GRN2609000065 — retur fisik surplus tanpa mutasi sistem`.

### Packing list surplus (qty dokumen RTV / overlap GRN65)

Gudang: **GKERING**. Qty = yang dikembalikan (1 set).

| SKU | Nama | Qty (dok) | Satuan | Qty base | Overlap |
|-----|------|-----------|--------|----------|---------|
| B057434 | Backing Powder 1 kg | 1 | PCS | 1 | YES |
| B925034 | Bumbu Knoor Ayam 1kg | 7 | KG | 7 | YES |
| B402689 | Garam Kapal 250g | 8 | PCS | 8 | YES |
| B387463 | Gula Pasir 1kg | 7 | PCS | 7 | YES |
| B730182 | Ladaku Merica Bbk 100g | 4 | PCS | 4 | YES |
| B455629 | Minyak Sunco Refil 2L | 6 | DUS | 36 | YES |
| B559443 | Saos Tomat Delmonte 5,7L | 1 | JRG | 5 | YES |
| B425438 | Tepung Sasa Serbaguna | 25 | PCS | 25 | YES |
| B495092 | Tepung Tapioka Rose Brand 500g | 10 | PCS | 10 | YES |
| B426390 | Tepung Terigu 1kg | 25 | PCS | 25 | YES |
| B511393 | Kaldu Desaku Marinasi Instan 12,5g | 19 | RTG | 228 | YES |
| B403445 | Raja Rasa 600 ml | 1 | BTL | 1 | YES |
| B102905 | Saos Delmonte Spaghetti 250 gr | 72 | PCS | 72 | YES |

**Khusus non-overlap (cek fisik manual):**

| SKU | Catatan |
|-----|---------|
| B630710 Minyak Wijen | Ada di RTV (OUT 3), **tidak** di GRN65; GRN77 kemudian IN 3 → buku 3. Hanya kembalikan jika fisik > buku. |
| B728547 Nori | **Tidak** di RTV; GRN65 IN 55 (buku net Sep ~120). Bukan surplus RTV — jangan ikut packing list RTV kecuali hitung fisik membuktikan kelebihan. |

### Lembar hitung fisik (isi di gudang)

| SKU | Buku (net Sep GKERING*) | Fisik hitung | Surplus (fisik−buku) | Target kembalikan |
|-----|-------------------------|--------------|----------------------|-------------------|
| B057434 | 1 | | | 1 |
| B102905 | 72 | | | 72 |
| B387463 | 42* | | | 7 (hanya porsi RTV; sisa dari transaksi lain) |
| B402689 | 66* | | | 8 |
| B403445 | 1 | | | 1 |
| B425438 | 25 | | | 25 |
| B426390 | 25 | | | 25 |
| B455629 | 66* | | | 36 base (6 DUS) |
| B495092 | 10 | | | 10 |
| B511393 | 228 | | | 228 base (19 RTG) |
| B559443 | 5 | | | 5 base (1 JRG) |
| B730182 | 5* | | | 4 |
| B925034 | 16* | | | 7 |

\*Net sejak 1 Sep termasuk transaksi lain (bukan hanya RTV/GRN65). **Kembalikan qty kolom Target**, bukan seluruh net buku.

## CPO2609000045

PO `SUBMITTED` ke zulmy, 16 baris hampir sama dengan set RTV/CPO42 (+ Maizena, Nori 65, Minyak Wijen). Dianggap duplikat lanjutan → **cancel**.

**Eksekusi 2026-09-08:** status → `CANCELLED` (belum ada `qtyReceived` / `noSO`). Outbox `ENSURE_PUSH_CANCEL_SO` diisi lalu ditandai DONE — peer cancel Sales N/A karena SO belum terbentuk.

## Panduan ops ke depan (SPPG)

Salah harga / salah nilai **tanpa barang keluar gudang**:

1. Tagihan Vendor → **Koreksi harga**
2. Overcharge → draft **Credit Note**; undercharge → draft **Debit Note**
3. **Jangan** Retur Vendor (RTV) — RTV memotong stok

Barang rusak / tolak fisik / tukar barang → baru pakai RTV.

## ID referensi

- RTV `3dd8cfbf-114b-40b5-ae2c-69842e46fc57` / `RTV2609000001`
- CN `501b5769-decc-4cab-b344-d2b98d4ea169` / `CN2609000001`
- Hutang lama `18b448d5-6047-4ab0-8d35-c940602788e1`
- CPO/GRN baru `CPO2609000042` / `GRN2609000065` / hutang `03b16f07-5304-4da6-8ffd-59caaa2b18dc`
- CPO cancel `af51eb0d-a39b-4adc-8a4f-f17575a451d1` / `CPO2609000045`
