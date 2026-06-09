// Supplier virtual untuk vendor sales.app di sisi customer.

import { v4 as uuidv4 } from 'uuid';

export async function ensureVendorSupplier(db, tenantId, vendorTenantId, vendorName) {
  const tid = tenantId || 'default';
  const vtid = vendorTenantId || 'vendor';
  const kode = `V-${String(vtid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
  let sup = await db.collection('supplier').findOne({ tenantId: tid, kode });
  if (!sup) {
    sup = {
      id: uuidv4(),
      tenantId: tid,
      kode,
      nama: vendorName || `Vendor ${vtid}`,
      vendorTenantId: vtid,
      vendorSource: 'sales.app',
      aktif: true,
      createdAt: new Date(),
    };
    await db.collection('supplier').insertOne(sup);
  }
  return sup;
}
