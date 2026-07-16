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
import {
  KITCHENS_COLLECTION,
  normalizeKitchenWarehouse,
  normalizeKitchenType,
  normalizeKitchenKode,
  assertKitchenHubLink,
  type KitchenDoc,
} from '@/lib/food-production/kitchen';
import { warehouseLabel } from '@/lib/api/warehouses';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

interface KitchenBody extends Record<string, unknown> {
  nama?: string;
  kode?: string;
  kitchenType?: string;
  centralKitchenId?: string;
  defaultWarehouseKode?: string;
  pic?: string;
  aktif?: boolean;
}

function projectKitchen(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean({
    ...doc,
    kitchenType: doc.kitchenType || 'SATELLITE',
    defaultWarehouseLabel: warehouseLabel(String(doc.defaultWarehouseKode || '')),
  });
}

export async function handleKitchens({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const kitchenBody = (body || {}) as KitchenBody;

  if (route === '/kitchens' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const onlyActive = url.searchParams.get('aktif') === '1';
    const kitchenType = url.searchParams.get('kitchenType');
    let filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    if (kitchenType === 'CENTRAL' || kitchenType === 'SATELLITE') {
      filter.kitchenType = kitchenType;
    }
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(KITCHENS_COLLECTION)
      .find(filter)
      .sort({ kitchenType: 1, nama: 1 })
      .limit(200)
      .toArray();

    return ok(list.map((doc) => projectKitchen(doc as Record<string, unknown>)));
  }

  if (route === '/kitchens' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: kitchenBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const nama = String(kitchenBody.nama || '').trim();
    if (!nama) return err('Nama dapur wajib diisi');
    const wh = normalizeKitchenWarehouse(kitchenBody.defaultWarehouseKode);
    if (!wh) return err('Gudang default wajib GKERING atau GBASAH', 400);
    const kitchenType = normalizeKitchenType(kitchenBody.kitchenType);
    const kode = normalizeKitchenKode(kitchenBody.kode);
    const centralKitchenId = kitchenType === 'SATELLITE'
      ? String(kitchenBody.centralKitchenId || '').trim() || undefined
      : undefined;

    if (centralKitchenId) {
      const hub = await db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: centralKitchenId, kitchenType: 'CENTRAL', aktif: true }),
      );
      if (!hub) return err('Central Kitchen tidak ditemukan / nonaktif', 400);
    }
    const hubErr = assertKitchenHubLink({ kitchenType, centralKitchenId });
    if (hubErr) return err(hubErr, 400);

    if (kode) {
      const dup = await db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { kode }),
      );
      if (dup) return err(`Kode dapur ${kode} sudah dipakai`, 400);
    }

    const tenantId = tenantIdForWrite(scopeAuth, kitchenBody);
    const now = new Date();
    const doc: KitchenDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      kitchenType,
      centralKitchenId,
      defaultWarehouseKode: wh,
      pic: String(kitchenBody.pic || '').trim() || undefined,
      aktif: kitchenBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(KITCHENS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'KITCHEN_CREATE',
      entityType: 'kitchen',
      entityId: doc.id,
      summary: `Dapur ${doc.nama} (${doc.kitchenType}) dibuat`,
      ...auditActor(auth),
    });
    return ok(projectKitchen(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'kitchens' && path[1] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: kitchenBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(KITCHENS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as KitchenDoc | null;
    if (!existing) return err('Dapur tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (kitchenBody.nama !== undefined) {
      const nama = String(kitchenBody.nama).trim();
      if (!nama) return err('Nama dapur wajib diisi');
      update.nama = nama;
    }
    if (kitchenBody.defaultWarehouseKode !== undefined) {
      const wh = normalizeKitchenWarehouse(kitchenBody.defaultWarehouseKode);
      if (!wh) return err('Gudang default wajib GKERING atau GBASAH', 400);
      update.defaultWarehouseKode = wh;
    }
    if (kitchenBody.pic !== undefined) {
      update.pic = String(kitchenBody.pic || '').trim() || null;
    }
    if (kitchenBody.aktif !== undefined) {
      update.aktif = !!kitchenBody.aktif;
    }
    if (kitchenBody.kode !== undefined) {
      const kode = normalizeKitchenKode(kitchenBody.kode);
      if (kode) {
        const dup = await db.collection(KITCHENS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { kode, id: { $ne: id } }),
        );
        if (dup) return err(`Kode dapur ${kode} sudah dipakai`, 400);
      }
      update.kode = kode || null;
    }
    if (kitchenBody.kitchenType !== undefined || kitchenBody.centralKitchenId !== undefined) {
      const kitchenType = kitchenBody.kitchenType !== undefined
        ? normalizeKitchenType(kitchenBody.kitchenType)
        : (existing.kitchenType || 'SATELLITE');
      const centralKitchenId = kitchenType === 'CENTRAL'
        ? undefined
        : (kitchenBody.centralKitchenId !== undefined
          ? String(kitchenBody.centralKitchenId || '').trim() || undefined
          : existing.centralKitchenId);
      if (centralKitchenId) {
        const hub = await db.collection(KITCHENS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: centralKitchenId, kitchenType: 'CENTRAL', aktif: true }),
        );
        if (!hub) return err('Central Kitchen tidak ditemukan / nonaktif', 400);
      }
      const hubErr = assertKitchenHubLink({ kitchenType, kitchenId: id, centralKitchenId });
      if (hubErr) return err(hubErr, 400);
      update.kitchenType = kitchenType;
      update.centralKitchenId = centralKitchenId || null;
    }

    await db.collection(KITCHENS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await db.collection(KITCHENS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'KITCHEN_UPDATE',
      entityType: 'kitchen',
      entityId: id,
      summary: `Dapur ${String(saved?.nama || existing.nama)} diubah`,
      ...auditActor(auth),
    });
    return ok(projectKitchen(saved as Record<string, unknown>));
  }

  if (path[0] === 'kitchens' && path[1] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(KITCHENS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as KitchenDoc | null;
    if (!existing) return err('Dapur tidak ditemukan', 404);

    await db.collection(KITCHENS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'KITCHEN_DEACTIVATE',
      entityType: 'kitchen',
      entityId: id,
      summary: `Dapur ${existing.nama} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false });
  }

  return null;
}
