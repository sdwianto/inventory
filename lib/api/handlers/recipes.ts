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
  RECIPES_COLLECTION,
  normalizeRecipeLines,
  todayIsoDate,
  type RecipeDoc,
  type RecipeLine,
} from '@/lib/food-production/recipe';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

interface RecipeBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  finishedGoodProductId?: string;
  version?: number;
  effectiveDate?: string;
  yieldQty?: number;
  wastePct?: number | null;
  lines?: unknown;
  catatan?: string;
  aktif?: boolean;
}

async function enrichFinishedGood(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  productId: string,
): Promise<{ kode?: string; nama?: string } | { error: string }> {
  const prod = await db.collection('products').findOne({
    ...tenantFilter,
    id: productId,
  }) as { kode?: string; nama?: string } | null;
  if (!prod) return { error: 'Produk barang jadi tidak ditemukan' };
  return { kode: prod.kode ? String(prod.kode) : undefined, nama: prod.nama ? String(prod.nama) : undefined };
}

async function enrichLines(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  lines: RecipeLine[],
): Promise<RecipeLine[] | { error: string }> {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await db.collection('products')
    .find({ ...tenantFilter, id: { $in: ids } })
    .project({ id: 1, kode: 1, nama: 1, satuan: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const out: RecipeLine[] = [];
  for (const line of lines) {
    const p = byId.get(line.productId);
    if (!p) return { error: `Bahan ${line.productId} tidak ditemukan` };
    out.push({
      ...line,
      productKode: line.productKode || (p.kode != null ? String(p.kode) : undefined),
      productNama: line.productNama || (p.nama != null ? String(p.nama) : undefined),
      satuan: line.satuan || (p.satuan != null ? String(p.satuan) : undefined),
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
  return `RSP-${slug || 'NEW'}`;
}

export async function handleRecipes({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const recipeBody = (body || {}) as RecipeBody;

  if (route === '/recipes' && method === 'GET') {
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

    const list = await db.collection(RECIPES_COLLECTION)
      .find(filter)
      .sort({ nama: 1, version: -1 })
      .limit(200)
      .toArray();

    return ok(list.map((doc) => clean(doc)));
  }

  if (route === '/recipes' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    if (!auth) return err('Unauthorized', 401);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: recipeBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const nama = String(recipeBody.nama || '').trim();
    if (!nama) return err('Nama resep wajib diisi');
    const finishedGoodProductId = String(recipeBody.finishedGoodProductId || '').trim();
    if (!finishedGoodProductId) return err('Produk barang jadi wajib dipilih');
    const yieldQty = Number(recipeBody.yieldQty);
    if (!Number.isFinite(yieldQty) || yieldQty <= 0) return err('Yield (porsi) harus > 0');

    const linesRaw = normalizeRecipeLines(recipeBody.lines, { finishedGoodProductId });
    if ('error' in linesRaw) return err(linesRaw.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, recipeBody);
    const tenantFilter = withTenantFilter(scopeAuth, {});
    const fg = await enrichFinishedGood(db, tenantFilter, finishedGoodProductId);
    if ('error' in fg) return err(fg.error, 400);
    const lines = await enrichLines(db, tenantFilter, linesRaw);
    if ('error' in lines) return err(lines.error, 400);

    let wastePct: number | undefined;
    if (recipeBody.wastePct != null) {
      const w = Number(recipeBody.wastePct);
      if (!Number.isFinite(w) || w < 0 || w > 100) return err('Waste % harus 0–100', 400);
      wastePct = w;
    }

    const now = new Date();
    const kode = String(recipeBody.kode || '').trim() || nextKodeHint(nama);
    const version = Math.max(1, Math.floor(Number(recipeBody.version) || 1));
    const effectiveDate = String(recipeBody.effectiveDate || '').trim() || todayIsoDate();

    const dup = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode, version }),
    );
    if (dup) return err(`Resep ${kode} versi ${version} sudah ada`, 409);

    const doc: RecipeDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      finishedGoodProductId,
      finishedGoodKode: fg.kode,
      finishedGoodNama: fg.nama,
      version,
      effectiveDate,
      yieldQty,
      wastePct,
      lines,
      catatan: String(recipeBody.catatan || '').trim() || undefined,
      aktif: recipeBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(RECIPES_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'RECIPE_CREATE',
      entityType: 'recipe',
      entityId: doc.id,
      summary: `Resep ${doc.kode} v${doc.version} dibuat`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'recipes' && path[1] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: recipeBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as RecipeDoc | null;
    if (!existing) return err('Resep tidak ditemukan', 404);

    const update: Record<string, unknown> = { updatedAt: new Date() };
    const tenantFilter = withTenantFilter(scopeAuth, {});

    if (recipeBody.nama !== undefined) {
      const nama = String(recipeBody.nama).trim();
      if (!nama) return err('Nama resep wajib diisi');
      update.nama = nama;
    }
    if (recipeBody.kode !== undefined) {
      const kode = String(recipeBody.kode).trim();
      if (!kode) return err('Kode resep wajib diisi');
      update.kode = kode;
    }
    if (recipeBody.finishedGoodProductId !== undefined) {
      const finishedGoodProductId = String(recipeBody.finishedGoodProductId).trim();
      if (!finishedGoodProductId) return err('Produk barang jadi wajib dipilih');
      const fg = await enrichFinishedGood(db, tenantFilter, finishedGoodProductId);
      if ('error' in fg) return err(fg.error, 400);
      update.finishedGoodProductId = finishedGoodProductId;
      update.finishedGoodKode = fg.kode;
      update.finishedGoodNama = fg.nama;
      if (recipeBody.lines === undefined) {
        const clash = (existing.lines || []).some((l) => l.productId === finishedGoodProductId);
        if (clash) return err('Barang jadi tidak boleh jadi bahan di resep yang sama', 400);
      }
    }
    if (recipeBody.version !== undefined) {
      update.version = Math.max(1, Math.floor(Number(recipeBody.version) || 1));
    }
    if (recipeBody.effectiveDate !== undefined) {
      const d = String(recipeBody.effectiveDate).trim();
      if (!d) return err('Tanggal efektif wajib');
      update.effectiveDate = d;
    }
    if (recipeBody.yieldQty !== undefined) {
      const yieldQty = Number(recipeBody.yieldQty);
      if (!Number.isFinite(yieldQty) || yieldQty <= 0) return err('Yield (porsi) harus > 0');
      update.yieldQty = yieldQty;
    }
    if (recipeBody.wastePct !== undefined) {
      if (recipeBody.wastePct === null) {
        update.wastePct = null;
      } else {
        const w = Number(recipeBody.wastePct);
        if (!Number.isFinite(w) || w < 0 || w > 100) return err('Waste % harus 0–100', 400);
        update.wastePct = w;
      }
    }
    if (recipeBody.lines !== undefined) {
      const fgForLines = String(
        recipeBody.finishedGoodProductId ?? existing.finishedGoodProductId,
      ).trim();
      const linesRaw = normalizeRecipeLines(recipeBody.lines, { finishedGoodProductId: fgForLines });
      if ('error' in linesRaw) return err(linesRaw.error, 400);
      const lines = await enrichLines(db, tenantFilter, linesRaw);
      if ('error' in lines) return err(lines.error, 400);
      update.lines = lines;
    }
    if (recipeBody.catatan !== undefined) {
      update.catatan = String(recipeBody.catatan || '').trim() || null;
    }
    if (recipeBody.aktif !== undefined) {
      update.aktif = !!recipeBody.aktif;
    }

    const nextKode = String(update.kode ?? existing.kode);
    const nextVersion = Number(update.version ?? existing.version);
    const dup = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode: nextKode, version: nextVersion, id: { $ne: id } }),
    );
    if (dup) return err(`Resep ${nextKode} versi ${nextVersion} sudah ada`, 409);

    await db.collection(RECIPES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: update },
    );
    const saved = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'RECIPE_UPDATE',
      entityType: 'recipe',
      entityId: id,
      summary: `Resep ${String(saved?.kode || existing.kode)} diubah`,
      ...auditActor(auth),
    });
    return ok(clean(saved));
  }

  if (path[0] === 'recipes' && path[1] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as RecipeDoc | null;
    if (!existing) return err('Resep tidak ditemukan', 404);

    await db.collection(RECIPES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { aktif: false, updatedAt: new Date() } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'RECIPE_DEACTIVATE',
      entityType: 'recipe',
      entityId: id,
      summary: `Resep ${existing.kode} dinonaktifkan`,
      ...auditActor(auth),
    });
    return ok({ id, aktif: false });
  }

  return null;
}
