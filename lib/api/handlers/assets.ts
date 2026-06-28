import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
  findMasterDoc,
} from '@/lib/api/tenant-master';
import { assertMasterAccess } from '@/lib/api/tenant-validate';
import { requireRole } from '@/lib/api/require-auth';
import { nextDocNumber } from '@/lib/api/document-sequence';
import {
  actorSnapshot,
  assertAssetHasNoOpenRequests,
  buildAssetSearchFilter,
  normalizeAssetStatus,
} from '@/lib/api/maintenance-helpers';
import { ASSET_MANAGE_ROLES, ASSETS_COLLECTION } from '@/lib/maintenance/constants';
import { validateBase64Image, validateBase64Images } from '@/lib/api/image-base64';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import type { HandlerContext } from '@/types/api/handler';
import type { AssetDoc } from '@/types/maintenance';

interface AssetBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  kategori?: string;
  lokasi?: string;
  serialNumber?: string;
  merk?: string;
  model?: string;
  status?: string;
  tanggalBeli?: string | null;
  nilaiPerolehan?: number | string;
  vendorAsal?: string;
  catatan?: string;
  fotoBase64?: string | null;
}

export async function handleAssets({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const assetBody = (body || {}) as AssetBody;

  if (route === '/assets' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;

    const q = (url.searchParams.get('q') || '').trim();
    const status = url.searchParams.get('status') || '';
    const kategori = url.searchParams.get('kategori') || '';
    let filter: Record<string, unknown> = buildAssetSearchFilter(q);
    if (status) filter.status = status;
    if (kategori) filter.kategori = kategori;
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(ASSETS_COLLECTION)
      .find(filter)
      .sort({ nama: 1 })
      .limit(500)
      .toArray();
    return ok(list.map((doc) => clean({
      ...doc,
      hasFoto: !!doc.fotoBase64,
      fotoBase64: undefined,
    })));
  }

  if (route === '/assets' && method === 'POST') {
    const deniedRole = requireRole(auth, [...ASSET_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: assetBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    if (!assetBody.nama?.trim()) return err('Nama aset wajib diisi');

    const tenantId = tenantIdForWrite(scopeAuth, assetBody);
    const kode = assetBody.kode?.trim()
      || await nextDocNumber(db, tenantId, 'AST', 'AST');

    const existing = await db.collection(ASSETS_COLLECTION).findOne({ tenantId, kode });
    if (existing) return err('Kode aset sudah ada di tenant ini');

    let fotoBase64: string | null = null;
    if (assetBody.fotoBase64 !== undefined) {
      const checked = validateBase64Image(assetBody.fotoBase64, 'Foto aset');
      if (checked && typeof checked === 'object' && 'error' in checked) return err(checked.error, 400);
      fotoBase64 = checked;
    }

    const now = new Date();
    const doc: AssetDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama: String(assetBody.nama).trim(),
      kategori: String(assetBody.kategori || 'Lainnya').trim(),
      lokasi: String(assetBody.lokasi || '').trim(),
      serialNumber: String(assetBody.serialNumber || '').trim(),
      merk: String(assetBody.merk || '').trim(),
      model: String(assetBody.model || '').trim(),
      status: normalizeAssetStatus(assetBody.status),
      tanggalBeli: assetBody.tanggalBeli ? new Date(assetBody.tanggalBeli) : null,
      nilaiPerolehan: parseInt(String(assetBody.nilaiPerolehan || 0), 10),
      vendorAsal: String(assetBody.vendorAsal || '').trim(),
      catatan: String(assetBody.catatan || '').trim(),
      fotoBase64,
      createdBy: await actorSnapshot(db, scopeAuth),
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(ASSETS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'ASSET_CREATED',
      entityType: 'asset',
      entityId: doc.id!,
      summary: `Aset ${doc.kode} — ${doc.nama}`,
      ...auditActor(scopeAuth),
    });
    return ok(clean(doc));
  }

  if (path[0] === 'assets' && path.length === 2) {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: assetBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const access = await assertMasterAccess(db, scopeAuth, ASSETS_COLLECTION, { id });

    if (method === 'GET') {
      if ('error' in access) return access.error;
      return ok(clean(access.doc));
    }

    if (method === 'PUT') {
      const deniedRole = requireRole(auth, [...ASSET_MANAGE_ROLES]);
      if (deniedRole) return deniedRole;
      if ('error' in access) return access.error;
      const existing = access.doc as AssetDoc;
      if (!assetBody.nama?.trim() && assetBody.nama !== undefined) {
        return err('Nama aset wajib diisi');
      }

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (assetBody.nama !== undefined) update.nama = String(assetBody.nama).trim();
      if (assetBody.kategori !== undefined) update.kategori = String(assetBody.kategori || 'Lainnya').trim();
      if (assetBody.lokasi !== undefined) update.lokasi = String(assetBody.lokasi || '').trim();
      if (assetBody.serialNumber !== undefined) update.serialNumber = String(assetBody.serialNumber || '').trim();
      if (assetBody.merk !== undefined) update.merk = String(assetBody.merk || '').trim();
      if (assetBody.model !== undefined) update.model = String(assetBody.model || '').trim();
      if (assetBody.status !== undefined) update.status = normalizeAssetStatus(assetBody.status);
      if (assetBody.tanggalBeli !== undefined) {
        update.tanggalBeli = assetBody.tanggalBeli ? new Date(assetBody.tanggalBeli) : null;
      }
      if (assetBody.nilaiPerolehan !== undefined) {
        update.nilaiPerolehan = parseInt(String(assetBody.nilaiPerolehan || 0), 10);
      }
      if (assetBody.vendorAsal !== undefined) update.vendorAsal = String(assetBody.vendorAsal || '').trim();
      if (assetBody.catatan !== undefined) update.catatan = String(assetBody.catatan || '').trim();
      if (assetBody.fotoBase64 !== undefined) {
        const checked = validateBase64Image(assetBody.fotoBase64, 'Foto aset');
        if (checked && typeof checked === 'object' && 'error' in checked) return err(checked.error, 400);
        update.fotoBase64 = checked;
      }
      if (assetBody.kode !== undefined && assetBody.kode !== existing.kode) {
        const dup = await db.collection(ASSETS_COLLECTION).findOne({
          tenantId: existing.tenantId,
          kode: assetBody.kode,
          id: { $ne: id },
        });
        if (dup) return err('Kode aset sudah ada di tenant ini');
        update.kode = String(assetBody.kode).trim();
      }

      await db.collection(ASSETS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
      const doc = await findMasterDoc(db, ASSETS_COLLECTION, scopeAuth, { id });
      return ok(clean(doc));
    }

    if (method === 'DELETE') {
      const deniedRole = requireRole(auth, [...ASSET_MANAGE_ROLES]);
      if (deniedRole) return deniedRole;
      if ('error' in access) return access.error;
      const existing = access.doc as AssetDoc;
      const blockMsg = await assertAssetHasNoOpenRequests(
        db,
        String(existing.tenantId || 'default'),
        id,
      );
      if (blockMsg) return err(blockMsg, 400);

      await db.collection(ASSETS_COLLECTION).deleteOne(withTenantFilter(scopeAuth, { id }));
      await writeAuditLog(db, {
        tenantId: String(existing.tenantId || 'default'),
        action: 'ASSET_DELETED',
        entityType: 'asset',
        entityId: id,
        summary: `Hapus aset ${existing.kode} — ${existing.nama}`,
        ...auditActor(scopeAuth),
      });
      return ok({ message: 'deleted' });
    }
  }

  return null;
}
