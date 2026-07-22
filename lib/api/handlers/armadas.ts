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
  ARMADAS_COLLECTION,
  normalizeArmadaKode,
  normalizeArmadaKapasitas,
  normalizePlatNomor,
  nextArmadaKode,
  type ArmadaDoc,
} from '@/lib/food-production/armada';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import type { HandlerContext } from '@/types/api/handler';

interface ArmadaBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  kitchenId?: string;
  aktif?: boolean;
}

export async function handleArmadas(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const armadaBody = (body || {}) as ArmadaBody;

  if (route === '/armadas' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    if (url.searchParams.get('aktif') === '1') filter.aktif = true;
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;

    const list = await db.collection(ARMADAS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ nama: 1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/armadas' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: armadaBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const nama = String(armadaBody.nama || '').trim();
    if (!nama) return err('Nama armada wajib', 400);

    const kitchenId = String(armadaBody.kitchenId || '').trim() || undefined;
    let kitchenNama: string | undefined;
    if (kitchenId) {
      const k = await db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: kitchenId, aktif: true }),
      );
      if (!k) return err('Dapur tidak ditemukan / nonaktif', 400);
      kitchenNama = String(k.nama || '');
    }

    const existingCodes = await db.collection(ARMADAS_COLLECTION)
      .find(withTenantFilter(scopeAuth, {}))
      .project({ kode: 1 })
      .toArray();
    const kode = normalizeArmadaKode(armadaBody.kode) || nextArmadaKode(existingCodes);
    const dup = await db.collection(ARMADAS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode }),
    );
    if (dup) return err(`Kode armada ${kode} sudah dipakai`, 400);

    const now = new Date();
    const doc: ArmadaDoc = {
      id: uuidv4(),
      tenantId: tenantIdForWrite(scopeAuth, armadaBody),
      kode,
      nama,
      platNomor: normalizePlatNomor(armadaBody.platNomor),
      kapasitasPorsi: normalizeArmadaKapasitas(armadaBody.kapasitasPorsi),
      kitchenId,
      kitchenNama,
      aktif: armadaBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(ARMADAS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err(`Kode armada ${kode} sudah dipakai`, 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId: doc.tenantId,
      action: 'ARMADA_CREATE',
      entityType: 'armada',
      entityId: doc.id,
      summary: `Armada ${doc.nama} dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'armadas' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: armadaBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(ARMADAS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ArmadaDoc | null;
    if (!existing) return err('Armada tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (armadaBody.nama !== undefined) {
      const nama = String(armadaBody.nama || '').trim();
      if (!nama) return err('Nama wajib', 400);
      update.nama = nama;
    }
    if (armadaBody.kode !== undefined) {
      const kode = normalizeArmadaKode(armadaBody.kode);
      if (!kode) return err('Kode armada wajib', 400);
      const dup = await db.collection(ARMADAS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { kode, id: { $ne: id } }),
      );
      if (dup) return err(`Kode armada ${kode} sudah dipakai`, 400);
      update.kode = kode;
    }
    if (armadaBody.platNomor !== undefined) {
      update.platNomor = normalizePlatNomor(armadaBody.platNomor) || null;
    }
    if (armadaBody.kapasitasPorsi !== undefined) {
      update.kapasitasPorsi = normalizeArmadaKapasitas(armadaBody.kapasitasPorsi) ?? null;
    }
    if (armadaBody.aktif !== undefined) update.aktif = armadaBody.aktif !== false;
    if (armadaBody.kitchenId !== undefined) {
      const kitchenId = String(armadaBody.kitchenId || '').trim() || undefined;
      if (kitchenId) {
        const k = await db.collection(KITCHENS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: kitchenId, aktif: true }),
        );
        if (!k) return err('Dapur tidak ditemukan / nonaktif', 400);
        update.kitchenId = kitchenId;
        update.kitchenNama = String(k.nama || '');
      } else {
        update.kitchenId = null;
        update.kitchenNama = null;
      }
    }

    try {
      await db.collection(ARMADAS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Kode armada sudah dipakai', 400);
      }
      throw e;
    }
    const saved = await db.collection(ARMADAS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'ARMADA_UPDATE',
      entityType: 'armada',
      entityId: id,
      summary: `Armada ${existing.nama} diperbarui`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'armadas' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(ARMADAS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ArmadaDoc | null;
    if (!existing) return err('Armada tidak ditemukan', 404);

    await db.collection(ARMADAS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'ARMADA_DEACTIVATE',
      entityType: 'armada',
      entityId: id,
      summary: `Armada ${existing.nama} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ ok: true });
  }

  return null;
}
