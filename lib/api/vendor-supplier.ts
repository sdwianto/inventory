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

export async function ensureVendorSupplier(
  db: Db,
  tenantId: string | null | undefined,
  vendorTenantId: string | null | undefined,
  vendorName: string | null | undefined,
): Promise<SupplierDoc> {
  const tid = tenantId || 'default';
  const vtid = vendorTenantId || 'vendor';
  const kode = `V-${String(vtid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`;
  const existing = await db.collection('supplier').findOne({ tenantId: tid, kode });
  if (existing) return existing as unknown as SupplierDoc;

  const sup: SupplierDoc = {
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
  return sup;
}
