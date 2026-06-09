// Hutang usaha dari invoice vendor (sales.app) + koreksi credit note.

import { v4 as uuidv4 } from 'uuid';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { ensureVendorSupplier } from '@/lib/api/vendor-supplier';

function genNoHutang(now = new Date()) {
  return `HT${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`;
}

export async function createHutangFromVendorInvoice(db, customerTenantId, payload, vendorTenantId) {
  const tid = customerTenantId || 'default';
  const invoiceId = payload.invoiceId;
  if (!invoiceId) return { error: 'invoiceId wajib' };

  const existing = await db.collection('hutang').findOne({
    tenantId: tid,
    vendorInvoiceId: invoiceId,
    referenceType: 'VENDOR_INVOICE',
  });
  if (existing) return { action: 'exists', hutangId: existing.id, noHutang: existing.noHutang };

  const paymentTerms = payload.paymentTerms || 'KREDIT';
  if (paymentTerms === 'TUNAI') {
    return { action: 'skipped_cash', invoiceId };
  }

  const total = parseInt(payload.total || 0, 10);
  if (total <= 0) return { error: 'total invoice tidak valid' };

  const sup = await ensureVendorSupplier(
    db,
    tid,
    vendorTenantId,
    payload.pelangganName ? `Vendor (${payload.pelangganName})` : 'sales.app Vendor',
  );

  const now = new Date();
  const jatuhTempo = payload.jatuhTempo ? new Date(payload.jatuhTempo) : new Date(now.getTime() + 30 * 86400000);

  const hutang = stampTenantId(tid, {
    id: uuidv4(),
    noHutang: genNoHutang(now),
    noInvoice: payload.noInvoice,
    vendorInvoiceId: invoiceId,
    noDO: payload.noDO || null,
    noSO: payload.noSO || null,
    noPO: payload.noPO || null,
    deliveryId: payload.deliveryId || null,
    salesOrderId: payload.salesOrderId || null,
    tanggal: payload.postedAt ? new Date(payload.postedAt) : now,
    supplierId: sup.id,
    supplierName: sup.nama,
    vendorTenantId: vendorTenantId || null,
    referenceType: 'VENDOR_INVOICE',
    referenceId: invoiceId,
    subTotal: parseInt(payload.subTotal || total, 10),
    ppn: parseInt(payload.ppn || 0, 10),
    total,
    terbayar: 0,
    sisa: total,
    jatuhTempo,
    status: 'OUTSTANDING',
    paymentTerms,
    items: payload.items || [],
    createdAt: now,
  });

  await db.collection('hutang').insertOne(hutang);

  if (payload.noDO) {
    await db.collection('goods_receipts').updateMany(
      { tenantId: tid, noDO: payload.noDO, vendorInvoiceId: { $exists: false } },
      { $set: { vendorInvoiceId: invoiceId, noInvoice: payload.noInvoice, hutangId: hutang.id } },
    );
  }

  return { action: 'created', hutangId: hutang.id, noHutang: hutang.noHutang, total };
}

export async function applyCreditNoteFromVendor(db, customerTenantId, payload, vendorTenantId) {
  const tid = customerTenantId || 'default';
  const invoiceId = payload.invoiceId;
  const creditTotal = parseInt(payload.total || 0, 10);
  if (!invoiceId || creditTotal <= 0) return { error: 'invoiceId dan total wajib' };

  const hutang = await db.collection('hutang').findOne({
    tenantId: tid,
    vendorInvoiceId: invoiceId,
    referenceType: 'VENDOR_INVOICE',
  });
  if (!hutang) return { action: 'no_hutang', invoiceId };

  const reduce = Math.min(creditTotal, hutang.sisa || 0);
  if (reduce <= 0) return { action: 'nothing_to_reduce' };

  const now = new Date();
  const newTerbayar = (hutang.terbayar || 0) + reduce;
  const newSisa = hutang.total - newTerbayar;
  await db.collection('hutang').updateOne(
    { id: hutang.id },
    {
      $set: {
        terbayar: newTerbayar,
        sisa: newSisa,
        status: newSisa <= 0 ? 'LUNAS' : 'PARTIAL',
        updatedAt: now,
      },
      $push: {
        creditNotes: {
          creditNoteId: payload.creditNoteId,
          noCN: payload.noCN,
          amount: reduce,
          postedAt: payload.postedAt || now,
        },
      },
    },
  );

  return {
    action: 'credit_applied',
    hutangId: hutang.id,
    reduced: reduce,
    sisa: newSisa,
    vendorTenantId,
  };
}
