// Filter update/hapus by-id yang selalu terkunci ke tenant dokumen.

import { tenantIdMatchFilter } from '@/lib/api/tenant-scope';

type DocRef = { id?: unknown; tenantId?: unknown };

/** Dokumen yang sudah dibaca: kunci ke nilai `tenantId` yang tersimpan (bila ada). */
export function docIdFilter(doc: object, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const d = doc as DocRef;
  const tenant = typeof d.tenantId === 'string' && d.tenantId ? { tenantId: d.tenantId } : {};
  return { ...extra, ...tenant, id: d.id };
}

/** Pemanggil yang hanya memegang id + tenant (dokumen lama tanpa tenantId ikut cocok untuk tenant default). */
export function idInTenant(id: unknown, tenantId: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, ...tenantIdMatchFilter(tenantId), id };
}
