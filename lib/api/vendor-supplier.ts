import type { Db } from 'mongodb';
// Supplier virtual untuk vendor sales.app di sisi customer.

import { v4 as uuidv4 } from 'uuid';

type SupplierDoc = Record<string, unknown> & {
  id: string;
  tenantId: string;
  kode: string;
  nama: string;
  vendorTenantId: string;
  vendorSource: string;
  aktif: boolean;
  createdAt: Date;
};

function isPlaceholderSupplierName(nama: string | null | undefined, vtid: string): boolean {
  const n = String(nama || '').trim();
  if (!n) return true;
  if (n.toLowerCase() === 'sales.app vendor') return true;
  if (n === `Vendor ${vtid}`) return true;
  return false;
}

export async function ensureVendorSupplier(
  db: Db,
  tenantId: string | null | undefined,
  vendorTenantId: string | null | undefined,
  vendorName: string | null | undefined,
): Promise<SupplierDoc> {
  const tid = tenantId || 'default';
  const vtid = vendorTenantId || 'vendor';
  const kode = `V-${String(vtid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
  const nextName = String(vendorName || '').trim() || `Vendor ${vtid}`;
  const existing = await db.collection('supplier').findOne({ tenantId: tid, kode });
  if (existing) {
    if (isPlaceholderSupplierName(existing.nama as string, vtid) && nextName !== existing.nama) {
      await db.collection('supplier').updateOne(
        { id: existing.id },
        { $set: { nama: nextName, updatedAt: new Date() } },
      );
      return { ...(existing as unknown as SupplierDoc), nama: nextName };
    }
    return existing as unknown as SupplierDoc;
  }

  const sup: SupplierDoc = {
    id: uuidv4(),
    tenantId: tid,
    kode,
    nama: nextName,
    vendorTenantId: vtid,
    vendorSource: 'sales.app',
    aktif: true,
    createdAt: new Date(),
  };
  await db.collection('supplier').insertOne(sup);
  return sup;
}
