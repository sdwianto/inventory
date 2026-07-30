import type { NextResponse } from 'next/server';
import { ok, err, clean, okCached } from '@/lib/api/db';
import {
  withTenantFilter,
  findMasterDoc,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { assertMasterAccess } from '@/lib/api/tenant-validate';
import { bulkDeleteMaster } from '@/lib/api/bulk-delete-master';
import { invalidateLokasiLabelCache } from '@/lib/api/lokasi-label';
import { WAREHOUSE_CODES, normalizeWarehouseKode, ensureWarehousesForTenant, isValidWarehouseKode } from '@/lib/api/warehouses';
import type { HandlerContext } from '@/types/api/handler';
import type { InventoryBody } from './inventory-shared';

export async function handleLokasi({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const invBody = (body || {}) as InventoryBody;

  if (route === '/lokasi' && method === 'GET') {
    const { denied, scopeAuth, tenantId } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    await ensureWarehousesForTenant(db, tenantId);
    const filter = withTenantFilter(scopeAuth, { kode: { $in: WAREHOUSE_CODES } });
    const list = await db.collection('lokasi').find(filter).sort({ kode: 1 }).toArray();
    return okCached(list.map(clean), { maxAge: 120 });
  }

  if (route === '/lokasi' && method === 'POST') {
    return err('Gudang tetap GKERING / GBASAH / GJANITOR — tidak bisa menambah lokasi baru. Edit keterangan via PUT jika perlu.', 400);
  }

  if (path[0] === 'lokasi' && path.length === 2) {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const id = path[1];
    const access = await assertMasterAccess(db, scopeAuth, 'lokasi', { id });
    if (method === 'PUT') {
      if ('error' in access) return access.error;
      const lokExisting = access.doc;
      const kode = normalizeWarehouseKode(String(lokExisting.kode || ''));
      if (!isValidWarehouseKode(kode)) {
        return err('Hanya gudang GKERING / GBASAH / GJANITOR yang dapat diedit', 400);
      }
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (invBody?.keterangan !== undefined) update.keterangan = invBody.keterangan;
      if (invBody?.aktif !== undefined) update.aktif = !!invBody.aktif;
      await db.collection('lokasi').updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
      await invalidateLokasiLabelCache(String(access.doc?.tenantId || scopeAuth?.tenantId || ''));
      return ok(clean(await findMasterDoc(db, 'lokasi', scopeAuth, { id })));
    }
    if (method === 'DELETE') {
      if ('error' in access) return access.error;
      const kode = normalizeWarehouseKode(String(access.doc.kode || ''));
      if (isValidWarehouseKode(kode)) {
        return err('Gudang utama tidak dapat dihapus', 400);
      }
      await db.collection('lokasi').deleteOne(withTenantFilter(scopeAuth, { id }));
      await invalidateLokasiLabelCache(String(access.doc?.tenantId || scopeAuth?.tenantId || ''));
      return ok({ message: 'deleted' });
    }
  }

  if (route === '/lokasi/bulk-delete' && method === 'POST') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: invBody, request });
    if (denied) return denied;
    const result = await bulkDeleteMaster(db, scopeAuth, 'lokasi', invBody?.ids);
    await invalidateLokasiLabelCache(String(scopeAuth?.tenantId || ''));
    return result;
  }

  return null;
}
