import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { isValidWarehouseKode, normalizeWarehouseKode, warehouseLabel } from '@/lib/api/warehouses';
import {
  WAREHOUSE_BINS_COLLECTION,
  clearOtherDefaultBins,
  isValidBinKode,
  normalizeBinKode,
  type WarehouseBinDoc,
} from '@/lib/api/warehouse-bins';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

interface BinBody extends Record<string, unknown> {
  kode?: string;
  warehouseKode?: string;
  nama?: string;
  aktif?: boolean;
  isDefault?: boolean;
}

function projectBin(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean({
    ...doc,
    warehouseLabel: warehouseLabel(String(doc.warehouseKode || '')),
  });
}

export async function handleWarehouseBins({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const binBody = (body || {}) as BinBody;

  if (route === '/warehouse-bins' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const onlyActive = url.searchParams.get('aktif') === '1';
    const warehouseKodeRaw = url.searchParams.get('warehouseKode');
    let filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    if (warehouseKodeRaw) {
      const wh = normalizeWarehouseKode(warehouseKodeRaw);
      if (!isValidWarehouseKode(wh)) return err('Gudang tidak valid', 400);
      filter.warehouseKode = wh;
    }
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(WAREHOUSE_BINS_COLLECTION)
      .find(filter)
      .sort({ warehouseKode: 1, kode: 1 })
      .limit(500)
      .toArray();

    return ok(list.map((doc) => projectBin(doc as Record<string, unknown>)));
  }

  if (route === '/warehouse-bins' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: binBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const kode = normalizeBinKode(binBody.kode);
    if (!isValidBinKode(kode)) {
      return err('Kode bin wajib (huruf/angka/hyphen, max 24)', 400);
    }
    const warehouseKode = normalizeWarehouseKode(binBody.warehouseKode);
    if (!isValidWarehouseKode(warehouseKode)) {
      return err('Gudang wajib GKERING / GBASAH / GJANITOR', 400);
    }
    const nama = String(binBody.nama || '').trim() || kode;
    const isDefault = binBody.isDefault === true;
    const aktif = binBody.aktif !== false;

    const dup = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { warehouseKode, kode }),
    );
    if (dup) return err(`Bin ${kode} sudah ada di ${warehouseKode}`, 400);

    const tenantId = tenantIdForWrite(scopeAuth, binBody);
    if (isDefault && aktif) {
      await clearOtherDefaultBins(db, tenantId, warehouseKode);
    }

    const now = new Date();
    const doc: WarehouseBinDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      warehouseKode,
      nama,
      aktif,
      isDefault: isDefault && aktif,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(WAREHOUSE_BINS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'WAREHOUSE_BIN_CREATE',
      entityType: 'warehouse_bin',
      entityId: doc.id,
      summary: `Bin ${doc.kode} @ ${doc.warehouseKode} dibuat`,
      ...auditActor(auth),
    });
    return ok(projectBin(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'warehouse-bins' && path[1] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: binBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as WarehouseBinDoc | null;
    if (!existing) return err('Bin tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };

    if (binBody.nama !== undefined) {
      update.nama = String(binBody.nama || '').trim() || existing.kode;
    }
    if (binBody.aktif !== undefined) {
      update.aktif = !!binBody.aktif;
    }
    if (binBody.kode !== undefined) {
      const kode = normalizeBinKode(binBody.kode);
      if (!isValidBinKode(kode)) {
        return err('Kode bin wajib (huruf/angka/hyphen, max 24)', 400);
      }
      const dup = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          warehouseKode: existing.warehouseKode,
          kode,
          id: { $ne: id },
        }),
      );
      if (dup) return err(`Bin ${kode} sudah ada di ${existing.warehouseKode}`, 400);
      update.kode = kode;
    }
    if (binBody.warehouseKode !== undefined) {
      const warehouseKode = normalizeWarehouseKode(binBody.warehouseKode);
      if (!isValidWarehouseKode(warehouseKode)) {
        return err('Gudang wajib GKERING / GBASAH / GJANITOR', 400);
      }
      const kodeNext = normalizeBinKode(
        binBody.kode !== undefined ? binBody.kode : existing.kode,
      );
      const dup = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          warehouseKode,
          kode: kodeNext,
          id: { $ne: id },
        }),
      );
      if (dup) return err(`Bin ${kodeNext} sudah ada di ${warehouseKode}`, 400);
      update.warehouseKode = warehouseKode;
    }

    const nextAktif = binBody.aktif !== undefined ? !!binBody.aktif : existing.aktif;
    let nextDefault = binBody.isDefault !== undefined
      ? !!binBody.isDefault
      : existing.isDefault;
    if (!nextAktif) nextDefault = false;

    if (binBody.isDefault !== undefined || binBody.aktif !== undefined) {
      update.isDefault = nextDefault;
    }

    const whForDefault = String(update.warehouseKode || existing.warehouseKode);
    if (nextDefault && nextAktif) {
      await clearOtherDefaultBins(db, existing.tenantId, whForDefault, id);
      update.isDefault = true;
    }

    await db.collection(WAREHOUSE_BINS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'WAREHOUSE_BIN_UPDATE',
      entityType: 'warehouse_bin',
      entityId: id,
      summary: `Bin ${String(saved?.kode || existing.kode)} diubah`,
      ...auditActor(auth),
    });
    return ok(projectBin(saved as Record<string, unknown>));
  }

  if (path[0] === 'warehouse-bins' && path[1] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(WAREHOUSE_BINS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as WarehouseBinDoc | null;
    if (!existing) return err('Bin tidak ditemukan', 404);

    await db.collection(WAREHOUSE_BINS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, isDefault: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'WAREHOUSE_BIN_DEACTIVATE',
      entityType: 'warehouse_bin',
      entityId: id,
      summary: `Bin ${existing.kode} @ ${existing.warehouseKode} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false, isDefault: false });
  }

  return null;
}
