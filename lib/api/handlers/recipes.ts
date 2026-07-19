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
  normalizeRecipeNama,
  todayIsoDate,
  type RecipeDoc,
  type RecipeLine,
} from '@/lib/food-production/recipe';
import {
  MBG_RECIPE_SEED_ROWS,
  parseRecipeImportExcel,
  parseRecipeImportAoa,
  recipeImportTemplateXlsxBuffer,
  RECIPE_IMPORT_HEADERS,
  type RecipeImportDraft,
  type RecipeImportProduct,
} from '@/lib/food-production/recipe-import';
import { isFinishedGoodRole, isIngredientRole, normalizeItemRole } from '@/lib/food-production/item-role';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import { nextSequentialCode } from '@/lib/api/document-sequence';
import { storeBase64Image, deleteMediaFile } from '@/lib/api/media-storage';
import { validateBase64Image } from '@/lib/api/image-base64';
import type { HandlerContext } from '@/types/api/handler';
import { NextResponse } from 'next/server';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

interface RecipeBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  finishedGoodProductId?: string | null;
  version?: number;
  effectiveDate?: string;
  yieldQty?: number;
  wastePct?: number | null;
  lines?: unknown;
  catatan?: string;
  /** data-URL baru, URL media yang sudah ada, atau null/'' untuk hapus. */
  gambarBase64?: string | null;
  aktif?: boolean;
}

/** Persist recipe photo: keep existing /api/media URL, store new data-URL, or clear. */
async function resolveRecipeImage(
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
  const checked = validateBase64Image(s, 'Gambar resep');
  if (checked && typeof checked === 'object' && 'error' in checked) return checked;
  if (!checked || !String(checked).startsWith('data:image')) {
    return { error: 'Gambar resep tidak valid' };
  }
  const stored = await storeBase64Image(tenantId, String(checked), {
    prefix: 'recipe',
    maxBytes: 768_000,
  });
  if ('error' in stored) return { error: stored.error };
  if (existing?.gambarMediaFile && existing.gambarMediaFile !== stored.filename) {
    await deleteMediaFile(tenantId, existing.gambarMediaFile);
  }
  return { gambarUrl: stored.url, gambarMediaFile: stored.filename };
}

async function findRecipeByNama(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  nama: string,
  excludeId?: string,
): Promise<RecipeDoc | null> {
  const escaped = nama.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter: Record<string, unknown> = {
    ...tenantFilter,
    nama: { $regex: `^${escaped}$`, $options: 'i' },
    aktif: true,
  };
  if (excludeId) filter.id = { $ne: excludeId };
  return db.collection(RECIPES_COLLECTION).findOne(filter) as Promise<RecipeDoc | null>;
}

async function enrichFinishedGood(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
  productId: string,
): Promise<{ kode?: string; nama?: string } | { error: string }> {
  const prod = await db.collection('products').findOne({
    ...tenantFilter,
    id: productId,
  }) as { kode?: string; nama?: string; itemRole?: string; aktif?: boolean } | null;
  if (!prod) return { error: 'Produk barang jadi tidak ditemukan' };
  if (prod.aktif === false) return { error: 'Produk barang jadi nonaktif' };
  if (!isFinishedGoodRole(prod.itemRole)) {
    const role = normalizeItemRole(prod.itemRole);
    return {
      error: `Produk "${String(prod.nama || prod.kode || productId)}" bukan barang jadi (role: ${role}). Set itemRole = FINISHED_GOOD di master Produk.`,
    };
  }
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
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, itemRole: 1, aktif: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const out: RecipeLine[] = [];
  for (const line of lines) {
    const p = byId.get(line.productId);
    if (!p) return { error: `Bahan ${line.productId} tidak ditemukan` };
    if (p.aktif === false) {
      return { error: `Bahan "${String(p.nama || p.kode || line.productId)}" nonaktif` };
    }
    if (!isIngredientRole(p.itemRole)) {
      const role = normalizeItemRole(p.itemRole);
      return {
        error: `Produk "${String(p.nama || p.kode || line.productId)}" tidak boleh jadi bahan (role: ${role})`,
      };
    }
    out.push({
      ...line,
      productKode: line.productKode || (p.kode != null ? String(p.kode) : undefined),
      productNama: line.productNama || (p.nama != null ? String(p.nama) : undefined),
      satuan: line.satuan || (p.satuan != null ? String(p.satuan) : undefined),
    });
  }
  return out;
}

