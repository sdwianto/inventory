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
  SERVICE_POINTS_COLLECTION,
  normalizeServicePointJenis,
  normalizeServicePointKode,
  normalizePicNoTelp,
  normalizeJamKirim,
  normalizeServicePointDrops,
  assertDropsWithinJamMakan,
  resolvePenerimaManfaat,
  type ServicePointDoc,
} from '@/lib/food-production/service-point';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { DISTRIBUTION_ORDERS_COLLECTION } from '@/lib/food-production/distribution';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import type { HandlerContext } from '@/types/api/handler';

interface SpBody extends Record<string, unknown> {
  nama?: string;
  kode?: string;
  jenis?: string;
  kitchenId?: string;
  alamat?: string;
  kapasitasPorsi?: number;
  porsiByKategori?: Record<string, number>;
  jamKirim?: string;
  drops?: unknown;
  pic?: string;
  picNoTelp?: string;
  aktif?: boolean;
}

function nextServicePointKode(rows: Array<{ kode?: unknown }>): string {
  let max = 0;
  for (const row of rows) {
    const match = /^Ti-(\d+)$/i.exec(String(row.kode || '').trim());
    if (!match) continue;
    max = Math.max(max, Number(match[1]) || 0);
  }
  return `Ti-${String(max + 1).padStart(2, '0')}`;
}

