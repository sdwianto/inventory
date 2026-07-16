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
  MENUS_COLLECTION,
  normalizeMenuItems,
  type MenuDoc,
  type MenuItem,
} from '@/lib/food-production/menu';
import { RECIPES_COLLECTION, todayIsoDate } from '@/lib/food-production/recipe';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

interface MenuBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  version?: number;
  effectiveDate?: string;
  items?: unknown;
  targetCostPerPorsi?: number | null;
  catatan?: string;
  aktif?: boolean;
}

async function enrichItems(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  items: MenuItem[],
  options?: { requireActive?: boolean },
): Promise<MenuItem[] | { error: string }> {
  const ids = items.map((i) => i.recipeId);
  const recipes = await db.collection(RECIPES_COLLECTION)
    .find({ ...tenantFilter, id: { $in: ids } })
    .project({ id: 1, kode: 1, nama: 1, aktif: 1 })
    .toArray();
  const byId = new Map(recipes.map((r) => [String(r.id), r]));
  const out: MenuItem[] = [];
  for (const item of items) {
    const r = byId.get(item.recipeId);
    if (!r) return { error: `Resep ${item.recipeId} tidak ditemukan` };
    if (options?.requireActive && r.aktif === false) {
      return { error: `Resep ${String(r.kode || item.recipeId)} nonaktif — aktifkan dulu atau ganti resep` };
    }
    out.push({
      ...item,
      recipeKode: item.recipeKode || (r.kode != null ? String(r.kode) : undefined),
      recipeNama: item.recipeNama || (r.nama != null ? String(r.nama) : undefined),
    });
  }
  return out;
}

function nextKodeHint(nama: string): string {
  const slug = nama
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 12);
  return `MNU-${slug || 'NEW'}`;
}

export async function handleMenus({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const menuBody = (body || {}) as MenuBody;

  if (route === '/menus' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const onlyActive = url.searchParams.get('aktif') === '1';
    let filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    const q = (url.searchParams.get('q') || '').trim();
    if (q) {
      filter.$or = [
        { nama: { $regex: q, $options: 'i' } },
        { kode: { $regex: q, $options: 'i' } },
      ];
    }
    filter = withTenantFilter(scopeAuth, filter);

    const list = await db.collection(MENUS_COLLECTION)
      .find(filter)
      .sort({ nama: 1, version: -1 })
      .limit(200)
      .toArray();

    return ok(list.map((doc) => clean(doc)));
  }

  if (route === '/menus' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: menuBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const nama = String(menuBody.nama || '').trim();
    if (!nama) return err('Nama menu wajib diisi');
    const itemsRaw = normalizeMenuItems(menuBody.items);
    if ('error' in itemsRaw) return err(itemsRaw.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, menuBody);
    const tenantFilter = withTenantFilter(scopeAuth, {});
    const items = await enrichItems(db, tenantFilter, itemsRaw, { requireActive: true });
    if ('error' in items) return err(items.error, 400);

    let targetCostPerPorsi: number | undefined;
    if (menuBody.targetCostPerPorsi != null) {
      const c = Number(menuBody.targetCostPerPorsi);
      if (!Number.isFinite(c) || c < 0) return err('Target cost/porsi tidak valid', 400);
      targetCostPerPorsi = c;
    }

    const now = new Date();
    const kode = String(menuBody.kode || '').trim() || nextKodeHint(nama);
    const version = Math.max(1, Math.floor(Number(menuBody.version) || 1));
    const effectiveDate = String(menuBody.effectiveDate || '').trim() || todayIsoDate();

    const dup = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode, version }),
    );
    if (dup) return err(`Menu ${kode} versi ${version} sudah ada`, 409);

    const doc: MenuDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      version,
      effectiveDate,
      items,
      targetCostPerPorsi,
      catatan: String(menuBody.catatan || '').trim() || undefined,
      aktif: menuBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(MENUS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'MENU_CREATE',
      entityType: 'menu',
      entityId: doc.id,
      summary: `Menu ${doc.kode} v${doc.version} dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(doc));
  }

  if (path[0] === 'menus' && path[1] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: menuBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MenuDoc | null;
    if (!existing) return err('Menu tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    const tenantFilter = withTenantFilter(scopeAuth, {});

    if (menuBody.nama !== undefined) {
      const nama = String(menuBody.nama).trim();
      if (!nama) return err('Nama menu wajib diisi');
      update.nama = nama;
    }
    if (menuBody.kode !== undefined) {
      const kode = String(menuBody.kode).trim();
      if (!kode) return err('Kode menu wajib diisi');
      update.kode = kode;
    }
    if (menuBody.version !== undefined) {
      update.version = Math.max(1, Math.floor(Number(menuBody.version) || 1));
    }
    if (menuBody.effectiveDate !== undefined) {
      const d = String(menuBody.effectiveDate).trim();
      if (!d) return err('Tanggal efektif wajib');
      update.effectiveDate = d;
    }
    if (menuBody.items !== undefined) {
      const itemsRaw = normalizeMenuItems(menuBody.items);
      if ('error' in itemsRaw) return err(itemsRaw.error, 400);
      // Update boleh memuat resep nonaktif agar user bisa membersihkan menu.
      const items = await enrichItems(db, tenantFilter, itemsRaw, { requireActive: false });
      if ('error' in items) return err(items.error, 400);
      update.items = items;
    }
    if (menuBody.targetCostPerPorsi !== undefined) {
      if (menuBody.targetCostPerPorsi === null) {
        update.targetCostPerPorsi = null;
      } else {
        const c = Number(menuBody.targetCostPerPorsi);
        if (!Number.isFinite(c) || c < 0) return err('Target cost/porsi tidak valid', 400);
        update.targetCostPerPorsi = c;
      }
    }
    if (menuBody.catatan !== undefined) {
      update.catatan = String(menuBody.catatan || '').trim() || null;
    }
    if (menuBody.aktif !== undefined) {
      update.aktif = !!menuBody.aktif;
    }

    const nextKode = String(update.kode ?? existing.kode);
    const nextVersion = Number(update.version ?? existing.version);
    const dup = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode: nextKode, version: nextVersion, id: { $ne: id } }),
    );
    if (dup) return err(`Menu ${nextKode} versi ${nextVersion} sudah ada`, 409);

    await db.collection(MENUS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'MENU_UPDATE',
      entityType: 'menu',
      entityId: id,
      summary: `Menu ${String(saved?.kode || existing.kode)} diubah`,
      ...auditActor(auth),
    });
    return ok(clean(saved));
  }

  if (path[0] === 'menus' && path[1] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MenuDoc | null;
    if (!existing) return err('Menu tidak ditemukan', 404);

    await db.collection(MENUS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'MENU_DEACTIVATE',
      entityType: 'menu',
      entityId: id,
      summary: `Menu ${existing.kode} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false });
  }

  return null;
}
