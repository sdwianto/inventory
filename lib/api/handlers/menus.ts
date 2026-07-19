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
  normalizeMenuNama,
  type MenuDoc,
  type MenuItem,
} from '@/lib/food-production/menu';
import { RECIPES_COLLECTION, todayIsoDate } from '@/lib/food-production/recipe';
import { PRODUCTION_PLANS_COLLECTION } from '@/lib/food-production/production-plan';
import { nextSequentialCode } from '@/lib/api/document-sequence';
import { storeBase64Image, deleteMediaFile } from '@/lib/api/media-storage';
import { validateBase64Image } from '@/lib/api/image-base64';
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
  gambarBase64?: string | null;
  aktif?: boolean;
}

async function findMenuByNama(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  nama: string,
  excludeId?: string,
): Promise<MenuDoc | null> {
  const escaped = nama.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter: Record<string, unknown> = {
    ...tenantFilter,
    nama: { $regex: `^${escaped}$`, $options: 'i' },
    aktif: true,
  };
  if (excludeId) filter.id = { $ne: excludeId };
  return db.collection(MENUS_COLLECTION).findOne(filter) as Promise<MenuDoc | null>;
}

async function resolveMenuImage(
  tenantId: string,
  incoming: unknown,
  existing?: { gambarUrl?: string; gambarMediaFile?: string },
): Promise<{ gambarUrl?: string | null; gambarMediaFile?: string | null } | { error: string }> {
  if (incoming === undefined) {
    return {
      gambarUrl: existing?.gambarUrl,
      gambarMediaFile: existing?.gambarMediaFile,
    };
  }
  if (incoming === null || incoming === '') {
    if (existing?.gambarMediaFile) {
      await deleteMediaFile(tenantId, existing.gambarMediaFile);
    }
    return { gambarUrl: null, gambarMediaFile: null };
  }
  const s = String(incoming).trim();
  if (!s) {
    if (existing?.gambarMediaFile) {
      await deleteMediaFile(tenantId, existing.gambarMediaFile);
    }
    return { gambarUrl: null, gambarMediaFile: null };
  }
  if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
    return { gambarUrl: s, gambarMediaFile: existing?.gambarMediaFile || null };
  }
  const checked = validateBase64Image(s, 'Gambar menu');
  if (checked && typeof checked === 'object' && 'error' in checked) return checked;
  if (!checked || !String(checked).startsWith('data:image')) {
    return { error: 'Gambar menu tidak valid' };
  }
  const stored = await storeBase64Image(tenantId, String(checked), {
    prefix: 'menu',
    maxBytes: 768_000,
  });
  if ('error' in stored) return { error: stored.error };
  if (existing?.gambarMediaFile && existing.gambarMediaFile !== stored.filename) {
    await deleteMediaFile(tenantId, existing.gambarMediaFile);
  }
  return { gambarUrl: stored.url, gambarMediaFile: stored.filename };
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

