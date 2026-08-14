# HACCP implementation gap (post Gelombang 0)

Lihat juga [bgn-requirement-matrix.md](./bgn-requirement-matrix.md) dan [haccp-ux-flow.md](./haccp-ux-flow.md).

## Sudah dikirim (Gelombang 0 + A + B + C + D + E)

- Nav 5 item + hub + wizard shell + docs (0/A)
- **Gelombang B:** field plan `team`, `scope`, `productDescription`, `intendedUse`, `flowDiagram*`, `flowVerified*`; UI langkah A–C; checklist hijau/abu; gate approval menolak tanpa preamble + flow verify
- **Gelombang C:** `haccp_results.haccpPlanId` + `ccpKey`; Operasi “Wajib hari ini”; FAIL/HOLD → follow-up bukti ≤2 klik; banner HOLD; `correctiveAction` wajib
- **Gelombang D:** metadata PRE-01…05, accordion Setup PRP, seed celah kritis, tautan PDF BGN
- **Gelombang E:** Wizard E (validasi + rekaman pointer + bukti pelatihan); tipe `VALIDATION`; Audit hidup (pilar validasi & pelatihan → Wizard E); closeout bisa diisi saat plan ACTIVE; hub CTA “X item belum siap audit” (audit yang belum READY tidak tertutup antrian operasi)

## Masih terbuka

Tidak ada gelombang BGN tersisa di rencana ini. Food sample 7.13 dan LMS HR sengaja di luar MVP.

## Acceptance Gelombang E

- [x] Wizard E: catatan/foto validasi, tombol buat `haccp_verifications` VALIDATION, pointer rekaman, unggah bukti pelatihan
- [x] Tipe `VALIDATION` (butuh `haccpPlanId`; PASS butuh evidence)
- [x] Mode Audit: pilar + item PRP merah deep-link perbaikan (termasuk validasi & pelatihan → langkah E)
- [x] Hub CTA menyebut jumlah item belum siap audit (muncul meski antrian operasi ada, selama audit belum READY)
- [x] Verifikasi HACCP tidak ada di nav primer (hanya Pengaturan lanjutan)
- [x] Langkah E tetap bisa diisi setelah rencana APPROVED/ACTIVE (studi A–D terkunci)

## Acceptance Gelombang D

- [x] Metadata `requirementGroup` PRE-01…05, `bgnCode`, `evidenceType`, `sourceUrl`
- [x] Setup accordion 5 grup nama manusia + Ada/Belum + Catat sekarang
- [x] Seed celah kritis (air, pest kimia, thawing, reheat/saji) + backfill tenant lama
- [x] Deep-link Setup `?group=&requirementId=` + item Ada/Belum per requirementId
- [x] PDF BGN tersaji di `/api/docs/haccp-bgn`

## Acceptance Gelombang C

- [x] Result bisa menyimpan `haccpPlanId` / `ccpKey` (plan harus ACTIVE)
- [x] Operasi menampilkan antrian dari rencana aktif; empty → Setup
- [x] Deep-link Operasi → form CCP dengan template dari `templateKodeHint` (bukan pilih template acak)
- [x] HOLD → CTA **Lanjut ke perbaikan** ke follow-up `upload=1` (bukti ≤2 klik); Temuan tetap punya konteks case/batch
- [x] Banner HOLD di Hub **dan** Operasi
- [x] Hub tetap prioritaskan HOLD/Temuan
- [x] Approval menolak CCP tanpa `correctiveAction`
- [x] Hint `HACCP-*` dinormalisasi saat simpan plan
- [x] Index `haccp_results.haccpPlanId`
