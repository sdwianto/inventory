# Architecture Decision Register — Inventory App

**Status:** ACTIVE  
**Maintainer:** Inventory Domain / Product Architecture

---

## Register

| ID | Judul | Status | Tanggal | Owner | Dokumen |
|----|-------|--------|---------|-------|---------|
| **ADR-001** | Food Production Domain Architecture (MBG-first) | **ACCEPTED** | 2026-07-15 | Inventory Domain | [001-food-production-domain.md](./001-food-production-domain.md) |
| **ADR-002** | Kitchen Assurance (MBG Operational Guardrail) | **ACCEPTED** | 2026-07-20 | Inventory Domain | [002-kitchen-assurance.md](./002-kitchen-assurance.md) |

### ADR-001 (ringkas)

| Field | Value |
|-------|--------|
| Filosofi | Simple for Kitchen Operators, Powerful for Management |
| Aggregate Root | Production Plan |
| Domain | Master · Planning · Operation · **Management** |

### ADR-002 (ringkas)

| Field | Value |
|-------|--------|
| Filosofi | Operational guardrail — bukan HSE/audit |
| Prinsip | Observe safety conditions; tidak own FP / Quality / Maintenance logic |
| Pilar (urutan tetap) | Food → People → Operational → Equipment |
| Nav | Dashboard · Monitoring · Cases · Follow Up · Reports · Analytics |
| Monitoring | Exception-driven (Attention Needed / Semua aman) |
| Core data | `ka_safety_cases`, `ka_follow_ups` (+ `ka_observations` opsional) |
| Frozen | Policy Engine, Checklist Engine, Risk, Resolution, Compliance pillar |
| Roadmap | P1–P5 ✅ (Dashboard → Monitoring → Cases/FU → Automation → Reports → Analytics/AI Rec) |