async function seedMenuSequence(
  db: HandlerContext['db'],
  tenantId: string,
): Promise<void> {
  const existing = await db.collection(MENUS_COLLECTION)
    .find({ tenantId, kode: { $regex: '^MNU-\\d+$' } })
    .project({ kode: 1 })
    .toArray();
  let maxN = 0;
  for (const row of existing) {
    const m = String(row.kode || '').match(/^MNU-(\d+)$/i);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const seq = await db.collection('document_sequences').findOne({ tenantId, docType: 'MENU' });
  const last = Number(seq?.lastNumber || 0);
  if (maxN > last) {
    await db.collection('document_sequences').updateOne(
      { tenantId, docType: 'MENU' },
      {
        $set: { lastNumber: maxN, prefix: 'MNU-', updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }
}

async function allocateMenuKode(
  db: HandlerContext['db'],
  tenantId: string,
): Promise<string> {
  await seedMenuSequence(db, tenantId);
  return nextSequentialCode(db, tenantId, 'MENU', 'MNU-', 4);
}

async function peekNextMenuKode(
  db: HandlerContext['db'],
  tenantId: string,
): Promise<string> {
  await seedMenuSequence(db, tenantId);
  const seq = await db.collection('document_sequences').findOne({ tenantId, docType: 'MENU' });
  const next = Number(seq?.lastNumber || 0) + 1;
  return `MNU-${String(next).padStart(4, '0')}`;
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

    if (url.searchParams.get('nextKode') === '1') {
      const tenantId = tenantIdForWrite(scopeAuth, {});
      const kode = await peekNextMenuKode(db, tenantId);
      return ok({ kode });
    }

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
      .sort({ kode: 1 })
      .limit(200)
      .toArray();

    return ok(list.map((doc) => clean(doc)));
  }

  if (route === '/menus' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    if (!auth) return err('Unauthorized', 401);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: menuBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const nama = normalizeMenuNama(menuBody.nama);
    if (!nama) return err('Nama menu wajib diisi');
    const itemsRaw = normalizeMenuItems(menuBody.items);
    if ('error' in itemsRaw) return err(itemsRaw.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, menuBody);
    const tenantFilter = withTenantFilter(scopeAuth, {});

    const namaDup = await findMenuByNama(db, tenantFilter, nama);
    if (namaDup) {
      return err(
        `Menu "${namaDup.nama}" sudah ada (${namaDup.kode}). Ubah nama untuk item baru, atau batalkan jika sama.`,
        409,
      );
    }

    const items = await enrichItems(db, tenantFilter, itemsRaw, { requireActive: true });
    if ('error' in items) return err(items.error, 400);

    let targetCostPerPorsi: number | undefined;
    if (menuBody.targetCostPerPorsi != null) {
      const c = Number(menuBody.targetCostPerPorsi);
      if (!Number.isFinite(c) || c < 0) return err('Target biaya/porsi tidak valid', 400);
      targetCostPerPorsi = c;
    }

    const image = await resolveMenuImage(tenantId, menuBody.gambarBase64);
    if ('error' in image) return err(image.error, 400);

    const now = new Date();
    const kode = await allocateMenuKode(db, tenantId);
    const version = 1;
    const effectiveDate = String(menuBody.effectiveDate || '').trim() || todayIsoDate();

    const dup = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode, version }),
    );
    if (dup) return err(`Menu ${kode} sudah ada`, 409);

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
      gambarUrl: image.gambarUrl || undefined,
      gambarMediaFile: image.gambarMediaFile || undefined,
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
      summary: `Menu ${doc.kode} dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
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
      const nama = normalizeMenuNama(menuBody.nama);
      if (!nama) return err('Nama menu wajib diisi');
      const namaDup = await findMenuByNama(db, tenantFilter, nama, id);
      if (namaDup) {
        return err(
          `Menu "${namaDup.nama}" sudah ada (${namaDup.kode}). Nama harus unik.`,
          409,
        );
      }
      update.nama = nama;
    }
    // Kode immutable after create
    if (menuBody.effectiveDate !== undefined) {
      const d = String(menuBody.effectiveDate).trim();
      if (!d) return err('Tanggal efektif wajib');
      update.effectiveDate = d;
    }
    if (menuBody.items !== undefined) {
      const itemsRaw = normalizeMenuItems(menuBody.items);
      if ('error' in itemsRaw) return err(itemsRaw.error, 400);
      const items = await enrichItems(db, tenantFilter, itemsRaw, { requireActive: false });
      if ('error' in items) return err(items.error, 400);
      update.items = items;
    }
    if (menuBody.targetCostPerPorsi !== undefined) {
      if (menuBody.targetCostPerPorsi === null) {
        update.targetCostPerPorsi = null;
      } else {
        const c = Number(menuBody.targetCostPerPorsi);
        if (!Number.isFinite(c) || c < 0) return err('Target biaya/porsi tidak valid', 400);
        update.targetCostPerPorsi = c;
      }
    }
    if (menuBody.catatan !== undefined) {
      update.catatan = String(menuBody.catatan || '').trim() || null;
    }
    if (menuBody.gambarBase64 !== undefined) {
      const image = await resolveMenuImage(
        existing.tenantId,
        menuBody.gambarBase64,
        { gambarUrl: existing.gambarUrl, gambarMediaFile: existing.gambarMediaFile },
      );
      if ('error' in image) return err(image.error, 400);
      update.gambarUrl = image.gambarUrl ?? null;
      update.gambarMediaFile = image.gambarMediaFile ?? null;
    }
    if (menuBody.aktif !== undefined) {
      update.aktif = !!menuBody.aktif;
    }

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
    const hard = url.searchParams.get('hard') === '1';
    const existing = await db.collection(MENUS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MenuDoc | null;
    if (!existing) return err('Menu tidak ditemukan', 404);

    if (hard) {
      const used = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          'lines.menuId': id,
          status: { $ne: 'CANCELLED' },
        }),
      );
      if (used) {
        return err(
          `Menu ${existing.kode} masih dipakai rencana produksi "${String(used.noDokumen || used.id)}". Nonaktifkan saja, atau hapus dari rencana dulu.`,
          409,
        );
      }
      await db.collection(MENUS_COLLECTION).deleteOne(
        withTenantFilter(scopeAuth, { id }),
      );
      if (existing.gambarMediaFile) {
        await deleteMediaFile(existing.tenantId, existing.gambarMediaFile);
      }
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'MENU_DELETE',
        entityType: 'menu',
        entityId: id,
        summary: `Menu ${existing.kode} dihapus permanen`,
        ...auditActor(auth),
      });
      return ok({ id, deleted: true });
    }

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
