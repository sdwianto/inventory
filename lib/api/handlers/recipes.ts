import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean, cors } from '@/lib/api/db';
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
  applyFullPortionExceptions,
  applySppgPortionStandards,
  isKategoriMenu,
  type RecipeDoc,
  type RecipeLine,
  type KategoriMenu,
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
import { attachLiveCatalogProducts, isCatalogProductActive, loadLiveProductMap, resolveCatalogProductsInTenant, type LiveCatalogProduct } from '@/lib/api/resolve-live-catalog-product';
import {
  convertRecipeLineForProduct,
  formatRecipeConversionIssues,
  resolveRecipeLineForExecution,
  type RecipeConversionIssue,
} from '@/lib/food-production/recipe-conversion';
import { isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { MENUS_COLLECTION } from '@/lib/food-production/menu';
import { nextSequentialCode } from '@/lib/api/document-sequence';
import { storeBase64Image, deleteMediaFile } from '@/lib/api/media-storage';
import { validateBase64Image } from '@/lib/api/image-base64';
import type { HandlerContext } from '@/types/api/handler';
import { NextResponse } from 'next/server';
import { loadRecipePortionExceptionSet } from '@/lib/api/handlers/recipe-portion-exceptions';
import { casConflict } from '@/lib/api/cas';
import { insertRecipeWithRevision, updateRecipeWithRevision } from '@/lib/api/recipe-revisions';
import { RECIPE_REVISIONS_COLLECTION } from '@/lib/food-production/recipe-revision';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;

interface RecipeBody extends Record<string, unknown> {
  kode?: string;
  nama?: string;
  finishedGoodProductId?: string | null;
  version?: number;
  effectiveDate?: string;
  yieldQty?: number;
  kategoriMenu?: string | null;
  wastePct?: number | null;
  lines?: unknown;
  catatan?: string;
  /** data-URL baru, URL media yang sudah ada, atau null/'' untuk hapus. */
  gambarBase64?: string | null;
  aktif?: boolean;
  /** `updatedAt` resep saat form dibuka; beda dengan server → 409 (edit bersamaan). */
  expectedUpdatedAt?: string | null;
}

function parseKategoriMenu(
  raw: unknown,
  opts: { required?: boolean } = {},
): { value: KategoriMenu } | { value: null } | { error: string } | Record<string, never> {
  if (raw === undefined) {
    if (opts.required) return { error: 'Kategori Menu wajib dipilih' };
    return {};
  }
  if (raw === null || raw === '') {
    if (opts.required) return { error: 'Kategori Menu wajib dipilih' };
    return { value: null };
  }
  const v = String(raw).trim();
  if (!isKategoriMenu(v)) return { error: 'Kategori Menu tidak valid' };
  return { value: v };
}

/** Persist recipe photo: keep existing /api/media URL, store new data-URL, or clear. */
async function resolveRecipeImage(
  tenantId: string,
  incoming: unknown,
  existing?: { gambarUrl?: string; gambarMediaFile?: string },
  opts: { deferDelete?: boolean } = {},
): Promise<
  | { gambarUrl?: string | null; gambarMediaFile?: string | null; storedMediaFile?: string; obsoleteMediaFile?: string }
  | { error: string }
> {
  if (incoming === undefined) {
    return {
      gambarUrl: existing?.gambarUrl,
      gambarMediaFile: existing?.gambarMediaFile,
    };
  }
  const dropExisting = async () => {
    if (!existing?.gambarMediaFile) return undefined;
    if (opts.deferDelete) return existing.gambarMediaFile;
    await deleteMediaFile(tenantId, existing.gambarMediaFile);
    return undefined;
  };
  if (incoming === null || incoming === '') {
    return { gambarUrl: null, gambarMediaFile: null, obsoleteMediaFile: await dropExisting() };
  }
  const s = String(incoming).trim();
  if (!s) {
    return { gambarUrl: null, gambarMediaFile: null, obsoleteMediaFile: await dropExisting() };
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
  let obsoleteMediaFile: string | undefined;
  if (existing?.gambarMediaFile && existing.gambarMediaFile !== stored.filename) {
    obsoleteMediaFile = await dropExisting();
  }
  return { gambarUrl: stored.url, gambarMediaFile: stored.filename, storedMediaFile: stored.filename, obsoleteMediaFile };
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
  tenantId: string,
  productId: string,
): Promise<{ kode?: string; nama?: string } | { error: string }> {
  const resolved = await resolveCatalogProductsInTenant(db, tenantId, [productId]);
  const found = resolved.get(productId);
  if (!found) return { error: 'Produk barang jadi tidak ditemukan' };
  const liveMap = await attachLiveCatalogProducts(db, tenantId, [found]);
  const prod = liveMap.get(String(found.id || productId)) || found;
  if (!isCatalogProductActive(prod)) return { error: 'Produk barang jadi nonaktif' };
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
  tenantId: string,
  lines: RecipeLine[],
  yieldQty = 0,
): Promise<RecipeLine[] | { error: string; conversionIssues?: RecipeConversionIssue[] }> {
  const strict = await isTenantFeatureEnabled(db, tenantId, 'strictRecipeConversion');
  const ids = [...new Set(lines.map((l) => l.productId))];
  const resolved = await resolveCatalogProductsInTenant(db, tenantId, ids);
  const products = [...resolved.values()];
  const liveMap = await attachLiveCatalogProducts(db, tenantId, products);
  const out: RecipeLine[] = [];
  const issues: RecipeConversionIssue[] = [];
  for (const line of lines) {
    const resolvedRow = resolved.get(line.productId);
    const p: LiveCatalogProduct | undefined = (resolvedRow
      ? (liveMap.get(String(resolvedRow.id || '')) || resolvedRow)
      : undefined)
      || liveMap.get(line.productId);
    if (!p) return { error: `Bahan ${line.productId} tidak ditemukan` };
    if (!isCatalogProductActive(p)) {
      return { error: `Bahan "${String(p.nama || p.kode || line.productId)}" nonaktif` };
    }
    if (!isIngredientRole(p.itemRole)) {
      const role = normalizeItemRole(p.itemRole);
      return {
        error: `Produk "${String(p.nama || p.kode || line.productId)}" tidak boleh jadi bahan (role: ${role})`,
      };
    }

    const converted = convertRecipeLineForProduct(line, p, { strict });
    if (!converted.ok) {
      const label = String(p.nama || p.kode || line.productId);
      if (!strict) return { error: `Bahan "${label}": ${converted.error}` };
      issues.push({
        productId: String(p.id || line.productId),
        productKode: p.kode != null ? String(p.kode) : undefined,
        productNama: p.nama != null ? String(p.nama) : undefined,
        code: converted.code,
        error: converted.error,
      });
      continue;
    }
    out.push(converted.line);
  }
  if (issues.length) {
    return { error: formatRecipeConversionIssues(issues), conversionIssues: issues };
  }
  const exceptionKeys = await loadRecipePortionExceptionSet(db, { tenantId });
  return applySppgPortionStandards(
    applyFullPortionExceptions(out, exceptionKeys),
    yieldQty,
  );
}

function enrichError(res: { error: string; conversionIssues?: RecipeConversionIssue[] }): NextResponse {
  if (!res.conversionIssues?.length) return err(res.error, 400);
  return cors(NextResponse.json(
    { error: res.error, code: 'RECIPE_CONVERSION_INVALID', conversionIssues: res.conversionIssues },
    { status: 422 },
  ));
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
    .find({
      ...tenantFilter,
      aktif: { $ne: false },
      // Impor Excel memetakan ke master Produk tenant (termasuk yang sync dari sales.app), bukan salinan vendor tergabung.
      mergedInto: null,
    })
    .project({
      id: 1, kode: 1, nama: 1, satuan: 1, itemRole: 1, aktif: 1,
      recipeBaseGrams: 1, recipeBaseMl: 1, isiPerKemasan: 1, satuanIsi: 1,
    })
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
      recipeBaseGrams: p.recipeBaseGrams != null ? Number(p.recipeBaseGrams) : undefined,
      recipeBaseMl: p.recipeBaseMl != null ? Number(p.recipeBaseMl) : undefined,
      isiPerKemasan: p.isiPerKemasan != null ? Number(p.isiPerKemasan) : undefined,
      satuanIsi: p.satuanIsi != null ? String(p.satuanIsi) : undefined,
    }));
}

