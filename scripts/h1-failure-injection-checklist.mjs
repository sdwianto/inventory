#!/usr/bin/env node
/**
 * H1 Step 2 helper — failure-injection checklist for ENSURE_GRN_INVOICE outbox.
 *
 * Tidak otomatis kill process di production. Gunakan di VPS setelah deploy H1.1:
 *
 * 1. Post GRN (atau gunakan mongosh setelah commit):
 *    db.integration_outbox.find({ type: 'ENSURE_GRN_INVOICE', status: 'PENDING' })
 * 2. Simulasikan "process mati sebelum drain":
 *    - Set invoiceSyncStatus SYNCING tanpa memanggil drain, ATAU
 *    - Pause inventory-worker, post GRN dengan drain disabled (dev only)
 * 3. Pastikan row outbox tetap PENDING setelah POSTED.
 * 4. Jalankan worker / GRN_INVOICE_SYNC → outbox DONE + noInvoice / FAILED jelas.
 *
 * Exit 0 = print checklist only.
 */
console.log(`=== H1.1 failure-injection checklist ===

A. Setelah POSTED (sebelum drain selesai), harus ada:
   integration_outbox { type: ENSURE_GRN_INVOICE, aggregateId: <grnId>, status: PENDING|PROCESSING }

B. Kill / skip drain → row tidak hilang.

C. Drain worker (GRN_INVOICE_SYNC):
   → status DONE + goods_receipts.noInvoice
   ATAU status FAILED + invoiceSyncError (bukan Menunggu)

D. Double drain: claim kedua harus no-op / alreadyDone (idempotent peer).

E. UI: Success | Failed (+ alasan) — bukan Pending.
`);
process.exit(0);
