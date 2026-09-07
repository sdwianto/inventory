# ADR-006: Vendor Decision on Goods Return (Category B)

**Status:** ACCEPTED  
**Tanggal:** 2026-09-07  
**Owner:** Inventory Domain / Integration  
**App host:** Inventory App (buyer) + Sales App (vendor)  
**Relates:** ADR-005 (CN dibuat dari RTV POSTED)

---

## Prinsip

> Setelah RTV diposting dan CN Sales ada (biasanya DRAFT), vendor memutuskan **per baris** Terima/Tolak. Stok buyer sudah keluar di Post tanpa menunggu keputusan (D2). Tolak mengembalikan stok fisik (bukan reversal hutang — belum pernah dibukukan untuk baris itu). Terima membuka jalur finansial CN → hutang turun.

---

## Keputusan desain (D1–D5)

| ID | Keputusan |
|----|-----------|
| **D1** | Keputusan per baris (`PENDING` / `ACCEPTED` / `REJECTED`), agregat dokumen dihitung (`NONE` / `PENDING` / `PARTIAL` / `ACCEPTED` / `REJECTED`). |
| **D2** | Stok OUT **tanpa syarat** saat RTV Post — sebelum vendor memutuskan. |
| **D3** | Baris ditolak: **tidak ada** dampak finansial hutang (CN tidak mengurangi AP untuk qty itu). |
| **D4** | SLA `vendorDecisionDueAt` = postedAt + 7 hari — highlight UI saja, **bukan** auto-accept/reject. |
| **D5** | Baris `REJECTED` tidak mengunci qty returable — buyer boleh ajukan RTV baru; stok fisik dikembalikan agar D5 benar di gudang. |

---

## Alur

```
RTV POSTED + stock OUT (+ FEFO lot consume → `lotConsume[]`, soft shortfall)
  → CN Sales DRAFT (pendingVendorDecision)
  → Vendor putuskan per baris di Sales
  → Category B push: POST Inventory /integrations/vendor-return-decision
     atau pull: POST …/vendor-returns/:id/check-decision
  → applyVendorReturnDecision
       REJECTED line → stock IN (VENDOR_RETURN_REJECTED)
         + restore lot dari `lotConsume` (match `invoiceLineId` / `lineId`; fallback SKU+gudang hanya jika unik)
       ACCEPTED line → stok tetap OUT
  → CN POSTED (qty/amount sesuai baris diterima) → credit_note.posted
       → applyCreditNoteFromVendor (ADR-005 jurnal + PPN)
```

---

## Integrasi

| Jalur | Endpoint / mekanisme |
|-------|----------------------|
| Push | `/api/integrations/vendor-return-decision` (idempotent per baris) |
| Pull | `lookupVendorReturnDecisionStatus` + `check-decision` |
| Finance | `/api/integrations/credit-note-posted` + webhook `credit_note.posted` |

Peer Sales lama yang auto-POSTED semua baris: Inventory menstempel RTV `ACCEPTED` saat CN apply **hanya jika** `payload.items` mencakup semua `invoiceLineId` RTV (full accept). Partial CN tidak menstempel — menunggu Category B decision (hindari race PARTIAL).

---

## UI copy (wajib selaras D2/D5)

- **PENDING:** stok sudah keluar; hutang belum turun sampai CN terbit setelah terima.
- **REJECTED / PARTIAL:** stok baris ditolak dikembalikan otomatis; hutang baris itu tidak berkurang; qty bebas retur ulang.
- **ACCEPTED:** stok tetap keluar; hutang via CN setelah diposting.

---

## Yang ditolak / di luar cakupan

- Auto-accept setelah SLA 7 hari
- Reverse GRN / void invoice sebagai ganti RTV

## Approval internal (SoD) — P2

Sebelum stok OUT / CN (ADR-005), RTV melewati:

```
DRAFT → submit → PENDING_APPROVAL → approve (RTV_APPROVE_ROLES) → POSTING → POSTED
                                 ↘ return-to-draft → DRAFT
```

- `RTV_CREATE_ROLES`: GUDANG, SUPERVISOR, ADMIN, MASTER — buat/edit/ajukan
- `RTV_APPROVE_ROLES`: SUPERVISOR, ADMIN, MASTER — setujui & post
- SoD: pembuat ≠ approver (kecuali ADMIN/MASTER/OWNER)
- Qty returable terkunci juga saat `PENDING_APPROVAL`
- Satu invoice: serial in-flight (`PENDING_APPROVAL` / `POSTING` / CN menunggu vendor) — submit & post diblok jika sibling masih jalan
- Stuck `POSTING` >10 menit → kembali ke `PENDING_APPROVAL` (bukan DRAFT)

---

## Dokumen terkait

- [005-goods-return-credit-note.md](./005-goods-return-credit-note.md)
- [REGISTER.md](./REGISTER.md)
- Kode: `lib/api/vendor-return-decision.ts`, `lib/api/vendor-return-returable.ts`, `types/vendor-return.ts`, `app/retur-vendor/page.tsx`
