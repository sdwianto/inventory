# BGN Requirement Matrix (baseline)

**Sumber:** [HACCP BGN.pdf](./HACCP%20BGN.pdf) — Lampiran III Checklist Sertifikasi HACCP.  
**Status dokumen:** baseline Gelombang A (bukan seed DB).  
**UI path:** jalur di hub Keamanan Pangan (Gelombang 0).

> Label `BGN-PRP-*` di seed lama adalah kode internal contoh, bukan nomor pasal resmi dokumen.

## Grup UI

| Grup | Isi BGN | Mode UI |
|------|---------|---------|
| PRE-01 … PRE-05 | Bagian I–IV (facility, equipment/utilities, hygiene, personnel, hygienic process) | Setup → PRP |
| HACCP-01 … HACCP-13 | Bagian VIII 8.1–8.13 | Setup → Wizard A–E + Operasi/Temuan/Audit |

## Prerequisite (ringkas — I–IV)

| requirementCode | Grup | Ringkas | evidenceType | linkedEntity | uiPath | coverageStatus |
|-----------------|------|---------|--------------|--------------|--------|----------------|
| BGN-1 | PRE-01 | Lokasi bebas kontaminan / banjir | CHECKLIST/PHOTO | QC | Setup/PRP | PARTIAL |
| BGN-3.1–3.7 | PRE-01 | Bangunan & area food handling | CHECKLIST/PHOTO | QC | Setup/PRP | PARTIAL |
| BGN-4.x | PRE-02 | Peralatan saniter & identifikasi limbah | CHECKLIST | QC | Setup/PRP | PARTIAL |
| BGN-3.12–3.14 | PRE-02 | Air, limbah, pendinginan + alat ukur suhu | CHECKLIST/MEASUREMENT | QC + temperature_logs | Setup/PRP + Operasi | PARTIAL |
| BGN-5.x | PRE-03 | Maintenance, cleaning, pest, chemical | CHECKLIST | QC | Setup/PRP | PARTIAL |
| BGN-6.x | PRE-04 | Hygiene & kesehatan personel + pelatihan lean | CHECKLIST/DOCUMENT | QC | Setup/PRP | PARTIAL |
| BGN-7.1–7.4 | PRE-05 | Bahan baku, storage, thawing | CHECKLIST/MEASUREMENT | QC + GRN + temp | Setup/PRP + Operasi | PARTIAL |
| BGN-7.5–7.10 | PRE-05 | Cook/cool/hold/dist/reheat/serve | MEASUREMENT/RECORD | HACCP result + temp | Operasi | PARTIAL |
| BGN-7.11 / 7.13 | PRE-05 | Label lot / food sample | RECORD | production_batches | Operasi / Future | PARTIAL / MISSING |

## HACCP study (Bagian VIII)

| requirementCode | Wizard | Requirement | linkedEntity | uiPath | coverageStatus |
|-----------------|--------|-------------|--------------|--------|----------------|
| BGN-8.1 | A | Tim + scope | haccp_plans | Setup/Wizard-A | COVERED |
| BGN-8.2 | B | Deskripsi produk | haccp_plans (+ recipe/menu) | Setup/Wizard-B | COVERED |
| BGN-8.3 | B | Intended use | haccp_plans | Setup/Wizard-B | COVERED |
| BGN-8.4 | C | Flow diagram / process steps | haccp_plans.processSteps + diagram | Setup/Wizard-C | COVERED |
| BGN-8.5 | C | Verifikasi flow lapangan | haccp_plans.flowVerified* | Setup/Wizard-C | COVERED |
| BGN-8.6 | D | Hazard analysis | haccp_plans.hazards | Setup/Wizard-D | COVERED |
| BGN-8.7 | D | CCP | haccp_plans.ccps | Setup/Wizard-D | COVERED |
| BGN-8.8 | D | Critical limit | haccp_plans.criticalLimits | Setup/Wizard-D | COVERED |
| BGN-8.9 | D+Ops | Monitoring | monitoringPlans + haccp_results | Wizard-D + Operasi | PARTIAL |
| BGN-8.10 | D+Temuan | Corrective action | CCP text + KA FU | Wizard-D + Temuan | PARTIAL |
| BGN-8.11 | E | Validation + verification | haccp_verifications + plan.validation* | Wizard-E + Audit | COVERED |
| BGN-8.12 | E+Audit | Documentation & records | results/temp/QC/KA (pointer) | Wizard-E + Audit | COVERED |
| BGN-8.13 | E | Training evidence (lean) | plan.training* upload | Wizard-E | COVERED |

## Catatan

- SLHS = fondasi PRP sebelum HACCP (disebutkan di badan pedoman BGN).
- Food sample 7.13 = Future, bukan MVP.
- Training = evidence-based, bukan HR module.
