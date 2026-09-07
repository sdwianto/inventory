# ADR-005: Goods Return Posted → Sales Credit Note (Category A)

**Status:** ACCEPTED  
**Tanggal:** 2026-09-07  
**Owner:** Inventory Domain / Integration  
**App host:** Inventory App (buyer) + Sales App (vendor)  
**Relates:** ADR-006 (vendor decision per baris setelah CN DRAFT)

---

## Prinsip

> Inventory owns physical stock and the buyer RTV document. Sales owns the Credit Note document lifecycle. Category A push creates (or idempotently reuses) a Sales CN from a POSTED Vendor Return — it does not reverse the GRN or unpost the vendor invoice.

---

## Kenapa pola ini

Procurement multi-tenant: buyer Inventory dan vendor Sales adalah app terpisah. Setelah GRN POSTED dan invoice masuk sebagai hutang, buyer boleh meretur qty yang masih returable. Stok harus keluar dari gudang buyer **sebelum** vendor memutuskan (ADR-006 D2). Credit note adalah dokumen finansial di sisi vendor; Inventory hanya mengaplikasikan dampak AP setelah CN relevan.

---

## Cakupan

```
Inventory RTV (source=hutang) POSTED
  → stock OUT (VENDOR_RETURN) + optional FEFO lot consume
  → outbox ENSURE_GOODS_RETURN_CN
  → POST {sales}/api/v1/integrations/goods-return-posted
       Idempotency-Key = returnId
  → Sales CreateCreditNoteFromGoodsReturn (biasanya DRAFT + pendingVendorDecision)
  → (bila CN langsung POSTED — peer lama) applyCreditNoteFromVendor di Inventory
```

**Bukan** cakupan ADR ini:
- GRN-reject RTV (`source=grn-reject`) — tidak pernah tertagih → CN `SKIPPED`
- Retur penjualan / RMA / AR (seller-side) — di luar Inventory buyer
- Unpost GRN / void invoice

---

## Kontrak integrasi

| Field | Peran |
|-------|--------|
| `returnId` | Idempotency key + correlation |
| `invoiceId` / `noInvoice` | Anchor ke invoice Sales / hutang |
| `items[].lineId` | = Sales invoice `lineId` (wajib) |
| `items[].uomId` | = Sales `vendorUomId` (wajib) |
| `photos`, `items[].reason` | Bukti untuk keputusan vendor (ADR-006) |

Recovery: outbox drain, `POST …/retry-cn`, bg job `GOODS_RETURN_CN_SYNC`, inbound `credit_note.posted`.

---

## Akuntansi (Inventory)

### Post RTV (hutang path, paired Sales — `canSyncCn`)

```
Dr Barang dalam retur (10315)   (net = sum items.jumlah)
Cr Persediaan (10310)           (sama)
```

Idempotent: `sourceType=RTV_TRANSIT_OUT`, `sourceId=returnId`. Flag `transitAppliedAt` / `transitAmount` di dokumen RTV.

`grn-reject` dan RTV `cnSyncStatus=SKIPPED` (tidak paired): **tanpa** transit (qty OUT saja — kompatibel perilaku lama).

### CN accept (`applyCreditNoteFromVendor` / `AUTO_CN_VENDOR`)

Bila RTV punya `transitAppliedAt`:

```
Dr Hutang          (gross = amount CN)
Cr Barang dalam retur  (net  = gross − PPN proporsional)
Cr PPN Masukan     (ppn proporsional, bila ppn>0)
```

Legacy RTV tanpa transit: Cr **Persediaan** (net) seperti sebelumnya.

Clear transit **race-safe**: lookup RTV by `creditNoteId` **atau** `noReturn` / `returnId` (Category A bisa apply CN sebelum `creditNoteId` ter-stamp). Caller boleh set `opts.clearTransit` eksplisit (`notify`, `check-decision`, inbound/webhook).

### Vendor reject baris (Category B)

```
Dr Persediaan
Cr Barang dalam retur   (amount = items[].jumlah baris ditolak)
```

Idempotent: `sourceType=RTV_TRANSIT_RESTORE`, `sourceId={returnId}:{invoiceLineId|lineId}`. Flag `items[].transitRestoredAt` (arrayFilter by `invoiceLineId`, fallback `lineId`).

Rasio PPN CN diambil dari hutang invoice asal. Bila hutang tanpa PPN, seluruh amount ke transit/Persediaan.

---

## Invariant

1. RTV dari hutang wajib GRN POSTED.
2. Qty ≤ returable (invoice − RTV POSTED/POSTING − CN manual non-`inventory_return`; baris REJECTED tidak mengunci qty).
3. Satu RTV dengan `vendorDecision=PENDING` + `creditNoteId` per invoice (Sales: satu CN DRAFT per invoice).
4. Post claim `DRAFT→POSTING→POSTED` (anti double-post).
5. Apply CN idempotent by `creditNoteId`.

---

## Dokumen terkait

- [006-vendor-return-decision.md](./006-vendor-return-decision.md)
- [007-cn-b2b-stock-boundary.md](./007-cn-b2b-stock-boundary.md) — CN manual B2B tidak IN gudang buyer; `storeRestockStatus` wire only
- [REGISTER.md](./REGISTER.md)
- Kode: `lib/api/vendor-return-post.ts`, `lib/api/goods-return-notify-sales.ts`, `lib/api/hutang-from-vendor.ts`, `lib/api/journal-lines.ts`
