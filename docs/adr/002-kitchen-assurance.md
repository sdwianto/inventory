# ADR-002: Kitchen Assurance (MBG Operational Guardrail)

**Status:** ACCEPTED  
**Tanggal:** 2026-07-20  
**Revisi:** Final architecture lock (exception-driven Monitoring) — 2026-07-20  
**Owner:** Inventory Domain / Product Architecture  
**App host:** Inventory App  
**Relates:** ADR-001 (Food Production owns cold chain / HACCP / QC data)

---

## Prinsip

> Kitchen Assurance observes operational safety conditions and coordinates corrective actions without owning Food Production, Quality, or Maintenance domain logic.

> Dapur bekerja untuk menghasilkan makanan. Kitchen Assurance hanya memastikan makanan, manusia, proses, dan alat tetap aman selama pekerjaan itu berlangsung.

KA adalah **operational guardrail**, bukan sistem HSE/audit, bukan pekerjaan utama operator.

```
Food Production
       |
       v
Safe Kitchen Operation
```

---

## Empat pilar (lensa — bukan menu)

Urutan tetap (Food Safety = prioritas #1 MBG):

1. **Food Safety**  
2. **People Safety**  
3. **Operational Safety**  
4. **Equipment Safety**  

Bukan modul/menu terpisah. Filter/category di dalam Dashboard / Monitoring / Cases / Reports.

---

## Navigasi

```
Kitchen Assurance
├── Dashboard      ← Apakah dapur aman hari ini?
├── Monitoring     ← Exception / Attention Needed saja
├── Cases          ← Issue/Case (Incident = salah satu tipe)
├── Follow Up
├── Reports
└── Analytics
```

Jangan tambah menu Food Safety / Incident / Checklist / Equipment Safety.

---

## Monitoring = exception-driven

**Bukan** daftar semua yang OK.  
**Adalah:** kondisi yang perlu perhatian.

- Ada attention → tampilkan 🔴/🟡  
- Kosong → **✓ Semua aman**

Sumber dibaca dari owner (Capability Ownership):

| Area | Owner | Surface |
|------|--------|---------|
| Cold Chain / HACCP / QC / Ingredient | Food Production | Monitoring Food |
| Equipment condition | Maintenance | Monitoring Equipment (Ready / Attention / Unsafe) |
| Cleaning / Waste / Chemical | KA (tipis) | Monitoring Operational |
| People incident | KA / HR nanti | Cases |

---

## Cases

```
Observation (optional, ringan)
        ↓
   Case / Issue
        ↓
   Follow Up (optional)
        ↓
      Closed
```

- UI: **Issue / Case** — bukan “Incident Report”
- Incident = salah satu `caseKind` saja
- Tidak ada: CAPA, risk matrix, resolution engine, investigation workflow HSE

---

## Data model minimal

- **Core:** `ka_safety_cases` (Issue/Case), `ka_follow_ups`  
- **Optional:** `ka_observations` (event ringan — jangan Observation Management System)  
- **Read:** `temperature_logs`, maintenance schedules/requests, QC/HACCP FP  

### Deprecated / frozen (P0 surplus — jangan expand)

- Policy Engine KA (`ka_policies`, apply-by-policy)  
- Daily Checklist Engine  
- Compliance sebagai pillar  
- Resolution Engine  
- Formal Kitchen Health Index / Risk Score  

---

## Roadmap

| Phase | Fokus |
|-------|--------|
| **P1** | Dashboard Kitchen Status + Monitoring Attention Surface ✅ |
| **P2** | Cases (Issue) + Follow Up operasional ✅ |
| **P3** | Automation ringan ✅ — Monitoring→Issue; auto Issue cold-chain CRITICAL |
| **P4** | Reports per 4 pilar ✅ (`GET /ka-reports`) |
| **P5** | Analytics + AI Recommendation ✅ (`GET /ka-analytics`, rule-based) |

**Audit lock (2026-07-20):** Policy/Resolution/definitions write paths → 410; PM attention kitchen-scoped; Reports↔Analytics closed metrics aligned; FU deep-link shows OPEN+DONE; `sourceKey` unique index for open Issues.

---

## Ditolak

- Menu per-pilar  
- Duplikasi Cold Chain / HACCP / WR ke dalam KA  
- HSE-style documentation workflows  
- Benchmark lintas dapur / AI prediction suite di MVP  
