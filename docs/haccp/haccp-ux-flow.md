# Keamanan Pangan — UX flow (Gelombang 0)

## Masalah

Sidebar lama menampilkan ~10 item setara (Dashboard, Monitoring, Cases, Follow Up, Prerequisite, HACCP Study, Verify, Audit Readiness, Reports, Analytics). Operator tersesat; HACCP terasa silo.

## Solusi

Satu grup **Keamanan Pangan** dengan jalur primer:

1. **Beranda** `/kitchen-assurance` — satu next-CTA
2. **Setup kesiapan** `/kitchen-assurance/setup`
3. **Operasi harian** `/kitchen-assurance/operasi`
4. **Temuan & perbaikan** `/kitchen-assurance/temuan`
5. **Siap audit** `/kitchen-assurance/audit`

Item Monitoring / Reports / Analytics **tidak** di sidebar primer. Mereka ada di Beranda → **Pengaturan lanjutan** (collapsed).

Route teknis lama (`/food-production/haccp-plan`, `prerequisite`, `haccp`, `cold-chain`, `cases`, `follow-up`, `audit-readiness`) tetap hidup sebagai deep-link, dengan breadcrumb kembali ke mode terkait.

## Prioritas next-CTA

Implementasi: [lib/food-safety/hub-next-action.ts](../../lib/food-safety/hub-next-action.ts)

1. HOLD / issue / follow-up terbuka → Temuan  
2. Belum ada plan ACTIVE → Setup / lanjutkan draft  
3. Ada antrian operasi **dan** audit sudah READY → Operasi  
4. Audit bukan READY → Audit (“X item belum siap audit”)  
5. Default → Operasi  

## Operasi ↔ rencana (Gelombang C)

- Antrian **Wajib hari ini** dibangun dari `monitoringPlans` rencana ACTIVE (`lib/food-safety/operasi-queue.ts`).
- Catatan CCP menyimpan `haccpPlanId` + `ccpKey`; hint template dinormalisasi ke `HCP-*` saat simpan.
- FAIL + HOLD: toast **Lanjut ke perbaikan** → `/kitchen-assurance/follow-up?caseId=&upload=1` (dialog bukti terbuka).
- Banner HOLD di Beranda dan Operasi — tanpa harus buka Batch & Expiry.
- Follow-up OPEN dibuat otomatis saat HOLD (satu FU aktif per issue).

## Persona

| Persona | CTA tipikal |
|---------|-------------|
| Petugas dapur | Operasi / Temuan |
| PIC mutu | Setup wizard + Operasi |
| Manajer / auditor | Audit |

## Wizard rencana HACCP

Stepper A–E di [components/food-safety/HaccpWizardStepper.tsx](../../components/food-safety/HaccpWizardStepper.tsx), dipasang di `/food-production/haccp-plan?wizard=1`.

- A–C: preamble (tim, produk, alur) — Gelombang B  
- D: form study existing (bahaya / CCP / limit / monitoring)  
- E: validasi rencana, pointer rekaman, bukti pelatihan — Gelombang E  

Mode **Siap audit** memuat pilar kesiapan (termasuk validasi rencana & bukti pelatihan); item merah deep-link ke Setup / Operasi / Temuan / Wizard `?step=E`. Setelah rencana aktif, langkah E tetap bisa diisi. Verifikasi HACCP daftar teknis tetap di Pengaturan lanjutan, bukan nav primer.

## Ownership data

Tidak berubah (ADR-004): FP owns checklist/HACCP/temp/batch; KA owns finding/action. Hub hanya UI journey.
