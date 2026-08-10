# Architecture Decision Register — Inventory App

**Status:** ACTIVE  
**Maintainer:** Inventory Domain / Product Architecture

---

## Register

| ID | Judul | Status | Tanggal | Owner | Dokumen |
|----|-------|--------|---------|-------|---------|
| **ADR-001** | Food Production Domain Architecture (MBG-first) | **ACCEPTED** (revisi 2026-07-28) | 2026-07-15 | Inventory Domain | [001-food-production-domain.md](./001-food-production-domain.md) |
| **ADR-002** | Kitchen Assurance (MBG Operational Guardrail) | **ACCEPTED** (revisi 2026-07-28) | 2026-07-20 | Inventory Domain | [002-kitchen-assurance.md](./002-kitchen-assurance.md) |
| **ADR-003** | Logistics Domain | **ACCEPTED** | 2026-07-28 | Inventory Domain | [003-logistics-domain.md](./003-logistics-domain.md) |
| **ADR-004** | Food Safety (Disposition Control & Audit Lens) | **ACCEPTED** | 2026-08-10 | Inventory Domain | [004-food-safety.md](./004-food-safety.md) |

### ADR-001 (ringkas)

| Field | Value |
|-------|--------|
| Filosofi | Simple for Kitchen Operators, Powerful for Management |
| Aggregate Root | Production Plan |
| Domain | Master · Planning · Kitchen Operation (+QC/Cold Chain/HACCP) · **Dispatch** · Management |
| Revisi 2026-07-28 | Armada + Delivery keluar ke ADR-003; Service Point = Destination Master / shared (tidak dipindah) |

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
| Revisi 2026-07-28 | Capability Ownership eksplisit: KA read-model, tidak own QC/HACCP/Cold Chain (Food Production tetap owner) |

### ADR-003 (ringkas)

| Field | Value |
|-------|--------|
| Filosofi | Logistics owns getting food from dispatch point to destination — bukan qty/isi barang |
| Lahir dari | Pemisahan Food Production (`docs/migration/FOOD-PRODUCTION-DOMAIN-SPLIT.md`, Sprint 1–5) |
| Domain | Armada · Delivery (loading/armada/stop/drop) · Roles (`LOGISTICS_DELIVERY_STATUS_ROLES`) |
| Bukan cakupan | Dispatch (tetap Food Production) · Service Point (shared, bukan milik Logistics) |
| Storage | `Delivery*` masih embedded di `DispatchDoc` (collection `distribution_orders`) — belum dipisah fisik |

### ADR-004 (ringkas)

| Field | Value |
|-------|--------|
| Filosofi | Food Safety controls the *disposition* of food, but does not own the underlying production or inventory data |
| Bukan | Bounded context keempat — lensa audit + kontrol disposisi di atas FP & KA |
| Unit disposisi | **Production Batch** (satu batch per finished good per result) |
| Sumbu status | `status` (ACTIVE/EXPIRED/CONSUMED) vs `foodSafetyStatus` (PENDING/PASS/HOLD/RELEASED) — tidak pernah dicampur |
| Sumbu hasil | `haccp_results.status` (workflow) vs `disposition` (PENDING/PASS/FAIL); COMPLETED ≠ lolos |
| Core invariant | `holdOnFail ⇒ critical`; CCP ⇒ keduanya **derived & tidak dapat dimatikan** |
| Blast radius | Terikat batch → auto HOLD; terikat lingkungan → proposed HOLD + konfirmasi supervisor |
| Aturan P0 | HOLD terjadi saat kegagalan **disimpan**, bukan saat pemeriksaan selesai |
| Traceability | Read model dari `material_requirements.sources[]` — candidate-lot inference, bukan ledger baru |
| Supersedes sebagian | ADR-001 §Phase 5 (HACCP evidence "DONE"), ADR-002 §Frozen (klarifikasi Checklist Engine) |