/** Preview impor strict: tandai draf yang bahannya belum punya konversi valid (sama dengan saat simpan). */
function flagStrictImportConversion(drafts: RecipeImportDraft[], products: RecipeImportProduct[]): void {
  const byId = new Map(products.map((p) => [p.id, p]));
  for (const draft of drafts) {
    for (const l of draft.lines) {
      const p = l.productId ? byId.get(l.productId) : undefined;
      if (!p) continue;
      const res = convertRecipeLineForProduct(
        {
          productId: p.id,
          qty: l.qty,
          qtyBesar: l.qty,
          qtyKecil: 0,
          satuan: l.satuan,
          productKode: p.kode,
          productNama: p.nama,
        } as RecipeLine,
        p,
        { strict: true },
      );
      if (!res.ok) draft.errors.push(`Bahan "${p.nama || p.kode}": ${res.error}`);
    }
    if (draft.errors.length) draft.ok = false;
  }
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
    const lines = await enrichLines(
      db,
      tenantId,
      applySppgPortionStandards(linesRaw, draft.yieldQty),
      draft.yieldQty,
    );
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
    await insertRecipeWithRevision(db, doc, {
      reason: 'IMPORT',
      actor: auditActor(auth),
      audit: {
        tenantId,
        action: 'RECIPE_IMPORT',
        entityType: 'recipe',
        entityId: doc.id,
        summary: `Import resep ${doc.kode} — ${doc.nama}`,
        ...auditActor(auth),
      },
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
    const strict = await isTenantFeatureEnabled(
      db,
      tenantIdForWrite(scopeAuth, recipeBody),
      'strictRecipeConversion',
    );
    const parseOpts = { requireSatuan: strict };

    let parsed;
    if (source === 'seed') {
      parsed = parseRecipeImportAoa(
        [[...RECIPE_IMPORT_HEADERS], ...MBG_RECIPE_SEED_ROWS],
        products,
        parseOpts,
      );
    } else {
      const excelBase64 = String(recipeBody.excelBase64 || recipeBody.fileBase64 || '').trim();
      if (!excelBase64) return err('Unggah file Excel (.xlsx)', 400);
      parsed = parseRecipeImportExcel(excelBase64, products, parseOpts);
    }

    if (parsed.errors.length && !parsed.recipes.length) {
      return err(parsed.errors[0] || 'Excel tidak valid', 400);
    }
    if (strict) flagStrictImportConversion(parsed.recipes, products);

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
    const idsParam = (url.searchParams.get('ids') || '').trim();
    if (idsParam) {
      const ids = [...new Set(idsParam.split(',').map((s) => s.trim()).filter(Boolean))];
      if (ids.length) filter.id = { $in: ids.slice(0, 200) };
    }
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

    const exceptionKeys = await loadRecipePortionExceptionSet(db, withTenantFilter(scopeAuth, {}));
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const productIds = [...new Set(
      list.flatMap((doc) => ((doc as unknown as RecipeDoc).lines || []).map((l) => l.productId)),
    )];
    const [liveMap, strict] = await Promise.all([
      loadLiveProductMap(db, tenantId, productIds),
      isTenantFeatureEnabled(db, tenantId, 'strictRecipeConversion'),
    ]);
    return ok(list.map((doc) => {
      const recipe = doc as unknown as RecipeDoc;
      const lines = applySppgPortionStandards(
        applyFullPortionExceptions(recipe.lines, exceptionKeys),
        recipe.yieldQty,
      ).map((line) => {
        const resolved = resolveRecipeLineForExecution(line, liveMap.get(line.productId), { strict });
        const problem = resolved.error || resolved.warning;
        return problem ? { ...resolved.line, conversionWarning: problem } : resolved.line;
      });
      return clean({
        ...recipe,
        lines,
      } as unknown as Record<string, unknown>);
    }));
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

    const kategoriParsed = parseKategoriMenu(recipeBody.kategoriMenu, { required: true });
    if ('error' in kategoriParsed) return err(kategoriParsed.error, 400);
    if (!('value' in kategoriParsed) || !kategoriParsed.value) {
      return err('Kategori Menu wajib dipilih', 400);
    }
    const kategoriMenu = kategoriParsed.value;

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
      const fg = await enrichFinishedGood(db, tenantId, finishedGoodProductId);
      if ('error' in fg) return err(fg.error, 400);
      fgKode = fg.kode;
      fgNama = fg.nama;
    }
    const lines = await enrichLines(
      db,
      tenantId,
      applySppgPortionStandards(linesRaw, yieldQty),
      yieldQty,
    );
    if ('error' in lines) return enrichError(lines);

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
      kategoriMenu,
      wastePct,
      lines,
      catatan: String(recipeBody.catatan || '').trim() || undefined,
      gambarUrl: image.gambarUrl || undefined,
      gambarMediaFile: image.gambarMediaFile || undefined,
      aktif: recipeBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    await insertRecipeWithRevision(db, doc, {
      reason: 'CREATE',
      actor: auditActor(auth),
      audit: {
        tenantId,
        action: 'RECIPE_CREATE',
        entityType: 'recipe',
        entityId: doc.id,
        summary: `Resep ${doc.kode} v${doc.version} dibuat`,
        ...auditActor(auth),
      },
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  // GET /recipes/:id/revisions[/:revisionId] — riwayat revisi (isi tidak berubah setelah ditulis)
  if (path[0] === 'recipes' && path[1] && path[2] === 'revisions' && !path[4] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const recipe = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { projection: { id: 1, kode: 1, nama: 1, currentRevisionId: 1, revision: 1 } },
    );
    if (path[3]) {
      const rev = await db.collection(RECIPE_REVISIONS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { recipeId: path[1], id: path[3] }),
        { projection: { _id: 0 } },
      );
      if (!rev) return err('Revisi resep tidak ditemukan', 404);
      return ok({ ...rev, current: recipe?.currentRevisionId === rev.id });
    }
    const revisions = await db.collection(RECIPE_REVISIONS_COLLECTION)
      .find(withTenantFilter(scopeAuth, { recipeId: path[1] }))
      .sort({ revision: -1 })
      .limit(200)
      .project({ _id: 0, id: 1, revision: 1, reason: 1, createdAt: 1, createdByName: 1, nama: 1, yieldQty: 1, version: 1, lines: 1 })
      .toArray();
    if (!recipe && !revisions.length) return err('Resep tidak ditemukan', 404);
    return ok({
      recipeId: path[1],
      kode: recipe?.kode ?? null,
      nama: recipe?.nama ?? null,
      currentRevisionId: recipe?.currentRevisionId ?? null,
      deleted: !recipe,
      revisions: revisions.map(({ lines, ...r }) => ({ ...r, lineCount: Array.isArray(lines) ? lines.length : 0 })),
    });
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
    if (recipeBody.expectedUpdatedAt !== undefined && recipeBody.expectedUpdatedAt !== null) {
      const expected = new Date(String(recipeBody.expectedUpdatedAt)).getTime();
      const actual = existing.updatedAt ? new Date(existing.updatedAt).getTime() : NaN;
      if (!Number.isFinite(expected) || expected !== actual) {
        return casConflict('Resep sudah diubah pengguna lain sejak dibuka — muat ulang lalu simpan lagi');
      }
    }

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
        const fg = await enrichFinishedGood(db, tenantIdForWrite(scopeAuth, recipeBody), finishedGoodProductId);
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
    if (recipeBody.kategoriMenu !== undefined) {
      const kategoriParsed = parseKategoriMenu(recipeBody.kategoriMenu, { required: true });
      if ('error' in kategoriParsed) return err(kategoriParsed.error, 400);
      update.kategoriMenu = kategoriParsed.value;
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
      const yieldForLines = Number(
        recipeBody.yieldQty != null ? recipeBody.yieldQty : existing.yieldQty,
      );
      const lines = await enrichLines(
        db,
        tenantIdForWrite(scopeAuth, recipeBody),
        applySppgPortionStandards(linesRaw, yieldForLines),
        yieldForLines,
      );
      if ('error' in lines) return enrichError(lines);
      update.lines = lines;
    }
    if (recipeBody.catatan !== undefined) {
      update.catatan = String(recipeBody.catatan || '').trim() || null;
    }
    let storedMediaFile: string | undefined;
    let obsoleteMediaFile: string | undefined;
    if (recipeBody.gambarBase64 !== undefined) {
      // File lama baru dihapus setelah simpan berhasil: konflik 409 tidak boleh meninggalkan resep tanpa gambar.
      const image = await resolveRecipeImage(
        existing.tenantId,
        recipeBody.gambarBase64,
        { gambarUrl: existing.gambarUrl, gambarMediaFile: existing.gambarMediaFile },
        { deferDelete: true },
      );
      if ('error' in image) return err(image.error, 400);
      update.gambarUrl = image.gambarUrl ?? null;
      update.gambarMediaFile = image.gambarMediaFile ?? null;
      storedMediaFile = image.storedMediaFile;
      obsoleteMediaFile = image.obsoleteMediaFile;
    }
    if (recipeBody.aktif !== undefined) {
      update.aktif = !!recipeBody.aktif;
    }

    const nextKode = String(update.kode ?? existing.kode);
    const nextVersion = Number(update.version ?? existing.version);
    const dup = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { kode: nextKode, version: nextVersion, id: { $ne: id } }),
    );
    const discardStored = async () => {
      if (storedMediaFile) await deleteMediaFile(existing.tenantId, storedMediaFile);
    };
    if (dup) {
      await discardStored();
      return err(`Resep ${nextKode} versi ${nextVersion} sudah ada`, 409);
    }

    let result: Awaited<ReturnType<typeof updateRecipeWithRevision>>;
    try {
      result = await updateRecipeWithRevision(db, existing, update, {
        actor: auditActor(auth),
        now: update.updatedAt as Date,
        audit: (revisions) => {
          const latest = revisions[revisions.length - 1];
          return {
            tenantId: existing.tenantId,
            action: 'RECIPE_UPDATE',
            entityType: 'recipe',
            entityId: id,
            summary: latest
              ? `Resep ${existing.kode} diubah — revisi ${latest.revision}`
              : `Resep ${existing.kode} diubah (tanpa perubahan isi)`,
            metadata: { revisions: revisions.map((r) => ({ id: r.id, revision: r.revision, reason: r.reason })) },
            ...auditActor(auth),
          };
        },
      });
    } catch (e) {
      await discardStored();
      throw e;
    }
    if (!result.ok) {
      await discardStored();
      return casConflict('Resep sudah diubah pengguna lain sejak dibuka — muat ulang lalu simpan lagi');
    }
    if (obsoleteMediaFile) await deleteMediaFile(existing.tenantId, obsoleteMediaFile);
    const saved = await db.collection(RECIPES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
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