export async function handleServicePoints(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const spBody = (body || {}) as SpBody;

  if (route === '/service-points' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    if (url.searchParams.get('aktif') === '1') filter.aktif = true;
    const jenis = String(url.searchParams.get('jenis') || '').toUpperCase();
    if (jenis === 'SEKOLAH' || jenis === 'POSYANDU' || jenis === 'LAINNYA') {
      filter.jenis = jenis;
    }
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;

    const list = await db.collection(SERVICE_POINTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ nama: 1 })
      .limit(300)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/service-points' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: spBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const nama = String(spBody.nama || '').trim();
    if (!nama) return err('Nama titik layanan wajib', 400);
    const requestedKode = normalizeServicePointKode(spBody.kode);
    const jenis = normalizeServicePointJenis(spBody.jenis);
    const kitchenId = String(spBody.kitchenId || '').trim() || undefined;
    let kitchenNama: string | undefined;
    if (kitchenId) {
      const k = await db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: kitchenId, aktif: true }),
      );
      if (!k) return err('Dapur penyalur tidak ditemukan / nonaktif', 400);
      kitchenNama = String(k.nama || '');
    }
    const existingCodes = await db.collection(SERVICE_POINTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, {}))
      .project({ kode: 1 })
      .toArray();
    const kode = requestedKode || nextServicePointKode(existingCodes);
    const dup = await db.collection(SERVICE_POINTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode }),
    );
    if (dup) return err(`Kode titik ${kode} sudah dipakai`, 400);

    const penerima = resolvePenerimaManfaat({
      porsiByKategori: spBody.porsiByKategori,
      kapasitasPorsi: spBody.kapasitasPorsi,
    });
    if ('error' in penerima) return err(penerima.error, 400);
    const jamKirim = normalizeJamKirim(spBody.jamKirim);
    if (jamKirim && typeof jamKirim === 'object' && 'error' in jamKirim) {
      return err(jamKirim.error, 400);
    }
    const drops = normalizeServicePointDrops(spBody.drops);
    if ('error' in drops) return err(drops.error, 400);
    const dropGuard = assertDropsWithinJamMakan(
      typeof jamKirim === 'string' ? jamKirim : undefined,
      drops,
    );
    if (dropGuard) return err(dropGuard.error, 400);

    const now = new Date();
    const doc: ServicePointDoc = {
      id: uuidv4(),
      tenantId: tenantIdForWrite(scopeAuth, spBody),
      kode,
      nama,
      jenis,
      kitchenId,
      kitchenNama,
      alamat: String(spBody.alamat || '').trim() || undefined,
      kapasitasPorsi: penerima.kapasitasPorsi,
      porsiByKategori: penerima.porsiByKategori,
      jamKirim: jamKirim || undefined,
      drops: drops.length ? drops : undefined,
      pic: String(spBody.pic || '').trim() || undefined,
      picNoTelp: normalizePicNoTelp(spBody.picNoTelp),
      aktif: spBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(SERVICE_POINTS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err(`Kode titik ${kode || ''} sudah dipakai`, 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId: doc.tenantId,
      action: 'SERVICE_POINT_CREATE',
      entityType: 'service_point',
      entityId: doc.id,
      summary: `Titik layanan ${doc.nama} dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'service-points' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: spBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(SERVICE_POINTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ServicePointDoc | null;
    if (!existing) return err('Titik layanan tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (spBody.nama !== undefined) {
      const nama = String(spBody.nama || '').trim();
      if (!nama) return err('Nama wajib', 400);
      update.nama = nama;
    }
    if (spBody.kode !== undefined) {
      const kode = normalizeServicePointKode(spBody.kode);
      if (kode) {
        const dup = await db.collection(SERVICE_POINTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { kode, id: { $ne: id } }),
        );
        if (dup) return err(`Kode titik ${kode} sudah dipakai`, 400);
      }
      update.kode = kode || null;
    }
    if (spBody.jenis !== undefined) update.jenis = normalizeServicePointJenis(spBody.jenis);
    if (spBody.alamat !== undefined) update.alamat = String(spBody.alamat || '').trim() || null;
    if (spBody.jamKirim !== undefined) {
      const jamKirim = normalizeJamKirim(spBody.jamKirim);
      if (jamKirim && typeof jamKirim === 'object' && 'error' in jamKirim) {
        return err(jamKirim.error, 400);
      }
      update.jamKirim = jamKirim || null;
    }
    if (spBody.drops !== undefined) {
      const drops = normalizeServicePointDrops(spBody.drops);
      if ('error' in drops) return err(drops.error, 400);
      update.drops = drops;
    }
    {
      const effectiveJam = update.jamKirim !== undefined
        ? (update.jamKirim as string | null) || undefined
        : (existing.jamKirim || undefined);
      const effectiveDrops = update.drops !== undefined
        ? (update.drops as ServicePointDoc['drops']) || []
        : (existing.drops || []);
      const dropGuard = assertDropsWithinJamMakan(effectiveJam, effectiveDrops);
      if (dropGuard) return err(dropGuard.error, 400);
    }
    if (spBody.pic !== undefined) update.pic = String(spBody.pic || '').trim() || null;
    if (spBody.picNoTelp !== undefined) {
      update.picNoTelp = normalizePicNoTelp(spBody.picNoTelp) || null;
    }
    if (spBody.porsiByKategori !== undefined) {
      const penerima = resolvePenerimaManfaat({ porsiByKategori: spBody.porsiByKategori });
      if ('error' in penerima) return err(penerima.error, 400);
      update.porsiByKategori = penerima.porsiByKategori || {};
      update.kapasitasPorsi = penerima.kapasitasPorsi ?? null;
    } else if (spBody.kapasitasPorsi !== undefined) {
      const penerima = resolvePenerimaManfaat({ kapasitasPorsi: spBody.kapasitasPorsi });
      if ('error' in penerima) return err(penerima.error, 400);
      update.kapasitasPorsi = penerima.kapasitasPorsi ?? null;
    }
    if (spBody.aktif !== undefined) update.aktif = spBody.aktif !== false;
    if (spBody.kitchenId !== undefined) {
      const kitchenId = String(spBody.kitchenId || '').trim() || undefined;
      if (kitchenId) {
        const k = await db.collection(KITCHENS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: kitchenId, aktif: true }),
        );
        if (!k) return err('Dapur penyalur tidak ditemukan / nonaktif', 400);
        update.kitchenId = kitchenId;
        update.kitchenNama = String(k.nama || '');
      } else {
        update.kitchenId = null;
        update.kitchenNama = null;
      }
    }

    try {
      await db.collection(SERVICE_POINTS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: update },
      );
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Kode titik sudah dipakai', 400);
      }
      throw e;
    }
    const saved = await db.collection(SERVICE_POINTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'SERVICE_POINT_UPDATE',
      entityType: 'service_point',
      entityId: id,
      summary: `Titik layanan ${existing.nama} diperbarui`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'service-points' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const permanent = url.searchParams.get('permanent') === '1';
    const existing = await db.collection(SERVICE_POINTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as ServicePointDoc | null;
    if (!existing) return err('Titik layanan tidak ditemukan', 404);

    if (permanent) {
      const usedInDist = await db.collection(DISTRIBUTION_ORDERS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { 'lines.servicePointId': id }),
      );
      if (usedInDist) {
        return err('Titik sudah dipakai di distribusi — tidak bisa dihapus permanen', 400);
      }
      await db.collection(SERVICE_POINTS_COLLECTION).deleteOne(
        withTenantFilter(scopeAuth, { id }),
      );
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'SERVICE_POINT_DELETE',
        entityType: 'service_point',
        entityId: id,
        summary: `Titik layanan ${existing.nama} dihapus`,
        ...auditActor(auth),
      });
      return ok({ id, deleted: true });
    }

    await db.collection(SERVICE_POINTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'SERVICE_POINT_DEACTIVATE',
      entityType: 'service_point',
      entityId: id,
      summary: `Titik layanan ${existing.nama} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false });
  }

  return null;
}
