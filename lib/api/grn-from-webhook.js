import { v4 as uuidv4 } from 'uuid';
import { resolveProductByKode } from '@/lib/api/resolve-product-by-kode';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { resolveVendorTenantName } from '@/lib/api/grn-enrich';
import { ensureUniqueLineIds } from '@/lib/api/grn-line-ids';

export async function createGrnFromDelivery(db, tenantId, payload, vendorTenantId) {
  const tid = tenantId || 'default';
  if (payload.deliveryId) {
    const existing = await db.collection('goods_receipts').findOne({
      tenantId: tid,
      vendorDeliveryId: payload.deliveryId,
    });
    if (existing) {
      await db.collection('goods_receipts').updateOne(
        { id: existing.id },
        {
          $set: {
            noDO: payload.noDO || existing.noDO,
            noSO: payload.noSO || existing.noSO,
            noPO: payload.noPO || existing.noPO,
            vendorTenantId: vendorTenantId || existing.vendorTenantId,
            vendorDeliverySnapshot: payload,
            updatedAt: new Date(),
          },
        },
      );
      return { ...existing, vendorDeliverySnapshot: payload };
    }
  }

  const now = new Date();
  const noGRN = await nextDocNumber(db, tenantId, 'GRN', 'GRN');
  const items = [];
  let hasUnknown = false;

  for (const it of (payload.items || [])) {
    const resolved = await resolveProductByKode(db, tenantId, vendorTenantId, it);
    if (!resolved.localStokId) hasUnknown = true;
    items.push({
      lineId: it.lineId || uuidv4(),
      vendorStokId: it.stokId, vendorKode: it.kode, vendorNama: it.nama,
      localStokId: resolved.localStokId, localKode: resolved.localKode, localNama: resolved.localNama,
      satuan: it.satuan, qtyOrdered: parseFloat(it.qty) || 0, qtyReceived: 0,
      harga: parseInt(it.harga || 0, 10), mapStatus: resolved.localStokId ? 'MAPPED' : 'UNKNOWN',
    });
  }

  const vendorTenantName = await resolveVendorTenantName(db, tid, vendorTenantId);

  const { items: uniqueItems } = ensureUniqueLineIds(items);

  const doc = {
    id: uuidv4(), tenantId: tid,
    noGRN,
    status: hasUnknown ? 'UNKNOWN_PRODUCT' : 'DRAFT',
    source: 'WEBHOOK', vendorTenantId: vendorTenantId || null,
    vendorTenantName: vendorTenantName || null,
    vendorDeliveryId: payload.deliveryId, noDO: payload.noDO, noSO: payload.noSO, noPO: payload.noPO || null,
    vendorDeliverySnapshot: payload,
    vendorName: vendorTenantName || vendorTenantId || null,
    lokasi: payload.lokasi, items: uniqueItems,
    tanggal: payload.shippedAt ? new Date(payload.shippedAt) : now, createdAt: now,
  };
  await db.collection('goods_receipts').insertOne(doc);
  return doc;
}