async function allocateRecipeKode(
  db: HandlerContext['db'],
  tenantId: string,
): Promise<string> {
  await seedRecipeSequence(db, tenantId);
  return nextSequentialCode(db, tenantId, 'RECIPE', 'RSP-', 4);
}

async function peekNextRecipeKode(
  db: HandlerContext['db'],
  tenantId: string,
): Promise<string> {
  await seedRecipeSequence(db, tenantId);
  const seq = await db.collection('document_sequences').findOne({ tenantId, docType: 'RECIPE' });
  const next = Number(seq?.lastNumber || 0) + 1;
  return `RSP-${String(next).padStart(4, '0')}`;
}

async function seedRecipeSequence(
  db: HandlerContext['db'],
  tenantId: string,
): Promise<void> {
  const existing = await db.collection(RECIPES_COLLECTION)
    .find({ tenantId, kode: { $regex: '^RSP-\\d+$' } })
    .project({ kode: 1 })
    .toArray();
  let maxN = 0;
  for (const row of existing) {
    const m = String(row.kode || '').match(/^RSP-(\d+)$/i);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  const seq = await db.collection('document_sequences').findOne({ tenantId, docType: 'RECIPE' });
  const last = Number(seq?.lastNumber || 0);
  if (maxN > last) {
    await db.collection('document_sequences').updateOne(
      { tenantId, docType: 'RECIPE' },
      {
        $set: { lastNumber: maxN, prefix: 'RSP-', updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    );
  }
}

async function loadIngredientProducts(
  db: HandlerContext['db'],
  tenantFilter: Record<string, unknown>,
): Promise<RecipeImportProduct[]> {
  const list = await db.collection('products')
    .find({ ...tenantFilter, aktif: { $ne: false } })
    .project({ id: 1, kode: 1, nama: 1, satuan: 1, itemRole: 1, aktif: 1 })
    .limit(2000)
    .toArray();
  return list
    .filter((p) => isIngredientRole(p.itemRole))
    .map((p) => ({
      id: String(p.id),
      kode: String(p.kode || ''),
      nama: String(p.nama || ''),
      satuan: p.satuan != null ? String(p.satuan) : undefined,
      itemRole: p.itemRole != null ? String(p.itemRole) : undefined,
      aktif: p.aktif !== false,
    }));
}

async function commitRecipeImports(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof tenantIdForWrite>[0],
  auth: NonNullable<HandlerContext['auth']>,
  drafts: RecipeImportDraft[],
  recipeBody: RecipeBody,
): Promise<{ created: Array<{ id: string; kode: string; nama: string }>; skipped: string[] }> {
  const tenantId = tenantIdForWrite(scopeAuth, recipeBody);
  const tenantFilter = withTenantFilter(scopeAuth, {});
  const created: Array<{ id: string; kode: string; nama: string }> = [];
  const skipped: string[] = [];

  for (const draft of drafts) {
    if (!draft.ok) {
      skipped.push(`${draft.nama}: belum siap (mapping bahan belum lengkap)`);
      continue;
    }
    const namaDup = await findRecipeByNama(db, tenantFilter, draft.nama);
    if (namaDup) {
      skipped.push(`${draft.nama}: sudah ada (${namaDup.kode})`);
      continue;
    }
    const linesRaw = normalizeRecipeLines(
      draft.lines.map((l) => ({
        productId: l.productId,
        qty: l.qty,
        qtyBesar: l.qty,
        pctKecil: l.pctKecil,
        satuan: l.satuan,
        notes: l.notes,
        productKode: l.productKode,
        productNama: l.productNama,
      })),
    );
    if ('error' in linesRaw) {
      skipped.push(`${draft.nama}: ${linesRaw.error}`);
      continue;
    }
    const lines = await enrichLines(db, tenantFilter, linesRaw);
    if ('error' in lines) {
      skipped.push(`${draft.nama}: ${lines.error}`);
      continue;
    }
    const now = new Date();
    const kode = await allocateRecipeKode(db, tenantId);
    const doc: RecipeDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama: draft.nama,
      version: 1,
      effectiveDate: draft.effectiveDate || todayIsoDate(),
      yieldQty: draft.yieldQty,
      wastePct: draft.wastePct,
      lines,
      catatan: draft.catatan
        ? `${draft.catatan} · import bank resep`
        : 'Import bank resep',
      aktif: true,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(RECIPES_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'RECIPE_IMPORT',
      entityType: 'recipe',
      entityId: doc.id,
      summary: `Import resep ${doc.kode} — ${doc.nama}`,
      ...auditActor(auth),
    });
    created.push({ id: doc.id, kode: doc.kode, nama: doc.nama });
  }

  return { created, skipped };
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

  if (route === '/recipes/import-template' && method === 'GET') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const buf = recipeImportTemplateXlsxBuffer();
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="template-import-resep-sppg.xlsx"',
      },
    });
  }

  if (route === '/recipes/import' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    if (!auth) return err('Unauthorized', 401);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: recipeBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const source = String(recipeBody.source || 'excel').trim();
    const dryRun = recipeBody.dryRun !== false;
    const products = await loadIngredientProducts(db, withTenantFilter(scopeAuth, {}));

    let parsed;
    if (source === 'seed') {
      parsed = parseRecipeImportAoa(
        [[...RECIPE_IMPORT_HEADERS], ...MBG_RECIPE_SEED_ROWS],
        products,
      );
    } else {
      const excelBase64 = String(recipeBody.excelBase64 || recipeBody.fileBase64 || '').trim();
      if (!excelBase64) return err('Unggah file Excel (.xlsx)', 400);
      parsed = parseRecipeImportExcel(excelBase64, products);
    }

    if (parsed.errors.length && !parsed.recipes.length) {
      return err(parsed.errors[0] || 'Excel tidak valid', 400);
    }

    const ready = parsed.recipes.filter((r) => r.ok).length;
    const blocked = parsed.recipes.filter((r) => !r.ok).length;

    if (dryRun) {
      return ok({
        dryRun: true,
        parseErrors: parsed.errors,
        summary: {
          recipes: parsed.recipes.length,
          ready,
          blocked,
          productsAvailable: products.length,
        },
        recipes: parsed.recipes,
      });
    }

    const { created, skipped } = await commitRecipeImports(
      db,
      scopeAuth,
      auth,
      parsed.recipes,
      recipeBody,
    );
    return ok({
      dryRun: false,
      parseErrors: parsed.errors,
      summary: {
        recipes: parsed.recipes.length,
        ready,
        blocked,
        created: created.length,
        skipped: skipped.length,
      },
      created,
      skipped,
      recipes: parsed.recipes,
    });
  }

  if (route === '/recipes' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    if (url.searchParams.get('nextKode') === '1') {
      const tenantId = tenantIdForWrite(scopeAuth, {});
      const kode = await peekNextRecipeKode(db, tenantId);
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

    const list = await db.collection(RECIPES_COLLECTION)
      .find(filter)
      .sort({ kode: 1 })
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

    const nama = normalizeRecipeNama(recipeBody.nama);
    if (!nama) return err('Nama resep wajib diisi');
    const yieldQty = Number(recipeBody.yieldQty);
    if (!Number.isFinite(yieldQty) || yieldQty <= 0) return err('Yield (porsi) harus > 0');

    const finishedGoodProductId = String(recipeBody.finishedGoodProductId || '').trim();
    const linesRaw = normalizeRecipeLines(recipeBody.lines, {
      finishedGoodProductId: finishedGoodProductId || undefined,
    });
    if ('error' in linesRaw) return err(linesRaw.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, recipeBody);
    const tenantFilter = withTenantFilter(scopeAuth, {});

    const namaDup = await findRecipeByNama(db, tenantFilter, nama);
    if (namaDup) {
      return err(
        `Resep "${namaDup.nama}" sudah ada (${namaDup.kode}). Ubah nama untuk item baru, atau batalkan jika sama.`,
        409,
      );
    }

    let fgKode: string | undefined;
    let fgNama: string | undefined;
    if (finishedGoodProductId) {
      const fg = await enrichFinishedGood(db, tenantFilter, finishedGoodProductId);
      if ('error' in fg) return err(fg.error, 400);
      fgKode = fg.kode;
      fgNama = fg.nama;
    }
    const lines = await enrichLines(db, tenantFilter, linesRaw);
    if ('error' in lines) return err(lines.error, 400);

    let wastePct: number | undefined;
    if (recipeBody.wastePct != null) {
      const w = Number(recipeBody.wastePct);
      if (!Number.isFinite(w) || w < 0 || w > 100) return err('Waste % harus 0–100', 400);
      wastePct = w;
    }

    const image = await resolveRecipeImage(tenantId, recipeBody.gambarBase64);
    if ('error' in image) return err(image.error, 400);

    const now = new Date();
    // Kode always server-allocated (RSP-0001…) — not client-editable
    const kode = await allocateRecipeKode(db, tenantId);
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
      finishedGoodProductId: finishedGoodProductId || undefined,
      finishedGoodKode: fgKode,
      finishedGoodNama: fgNama,
      version,
      effectiveDate,
      yieldQty,
      wastePct,
      lines,
      catatan: String(recipeBody.catatan || '').trim() || undefined,
      gambarUrl: image.gambarUrl || undefined,
      gambarMediaFile: image.gambarMediaFile || undefined,
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
      const nama = normalizeRecipeNama(recipeBody.nama);
      if (!nama) return err('Nama resep wajib diisi');
      const namaDup = await findRecipeByNama(db, tenantFilter, nama, id);
      if (namaDup) {
        return err(
          `Resep "${namaDup.nama}" sudah ada (${namaDup.kode}). Nama harus unik.`,
          409,
        );
      }
      update.nama = nama;
    }
    // Kode immutable after create
    if (recipeBody.finishedGoodProductId !== undefined) {
      const finishedGoodProductId = String(recipeBody.finishedGoodProductId || '').trim();
      if (!finishedGoodProductId) {
        update.finishedGoodProductId = null;
        update.finishedGoodKode = null;
        update.finishedGoodNama = null;
      } else {
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
        recipeBody.finishedGoodProductId !== undefined
          ? recipeBody.finishedGoodProductId || ''
          : existing.finishedGoodProductId || '',
      ).trim();
      const linesRaw = normalizeRecipeLines(recipeBody.lines, {
        finishedGoodProductId: fgForLines || undefined,
      });
      if ('error' in linesRaw) return err(linesRaw.error, 400);
      const lines = await enrichLines(db, tenantFilter, linesRaw);
      if ('error' in lines) return err(lines.error, 400);
      update.lines = lines;
    }
    if (recipeBody.catatan !== undefined) {
      update.catatan = String(recipeBody.catatan || '').trim() || null;
    }
    if (recipeBody.gambarBase64 !== undefined) {
      const image = await resolveRecipeImage(
        existing.tenantId,
        recipeBody.gambarBase64,
        { gambarUrl: existing.gambarUrl, gambarMediaFile: existing.gambarMediaFile },
      );
      if ('error' in image) return err(image.error, 400);
      update.gambarUrl = image.gambarUrl ?? null;
      update.gambarMediaFile = image.gambarMediaFile ?? null;
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
    const hard = url.searchParams.get('hard') === '1';
    const existing = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as RecipeDoc | null;
    if (!existing) return err('Resep tidak ditemukan', 404);

    if (hard) {
      const used = await db.collection(MENUS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { 'items.recipeId': id, aktif: true }),
      );
      if (used) {
        return err(
          `Resep ${existing.kode} masih dipakai menu aktif "${String(used.nama || used.kode)}". Nonaktifkan/hapus dari menu dulu.`,
          409,
        );
      }
      await db.collection(RECIPES_COLLECTION).deleteOne(
        withTenantFilter(scopeAuth, { id }),
      );
      if (existing.gambarMediaFile) {
        await deleteMediaFile(existing.tenantId, existing.gambarMediaFile);
      }
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'RECIPE_DELETE',
        entityType: 'recipe',
        entityId: id,
        summary: `Resep ${existing.kode} dihapus permanen`,
        ...auditActor(auth),
      });
      return ok({ id, deleted: true });
    }

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
