import { v4 as uuidv4 } from 'uuid';
import { resolveVendorProductMap } from '@/lib/api/vendor-product-map';

export async function createGrnFromDelivery(db, tenantId, payload, vendorTenantId) {
  const now = new Date();
  const items = [];
  let needsMapping = false;

  for (const it of (payload.items || [])) {
    const mapped = await resolveVendorProductMap(db, tenantId, vendorTenantId, it);
    if (!mapped.localStokId) needsMapping = true;
    items.push({
      lineId: it.lineId || uuidv4(),
      vendorStokId: it.stokId, vendorKode: it.kode, vendorNama: it.nama,
      localStokId: mapped.localStokId, localKode: mapped.localKode, localNama: mapped.localNama,
      satuan: it.satuan, qtyOrdered: parseFloat(it.qty) || 0, qtyReceived: 0,
      harga: parseInt(it.harga || 0, 10), mapStatus: mapped.localStokId ? 'MAPPED' : 'NEEDS_MAPPING',
    });
  }

  const doc = {
    id: uuidv4(), tenantId,
    noGRN: `GRN${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`,
    status: needsMapping ? 'NEEDS_MAPPING' : 'DRAFT',
    source: 'WEBHOOK', vendorTenantId: vendorTenantId || null,
    vendorDeliveryId: payload.deliveryId, noDO: payload.noDO, noSO: payload.noSO, noPO: payload.noPO || null,
    vendorName: payload.pelangganName, lokasi: payload.lokasi, items,
    tanggal: payload.shippedAt ? new Date(payload.shippedAt) : now, createdAt: now,
  };
  await db.collection('goods_receipts').insertOne(doc);
  return doc;
}
