// Sinkron status Customer PO dari webhook vendor (sales.app).

import { buildVendorSoSnapshot } from '@/lib/api/vendor-so-snapshot';

function findCpoFilter(tenantId, payload) {
  const base = { tenantId };
  if (payload.customerPoId) return { ...base, id: payload.customerPoId };
  if (payload.noPO) return { ...base, noPO: payload.noPO };
  if (payload.salesOrderId) return { ...base, vendorSoId: payload.salesOrderId };
  if (payload.noSO) return { ...base, vendorNoSO: payload.noSO };
  return null;
}

function rollupShipStatus(items) {
  if (!items?.length) return 'SHIPPED';
  const allShipped = items.every((it) => (it.qtyShipped || 0) >= (it.qty || 0));
  const anyShipped = items.some((it) => (it.qtyShipped || 0) > 0);
  if (allShipped) return 'SHIPPED';
  if (anyShipped) return 'PARTIAL_SHIPPED';
  return 'CONFIRMED';
}

function rollupReceiveStatus(items) {
  if (!items?.length) return 'RECEIVED';
  const allReceived = items.every((it) => (it.qtyReceived || 0) >= (it.qty || 0));
  const anyReceived = items.some((it) => (it.qtyReceived || 0) > 0);
  if (allReceived) return 'RECEIVED';
  if (anyReceived) return 'PARTIAL_RECEIVED';
  return 'SHIPPED';
}

export async function syncCpoFromVendorEvent(db, tenantId, event, payload) {
  const filter = findCpoFilter(tenantId, payload);
  if (!filter) return { action: 'skipped', reason: 'no_po_reference' };

  const po = await db.collection('customer_purchase_orders').findOne(filter);
  if (!po) return { action: 'not_found', filter };

  const now = new Date();
  const patch = { updatedAt: now, lastVendorEvent: event, lastVendorEventAt: now };

  if (event === 'sales_order.confirmed') {
    patch.status = 'CONFIRMED';
    patch.confirmedAt = payload.confirmedAt ? new Date(payload.confirmedAt) : now;
    patch.vendorSoId = payload.salesOrderId || po.vendorSoId;
    patch.vendorNoSO = payload.noSO || po.vendorNoSO;
    const soSnap = buildVendorSoSnapshot(payload);
    if (soSnap) patch.vendorSoSnapshot = soSnap;
  } else if (event === 'delivery.shipped') {
    const items = (po.items || []).map((line) => {
      const shipped = (payload.items || []).find(
        (s) => s.kode === line.vendorKode || s.kode === line.kode || s.stokId === line.vendorStokId,
      );
      const add = parseFloat(shipped?.qty) || 0;
      return { ...line, qtyShipped: (line.qtyShipped || 0) + add };
    });
    patch.items = items;
    patch.status = rollupShipStatus(items);
    patch.shippedAt = payload.shippedAt ? new Date(payload.shippedAt) : now;
    patch.vendorNoDO = payload.noDO || po.vendorNoDO;
  } else if (event === 'invoice.posted') {
    patch.status = 'INVOICED';
    patch.invoicedAt = payload.postedAt ? new Date(payload.postedAt) : now;
    patch.vendorNoInvoice = payload.noInvoice || po.vendorNoInvoice;
    patch.vendorInvoiceId = payload.invoiceId || po.vendorInvoiceId;
    patch.invoiceTotal = parseInt(payload.total || 0, 10);
  }

  await db.collection('customer_purchase_orders').updateOne({ id: po.id }, { $set: patch });
  return { action: 'updated', poId: po.id, noPO: po.noPO, status: patch.status };
}

/** Update qty diterima setelah GRN diposting. */
export async function syncCpoOnGrnPosted(db, grn) {
  if (!grn?.noPO) return { action: 'skipped' };
  const po = await db.collection('customer_purchase_orders').findOne({
    tenantId: grn.tenantId,
    noPO: grn.noPO,
  });
  if (!po) return { action: 'not_found' };

  const items = (po.items || []).map((line) => {
    const recv = (grn.items || []).find(
      (g) => g.vendorKode === line.vendorKode || g.localKode === line.kode,
    );
    const add = parseFloat(recv?.qtyReceived) || 0;
    return { ...line, qtyReceived: (line.qtyReceived || 0) + add };
  });

  const status = rollupReceiveStatus(items);
  await db.collection('customer_purchase_orders').updateOne(
    { id: po.id },
    {
      $set: {
        items,
        status,
        receivedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  return { action: 'updated', poId: po.id, status };
}
