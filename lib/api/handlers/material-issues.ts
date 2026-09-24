import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import type { ClientSession } from 'mongodb';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { guardPosting } from '@/lib/api/period-lock';
import { postStockMovements, type StockActor } from '@/lib/stock-ledger';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import {
  MATERIAL_ISSUES_COLLECTION,
  ISSUE_ELIGIBLE_PLAN_STATUSES,
  ISSUE_OPEN_STATUSES,
  ISSUE_STATUS_TRANSITIONS,
  isIssueEditable,
  isIssueReconcilable,
  buildIssueLinesFromMrp,
  buildReferenceIssueLines,
  isReferenceIssue,
  summarizeIssueLines,
  summarizeReferenceIssueLines,
  normalizeIssueLines,
  postingDateFromIso,
  type MaterialIssueDoc,
  type MaterialIssueStatus,
} from '@/lib/food-production/material-issue';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import {
  PRODUCTION_PLANS_COLLECTION,
  cookDateFromPlanTanggal,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { buildPlanMaterialExplosion, buildPlanReadiness, planFallbackMrpLines } from '@/lib/api/handlers/material-requirements';
import { RL_PENDING_STATUSES, loadPlanReference, type PlanReference } from '@/lib/food-production/plan-reference';
import { isPblReferenceModeEnabled, isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { resolveProductGudangKode } from '@/lib/api/product-warehouse';
import { isCatalogProductActive, loadLiveProductMap } from '@/lib/api/resolve-live-catalog-product';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import {
  buildIssueReconciliation,
  applyReconciliationToLines,
  seedNetIssueLines,
} from '@/lib/food-production/material-issue-reconcile';
import type { HandlerContext } from '@/types/api/handler';
import { insertWithAudit, casConflict, casEditFilter, casStatusFilter, casUpdateWithAudit } from '@/lib/api/cas';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

interface IssueBody extends Record<string, unknown> {
  productionPlanId?: string;
  materialRequirementId?: string;
  lines?: unknown;
  catatan?: string;
  status?: string;
  note?: string;
  overrideShortage?: boolean;
  overrideShortageNote?: string;
  reason?: string;
  closureOnly?: boolean;
  closureReason?: string;
}

function actorFields(auth: HandlerContext['auth']) {
  return auditActor(auth);
}

function project(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean(doc);
}

function isDuplicateKeyError(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: number }).code === 11000);
}

async function resolveWarehouse(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  plan: ProductionPlanDoc,
): Promise<string | { error: string }> {
  let warehouseKode = String(plan.kitchenWarehouseKode || '').trim();
  if (!warehouseKode) {
    const kitchen = await db.collection(KITCHENS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: plan.kitchenId }),
    ) as { defaultWarehouseKode?: string } | null;
    warehouseKode = String(kitchen?.defaultWarehouseKode || '').trim();
  }
  if (!warehouseKode) return { error: 'Dapur belum punya gudang default' };
  return warehouseKode;
}

async function enrichIssueLineWarehouses(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
  lines: MaterialIssueDoc['lines'],
  fallbackWarehouse?: string,
): Promise<MaterialIssueDoc['lines']> {
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  if (!ids.length) return lines;
  const products = await db.collection('products')
    .find(withTenantFilter(scopeAuth, { id: { $in: ids } }))
    .project({ id: 1, gudangKode: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  return lines.map((l) => {
    if (l.warehouseKode) return l;
    const prod = byId.get(l.productId) as { gudangKode?: string } | undefined;
    return {
      ...l,
      warehouseKode: resolveProductGudangKode(prod) || fallbackWarehouse,
    };
  });
}

async function seedLinesFromPlan(
  db: HandlerContext['db'],
  scopeAuth: HandlerContext['auth'],
  plan: ProductionPlanDoc,
  materialRequirementId?: string,
): Promise<
  | { error: string }
  | {
      lines: MaterialIssueDoc['lines'];
      materialRequirementId?: string;
      materialRequirementNo?: string;
      warehouseKode: string;
    }
> {
  const warehouseKode = await resolveWarehouse(db, scopeAuth, plan);
  if (typeof warehouseKode !== 'string') return warehouseKode;

  if (materialRequirementId) {
    const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: materialRequirementId }),
    ) as MaterialRequirementDoc | null;
    if (!mrp) return { error: 'Kebutuhan bahan tidak ditemukan' };
    if (mrp.productionPlanId !== plan.id) {
      return { error: 'MRP tidak cocok dengan rencana produksi' };
    }
    const lines = await enrichIssueLineWarehouses(
      db,
      scopeAuth,
      buildIssueLinesFromMrp(mrp.lines || []),
      warehouseKode,
    );
    if (!lines.length) return { error: 'MRP tidak punya qty bahan (qtyGross)' };
    return {
      lines,
      materialRequirementId: mrp.id,
      materialRequirementNo: mrp.noDokumen,
      warehouseKode,
    };
  }

  // Latest APPROVED MRP for plan, else explode
  const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, {
      productionPlanId: plan.id,
      status: { $in: ['APPROVED', 'PROCESSING', 'COMPLETED'] },
    }),
    { sort: { createdAt: -1 } },
  ) as MaterialRequirementDoc | null;
  if (mrp?.lines?.length) {
    const lines = await enrichIssueLineWarehouses(
      db,
      scopeAuth,
      buildIssueLinesFromMrp(mrp.lines),
      warehouseKode,
    );
    if (lines.length) {
      return {
        lines,
        materialRequirementId: mrp.id,
        materialRequirementNo: mrp.noDokumen,
        warehouseKode,
      };
    }
  }

  // Fallback: explode langsung dari rencana + acuan porsi tanggal/dapur
  const exploded = await buildPlanMaterialExplosion(db, scopeAuth, plan);
  if ('error' in exploded) return { error: String(exploded.error || 'Gagal hitung bahan') };
  const lines = await enrichIssueLineWarehouses(
    db,
    scopeAuth,
    buildIssueLinesFromMrp(exploded.lines),
    warehouseKode,
  );
  if (!lines.length) return { error: 'Tidak ada bahan dari rencana' };
  return { lines, warehouseKode: String(exploded.warehouseKode || warehouseKode) };
}

/**
 * Acuan rencana untuk PBL acuan (Fase 1.4): baris dari `loadPlanReference`, qty keluar 0.
 * `session`: dibaca dalam snapshot transaksi (selesai); tanpa session ikut isi stok untuk tampilan.
 */
async function loadIssueReference(
  db: HandlerContext['db'],
  scopeAuth: Parameters<typeof withTenantFilter>[0],
  plan: ProductionPlanDoc,
  opts: {
    fallbackWarehouse?: string;
    session?: ClientSession;
    fallbackMrpLines?: Awaited<ReturnType<typeof planFallbackMrpLines>>;
  } = {},
): Promise<{ reference: PlanReference; lines: MaterialIssueDoc['lines'] }> {
  const fallbackMrpLines = opts.fallbackMrpLines ?? await planFallbackMrpLines(db, scopeAuth, plan);
  const reference = await loadPlanReference(db, scopeAuth, plan, {
    fallbackMrpLines,
    pendingRl: {},
    ...(opts.session ? { session: opts.session } : { withStock: true }),
  });
  const lines = await enrichIssueLineWarehouses(
    db,
    scopeAuth,
    buildReferenceIssueLines(reference.lines),
    opts.fallbackWarehouse,
  );
  return { reference, lines };
}

function describeSisaLines(lines: MaterialIssueDoc['lines']): string {
  const sisa = lines.filter((l) => (Number(l.sisa) || 0) > 0);
  const head = sisa.slice(0, 5)
    .map((l) => `${l.productNama || l.productKode || l.productId} sisa ${l.sisa} ${l.satuan || ''}`.trim())
    .join('; ');
  return sisa.length > 5 ? `${head}; +${sisa.length - 5} lainnya` : head;
}

async function assertIssueProductsActive(
  db: HandlerContext['db'],
  tenantId: string,
  lines: MaterialIssueDoc['lines'],
): Promise<string | null> {
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  if (!ids.length) return 'Tidak ada baris bahan';
  const products = await db.collection('products')
    .find({ tenantId, id: { $in: ids } })
    .project({ id: 1, nama: 1, kode: 1, aktif: 1 })
    .toArray();
  const byId = new Map(products.map((p) => [String(p.id), p]));
  const liveMap = await loadLiveProductMap(db, tenantId, ids);
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) return `Produk ${id} tidak ditemukan`;
    const live = liveMap.get(id) || p;
    if (!isCatalogProductActive(live)) {
      return `Produk "${String(p.nama || p.kode || id)}" tidak aktif`;
    }
  }
  return null;
}

async function postIssueStock(
  db: HandlerContext['db'],
  doc: MaterialIssueDoc,
  session: ClientSession | undefined,
  actor: StockActor,
  postingDate: Date,
): Promise<{
  error: string;
} | {
  ok: true;
  fefoConsume: NonNullable<MaterialIssueDoc['fefoConsume']>;
}> {
  if (!session) {
    return {
      error: 'Posting stok Issue membutuhkan transaksi MongoDB (replica set). Jalankan mongod --replSet rs0',
    };
  }
  const productIds = [...new Set(doc.lines.map((l) => l.productId).filter(Boolean))];
  const products = productIds.length
    ? await db.collection('products')
      .find({ tenantId: doc.tenantId, id: { $in: productIds } }, txOpts(session))
      .project({ id: 1, gudangKode: 1 })
      .toArray()
    : [];
  const gudangById = new Map(
    products.map((p) => [String(p.id), resolveProductGudangKode(p as { gudangKode?: string })]),
  );

  const movementLines = doc.lines
    .map((line, idx) => ({ line, idx, needQty: Number(line.qtyIssued) }))
    .filter(({ needQty }) => needQty > 0)
    .map(({ line, idx, needQty }) => ({
      lineRef: `${idx + 1}:${line.productId}`,
      productId: line.productId,
      // Deduct from line warehouse (product gudang) when set; else resolve from product master.
      warehouseKode: line.warehouseKode || gudangById.get(line.productId) || doc.warehouseKode,
      deltaQtyBase: -needQty,
      satuan: line.satuan,
      qtyEntered: needQty,
      keterangan: `Pengambilan bahan ${doc.noDokumen} — ${line.productNama || line.productKode || line.productId}`,
      // W2-6: FEFO consume ingredient lots when present (skip legacy stock without lots).
      lotPolicy: { mode: 'FEFO_CONSUME' as const },
    }));
  if (!movementLines.length) return { ok: true, fefoConsume: [] };

  const posted = await postStockMovements(db, session, {
    tenantId: doc.tenantId,
    sourceType: 'FP_ISSUE',
    sourceId: doc.id,
    noTransaksi: doc.noDokumen,
    keterangan: `Pengambilan bahan ${doc.noDokumen}`,
    postingDate,
    actor,
    lines: movementLines,
  });
  if (!posted.ok) return { error: posted.error };

  const fefoConsume: NonNullable<MaterialIssueDoc['fefoConsume']> = posted.lines.map((line) => ({
    stokId: line.productId,
    warehouseKode: line.lokasiKode,
    needQty: -line.deltaQtyBase,
    allocated: line.lot?.allocated ?? 0,
    shortfall: line.lot?.shortfall ?? -line.deltaQtyBase,
    skippedNoLots: line.lot?.skippedNoLots ?? true,
    allocations: line.lot?.allocations ?? [],
  }));
  return { ok: true, fefoConsume };
}

export async function handleMaterialIssues(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const issueBody = (body || {}) as IssueBody;

  if (route === '/material-issues' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    const tanggal = url.searchParams.get('tanggal');
    const productionPlanId = url.searchParams.get('productionPlanId');
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    if (tanggal) filter.tanggal = tanggal;
    if (productionPlanId) filter.productionPlanId = productionPlanId;
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(MATERIAL_ISSUES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => project(d as Record<string, unknown>)));
  }

  if (route === '/material-issues' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const productionPlanId = String(issueBody.productionPlanId || '').trim();
    if (!productionPlanId) return err('productionPlanId wajib');

    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    if (!ISSUE_ELIGIBLE_PLAN_STATUSES.has(plan.status)) {
      return err(`Rencana status ${plan.status} belum siap (wajib Disetujui/Diproses)`, 400);
    }

    const completedIssue = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { productionPlanId, status: 'COMPLETED' }),
      { projection: { id: 1, noDokumen: 1 } },
    );
    if (completedIssue) {
      return err(
        `Sudah ada pengambilan selesai ${String(completedIssue.noDokumen || completedIssue.id)}. Buka PBL tersebut (Sinkron) — jangan buat PBL baru.`,
        400,
      );
    }

    // Gate bisnis: idealnya bahan sudah lengkap — sumber sama dengan layar kesiapan
    // rencana (buildPlanReadiness: acuan PO/MRP bila flag rlFromPoReference, selain itu jalur lama).
    // Tapi operasional lapangan tidak selalu bisa 100% lengkap — blokir LUNAK: boleh
    // lanjut kalau admin sadar memilih override + isi alasan (tercatat di riwayat & audit).
    const readiness = await buildPlanReadiness(db, scopeAuth, plan);
    if ('error' in readiness) return err(readiness.error, 400);
    const shortageCount = readiness.summary.shortageCount;
    const overrideShortage = issueBody.overrideShortage === true;
    const overrideShortageNote = String(issueBody.overrideShortageNote || '').trim();
    if (shortageCount > 0 && (!overrideShortage || !overrideShortageNote)) {
      return err(
        `Bahan belum lengkap (${shortageCount} item kurang). Buat Draft Belanja dulu, atau proses dengan konfirmasi + alasan.`,
        400,
      );
    }
    const open = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        productionPlanId,
        status: { $in: [...ISSUE_OPEN_STATUSES] },
      }),
    );
    if (open) {
      return err(
        `Sudah ada pengambilan terbuka ${String((open as { noDokumen?: string }).noDokumen || open.id)}`,
        400,
      );
    }

    const tenantId = tenantIdForWrite(scopeAuth, issueBody);
    const referenceMode = await isPblReferenceModeEnabled(db, String(plan.tenantId || tenantId));
    let seeded: Exclude<Awaited<ReturnType<typeof seedLinesFromPlan>>, { error: string }>;
    let lines: MaterialIssueDoc['lines'];
    if (referenceMode) {
      if (issueBody.lines != null) {
        return err('PBL acuan: baris diisi otomatis dari acuan rencana (PO diterima / MRP), tidak bisa dikirim manual', 400);
      }
      const warehouseKode = await resolveWarehouse(db, scopeAuth, plan);
      if (typeof warehouseKode !== 'string') return err(warehouseKode.error, 400);
      const loaded = await loadIssueReference(db, scopeAuth, plan, { fallbackWarehouse: warehouseKode });
      if (!loaded.lines.length) return err('Rencana belum punya acuan bahan (PO diterima / MRP)', 400);
      const mrpId = loaded.reference.materialRequirementId;
      const mrp = mrpId
        ? await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: mrpId }),
          { projection: { noDokumen: 1 } },
        ) as { noDokumen?: string } | null
        : null;
      seeded = {
        lines: loaded.lines,
        warehouseKode,
        ...(mrpId ? { materialRequirementId: mrpId, materialRequirementNo: mrp?.noDokumen } : {}),
      };
      lines = loaded.lines;
    } else {
      const seededLegacy = await seedLinesFromPlan(
        db,
        scopeAuth,
        plan,
        String(issueBody.materialRequirementId || '').trim() || undefined,
      );
      if ('error' in seededLegacy) return err(seededLegacy.error, 400);
      seeded = seededLegacy;
      lines = await seedNetIssueLines(db, scopeAuth, plan.id, tenantId, seeded.lines, {
        tanggal: plan.tanggal,
        kitchenId: plan.kitchenId,
      });
      if (issueBody.lines != null) {
        const normalized = normalizeIssueLines(issueBody.lines);
        if ('error' in normalized) return err(normalized.error, 400);
        lines = normalized;
      }
    }

    if (!referenceMode) {
      const productErr = await assertIssueProductsActive(db, tenantId, lines);
      if (productErr) return err(productErr, 400);
    }
    const now = new Date();
    const actor = actorFields(auth);
    const shortageOverride = shortageCount > 0 ? {
      by: { userId: actor.userId, userName: actor.userName },
      at: now,
      reason: overrideShortageNote,
      shortageCount,
      shortageLines: readiness.lines.filter((l) => l.shortage).slice(0, 20).map((l) => ({
        productId: l.productId,
        productKode: l.productKode,
        productNama: l.productNama,
        qtyNet: l.qtyNet,
        satuan: l.satuan,
      })),
    } : undefined;
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: (shortageOverride
        ? `Dari rencana ${plan.noDokumen} — diproses meski kurang ${shortageCount} item: "${overrideShortageNote}"`
        : `Dari rencana ${plan.noDokumen}`)
        + (referenceMode ? ' · PBL acuan (tanpa mutasi stok, bahan keluar lewat RL)' : ''),
    });

    const doc: MaterialIssueDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: '',
      productionPlanId: plan.id,
      productionPlanNo: plan.noDokumen,
      materialRequirementId: seeded.materialRequirementId,
      materialRequirementNo: seeded.materialRequirementNo,
      tanggal: cookDateFromPlanTanggal(plan.tanggal),
      kitchenId: plan.kitchenId,
      kitchenNama: plan.kitchenNama,
      warehouseKode: seeded.warehouseKode,
      lines,
      status: 'DRAFT',
      history,
      summary: referenceMode ? summarizeReferenceIssueLines(lines) : summarizeIssueLines(lines),
      ...(referenceMode ? { stockMode: 'REFERENCE' as const, referenceSnapshotAt: now } : {}),
      catatan: String(issueBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
      ...(shortageOverride ? { shortageOverride } : {}),
    };

    try {
      await insertWithAudit({
        collection: MATERIAL_ISSUES_COLLECTION,
        doc,
        before: async ({ db: txDb, session }) => {
          doc.noDokumen = await nextFpDocNumber(txDb, tenantId, FP_DOC_TYPES.MATERIAL_ISSUE, session);
        },
        audit: () => ({
          tenantId,
          action: 'ISSUE_CREATE',
          entityType: 'material_issue',
          entityId: doc.id,
          summary: `Issue ${doc.noDokumen} dari ${plan.noDokumen} (${doc.summary.lineCount} item)`
            + (referenceMode ? ' · acuan' : ''),
          metadata: {
            ...(referenceMode ? { stockMode: 'REFERENCE' } : {}),
            ...(shortageOverride ? { shortageOverride: true, shortageCount, reason: overrideShortageNote } : {}),
          },
          ...auditActor(auth),
        }),
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        return err('Pengambilan untuk rencana ini sedang dibuat — muat ulang', 409);
      }
      throw e;
    }

    return ok(project(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    const lines = await enrichIssueLineWarehouses(
      db,
      scopeAuth,
      existing.lines || [],
      existing.warehouseKode,
    );
    return ok(project({ ...existing, lines } as unknown as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (!isIssueEditable(existing.status)) {
      return err(`Status ${existing.status} tidak dapat diedit`, 400);
    }
    if (isReferenceIssue(existing)) {
      if (issueBody.lines != null) {
        return err('PBL acuan: baris tidak diedit manual — gunakan Perbarui acuan. Qty keluar dicatat lewat RL.', 400);
      }
      const edited = await db.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, casEditFilter(existing)),
        {
          $set: {
            catatan: issueBody.catatan != null ? String(issueBody.catatan).trim() || undefined : existing.catatan,
            updatedAt: new Date(),
          },
        },
      );
      if (edited.matchedCount === 0) return casConflict();
      return ok(project(await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: path[1] }),
      ) as Record<string, unknown>));
    }
    const normalized = normalizeIssueLines(issueBody.lines != null ? issueBody.lines : existing.lines);
    if ('error' in normalized) return err(normalized.error, 400);
    const lines = await enrichIssueLineWarehouses(
      db,
      scopeAuth,
      normalized,
      existing.warehouseKode,
    );
    const productErr = await assertIssueProductsActive(db, existing.tenantId, lines);
    if (productErr) return err(productErr, 400);
    const now = new Date();
    const edited = await db.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, casEditFilter(existing)),
      {
        $set: {
          lines,
          summary: summarizeIssueLines(lines),
          catatan: issueBody.catatan != null
            ? String(issueBody.catatan).trim() || undefined
            : existing.catatan,
          updatedAt: now,
        },
      },
    );
    if (edited.matchedCount === 0) return casConflict();
    const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && path[2] === 'reconciliation' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (isReferenceIssue(existing)) {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: existing.productionPlanId }),
      ) as ProductionPlanDoc | null;
      if (!plan) return err('Rencana produksi tidak ditemukan', 404);
      const { reference, lines: live } = await loadIssueReference(db, scopeAuth, plan, {
        fallbackWarehouse: existing.warehouseKode,
      });
      const liveSummary = summarizeReferenceIssueLines(live);
      return ok({
        productionPlanId: existing.productionPlanId,
        issueId: existing.id,
        mode: 'REFERENCE',
        lines: [],
        summary: {
          lineCount: live.length,
          qtyPlannedTotal: liveSummary.qtyPlannedTotal,
          qtyAlreadyIssuedTotal: liveSummary.rlPostedTotal,
          qtyRemainingTotal: liveSummary.sisaTotal,
          qtyOnHandTotal: 0,
          suggestedQtyIssuedTotal: 0,
          mismatchCount: 0,
          sisaLineCount: liveSummary.sisaLineCount,
        },
        reference,
      });
    }
    const lines = await enrichIssueLineWarehouses(
      db,
      scopeAuth,
      existing.lines || [],
      existing.warehouseKode,
    );
    const [reconciliation, referenceMode] = await Promise.all([
      buildIssueReconciliation(db, scopeAuth, { ...existing, lines }),
      isTenantFeatureEnabled(db, existing.tenantId, 'rlFromPoReference'),
    ]);
    if (!referenceMode || !existing.productionPlanId) return ok(reconciliation);
    const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: existing.productionPlanId }),
    ) as ProductionPlanDoc | null;
    if (!plan) return ok(reconciliation);
    const reference = await loadPlanReference(db, scopeAuth, plan, {
      fallbackMrpLines: await planFallbackMrpLines(db, scopeAuth, plan),
    });
    return ok({ ...reconciliation, reference });
  }

  if (path[0] === 'material-issues' && path[1] && path[2] === 'reconcile' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (!isIssueReconcilable(existing.status)) {
      return err(`Status ${existing.status} tidak dapat disinkronkan`, 400);
    }

    const needsReason = existing.status === 'APPROVED' || existing.status === 'PROCESSING';
    const reason = String(issueBody.reason || issueBody.note || '').trim();
    if (needsReason && !reason) {
      return err('Alasan wajib untuk menyesuaikan PBL yang sudah disetujui', 400);
    }

    if (isReferenceIssue(existing)) {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: existing.productionPlanId }),
      ) as ProductionPlanDoc | null;
      if (!plan) return err('Rencana produksi tidak ditemukan', 404);
      const { lines: refreshed } = await loadIssueReference(db, scopeAuth, plan, {
        fallbackWarehouse: existing.warehouseKode,
      });
      if (!refreshed.length) return err('Rencana belum punya acuan bahan (PO diterima / MRP)', 400);
      const summary = summarizeReferenceIssueLines(refreshed);
      const actorRef = actorFields(auth);
      const at = new Date();
      const refreshConflict = await casUpdateWithAudit({
        collection: MATERIAL_ISSUES_COLLECTION,
        filter: withTenantFilter(scopeAuth, casEditFilter(existing)),
        update: {
          $set: {
            lines: refreshed,
            summary,
            referenceSnapshotAt: at,
            history: appendDocHistory(existing.history, {
              at,
              fromStatus: existing.status,
              toStatus: existing.status,
              userId: actorRef.userId,
              userName: actorRef.userName,
              note: `Perbarui acuan (sudah RL ${summary.rlPostedTotal}, sisa ${summary.sisaTotal})${reason ? `: ${reason}` : ''}`,
            }),
            updatedAt: at,
          },
        },
        audit: {
          tenantId: existing.tenantId,
          action: 'ISSUE_RECONCILE',
          entityType: 'material_issue',
          entityId: id,
          summary: `Issue ${existing.noDokumen} — acuan diperbarui (sisa ${summary.sisaLineCount} bahan)`,
          metadata: {
            stockMode: 'REFERENCE',
            rlPostedTotal: summary.rlPostedTotal,
            sisaTotal: summary.sisaTotal,
            sisaLineCount: summary.sisaLineCount,
            reason: reason || undefined,
          },
          ...auditActor(auth),
        },
      });
      if (refreshConflict) return refreshConflict;
      return ok(project(await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      ) as Record<string, unknown>));
    }

    const enriched = await enrichIssueLineWarehouses(
      db,
      scopeAuth,
      existing.lines || [],
      existing.warehouseKode,
    );
    const reconciliation = await buildIssueReconciliation(db, scopeAuth, {
      ...existing,
      lines: enriched,
    });
    const lines = applyReconciliationToLines(enriched, reconciliation);
    const productErr = await assertIssueProductsActive(db, existing.tenantId, lines);
    if (productErr) return err(productErr, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: existing.status,
      userId: actor.userId,
      userName: actor.userName,
      note: reason
        ? `Sinkron stok & release operasional: ${reason}`
        : `Sinkron stok & release operasional (${reconciliation.summary.suggestedQtyIssuedTotal} qty keluar)`,
    });

    const reconcileConflict = await casUpdateWithAudit({
      collection: MATERIAL_ISSUES_COLLECTION,
      filter: withTenantFilter(scopeAuth, casEditFilter(existing)),
      update: {
        $set: {
          lines,
          summary: summarizeIssueLines(lines),
          history,
          updatedAt: now,
        },
      },
      audit: {
        tenantId: existing.tenantId,
        action: 'ISSUE_RECONCILE',
        entityType: 'material_issue',
        entityId: id,
        summary: `Issue ${existing.noDokumen} disinkronkan — ${reconciliation.summary.suggestedQtyIssuedTotal} qty keluar`,
        metadata: {
          mismatchCount: reconciliation.summary.mismatchCount,
          suggestedQtyIssuedTotal: reconciliation.summary.suggestedQtyIssuedTotal,
          reason: reason || undefined,
        },
        ...auditActor(auth),
      },
    });
    if (reconcileConflict) return reconcileConflict;

    const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: issueBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(issueBody.status || '').trim() as MaterialIssueStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(project(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, ISSUE_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();

    if (toStatus === 'COMPLETED' && isReferenceIssue(existing)) {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: existing.productionPlanId }),
      ) as ProductionPlanDoc | null;
      if (!plan) return err('Rencana produksi tidak ditemukan', 404);
      const fallbackMrpLines = await planFallbackMrpLines(db, scopeAuth, plan);
      const ackNote = String(issueBody.note || issueBody.reason || '').trim();
      try {
        await runInTransactionOrFallback(async ({ db: txDb, session }) => {
          const fresh = await txDb.collection(MATERIAL_ISSUES_COLLECTION).findOne(
            withTenantFilter(scopeAuth, { id, status: existing.status, stockMode: 'REFERENCE' }),
            txOpts(session),
          ) as MaterialIssueDoc | null;
          if (!fresh) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });

          // Serialisasi dengan approve RL rencana yang sama: snapshot sisa & RL tertunda tidak boleh basi.
          await txDb.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id: plan.id }),
            { $inc: { rlPostingSeq: 1 } },
            txOpts(session),
          );

          const { lines } = await loadIssueReference(txDb, scopeAuth, plan, {
            fallbackWarehouse: fresh.warehouseKode,
            fallbackMrpLines,
            ...(session ? { session } : {}),
          });
          const summary = summarizeReferenceIssueLines(lines);
          const pendingRlCount = await txDb.collection('inventory_releases').countDocuments(
            withTenantFilter(scopeAuth, { productionPlanId: plan.id, status: { $in: [...RL_PENDING_STATUSES] } }),
            txOpts(session),
          );
          const sisaLineCount = summary.sisaLineCount || 0;
          const needsAck = sisaLineCount > 0 || pendingRlCount > 0;
          if (needsAck && ackNote.length < 5) {
            const parts = [
              sisaLineCount ? `${sisaLineCount} bahan belum keluar penuh lewat RL (${describeSisaLines(lines)})` : '',
              pendingRlCount ? `${pendingRlCount} RL belum diposting (draft/menunggu persetujuan)` : '',
            ].filter(Boolean).join('; ');
            throw Object.assign(
              new Error(`${parts}. Isi catatan konfirmasi (min. 5 karakter) untuk menyelesaikan PBL acuan.`),
              { httpStatus: 400 },
            );
          }

          const history = appendDocHistory(fresh.history, {
            at: now,
            fromStatus: fresh.status,
            toStatus: 'COMPLETED',
            userId: actor.userId,
            userName: actor.userName,
            note: needsAck
              ? `PBL acuan dikonfirmasi dengan catatan — ${ackNote}`
              : (ackNote || 'PBL acuan dikonfirmasi — tanpa mutasi stok (bahan keluar lewat RL)'),
          });
          const completed = await txDb.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id, status: fresh.status, stockMode: 'REFERENCE' }),
            {
              $set: {
                status: 'COMPLETED',
                lines,
                summary,
                referenceSnapshotAt: now,
                history,
                updatedAt: now,
                ...(needsAck ? {
                  completionAck: {
                    by: { userId: actor.userId, userName: actor.userName },
                    at: now,
                    reason: ackNote,
                    sisaLineCount,
                    pendingRlCount,
                  },
                } : {}),
              },
            },
            txOpts(session),
          );
          if (completed.matchedCount === 0) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });
          await writeAuditLog(txDb, {
            tenantId: existing.tenantId,
            action: 'ISSUE_COMPLETE',
            entityType: 'material_issue',
            entityId: id,
            summary: `Issue ${existing.noDokumen} selesai — PBL acuan, tanpa mutasi stok`
              + (needsAck ? ` · sisa ${sisaLineCount} bahan` : ''),
            metadata: {
              stockMode: 'REFERENCE',
              rlPostedTotal: summary.rlPostedTotal,
              sisaTotal: summary.sisaTotal,
              sisaLineCount,
              pendingRlCount,
              ...(needsAck ? { reason: ackNote } : {}),
            },
            ...auditActor(auth),
          }, session);
        });
      } catch (e) {
        const status = (e as { httpStatus?: number } | null)?.httpStatus;
        if (status === 400) return err(e instanceof Error ? e.message : 'Gagal selesaikan', 400);
        if (status === 409) return casConflict();
        throw e;
      }
      return ok(project(await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      ) as Record<string, unknown>));
    }

    if (toStatus === 'COMPLETED') {
      if (existing.stockPostedAt) return err('Stok sudah diposting', 400);
      const productErr = await assertIssueProductsActive(db, existing.tenantId, existing.lines);
      if (productErr) return err(productErr, 400);

      const enrichedForGate = await enrichIssueLineWarehouses(
        db,
        scopeAuth,
        existing.lines || [],
        existing.warehouseKode,
      );
      const summaryPre = summarizeIssueLines(enrichedForGate);
      const closureReason = String(
        issueBody.closureReason || issueBody.note || '',
      ).trim();
      const isClosureOnly = summaryPre.qtyIssuedTotal === 0;
      if (isClosureOnly) {
        if (issueBody.closureOnly !== true || !closureReason) {
          return err(
            'Penutupan administratif (semua qty keluar = 0) wajib closureOnly + alasan — bahan sudah keluar via RL',
            400,
          );
        }
      } else {
        const reconciliation = await buildIssueReconciliation(db, scopeAuth, {
          ...existing,
          lines: enrichedForGate,
        });
        if (reconciliation.summary.mismatchCount > 0) {
          return err(
            `${reconciliation.summary.mismatchCount} baris tidak sesuai stok/sisa — sinkron dari release operasional dulu`,
            400,
          );
        }
      }

      const locked = await guardPosting(
        db,
        scopeAuth,
        issueBody,
        postingDateFromIso(existing.tanggal),
      );
      if (locked) return locked;

      try {
        await runInTransactionOrFallback(async ({ db: txDb, session }) => {
          if (!session) {
            throw Object.assign(
              new Error('Posting stok Issue membutuhkan transaksi MongoDB (replica set)'),
              { httpStatus: 503 },
            );
          }
          const fresh = await txDb.collection(MATERIAL_ISSUES_COLLECTION).findOne(
            withTenantFilter(scopeAuth, { id, status: existing.status }),
            txOpts(session),
          ) as MaterialIssueDoc | null;
          if (!fresh) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });

          // Serialisasi dengan approve RL rencana yang sama: PBL bermutasi ikut dihitung di kontrol melebihi acuan RL.
          if (fresh.productionPlanId) {
            await txDb.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
              withTenantFilter(scopeAuth, { id: fresh.productionPlanId }),
              { $inc: { rlPostingSeq: 1 } },
              txOpts(session),
            );
          }

          // Re-check inside tx (TOCTOU): produk bisa dinonaktifkan antara precheck dan post.
          const productErrTx = await assertIssueProductsActive(txDb, fresh.tenantId, fresh.lines);
          if (productErrTx) {
            throw Object.assign(new Error(productErrTx), { httpStatus: 400 });
          }

          const posted = await postIssueStock(txDb, fresh, session, { ...actor, role: auth?.role }, now);
          if ('error' in posted) {
            throw Object.assign(new Error(posted.error), { httpStatus: 400 });
          }

          const history = appendDocHistory(fresh.history, {
            at: now,
            fromStatus: fresh.status,
            toStatus: 'COMPLETED',
            userId: actor.userId,
            userName: actor.userName,
            note: isClosureOnly
              ? `Penutupan administratif — ${closureReason}`
              : (String(issueBody.note || '').trim() || 'Stok keluar diposting · FEFO lots'),
          });
          const completed = await txDb.collection(MATERIAL_ISSUES_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id, status: fresh.status, stockPostedAt: null }),
            {
              $set: {
                status: 'COMPLETED',
                history,
                stockPostedAt: now,
                fefoConsume: posted.fefoConsume,
                updatedAt: now,
                ...(isClosureOnly ? {
                  closureOnly: {
                    by: { userId: actor.userId, userName: actor.userName },
                    at: now,
                    reason: closureReason,
                  },
                } : {}),
              },
            },
            txOpts(session),
          );
          if (completed.matchedCount === 0) throw Object.assign(new Error('Dokumen berubah'), { httpStatus: 409 });
          await writeAuditLog(txDb, {
            tenantId: existing.tenantId,
            action: 'ISSUE_COMPLETE',
            entityType: 'material_issue',
            entityId: id,
            summary: `Issue ${existing.noDokumen} selesai — stok keluar`,
            ...auditActor(auth),
          }, session);
          // Plan stays APPROVED — user clicks Diproses on Rencana Produksi after stock out.
        });
      } catch (e) {
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 400) {
          return err(e instanceof Error ? e.message : 'Gagal selesaikan', 400);
        }
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 409) {
          return casConflict();
        }
        if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 503) {
          return err(e instanceof Error ? e.message : 'Transaksi MongoDB wajib', 503);
        }
        throw e;
      }

      const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id }),
      );
      return ok(project(saved as Record<string, unknown>));
    }

    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(issueBody.note || '').trim() || undefined,
    });
    const statusConflict = await casUpdateWithAudit({
      collection: MATERIAL_ISSUES_COLLECTION,
      filter: withTenantFilter(scopeAuth, casStatusFilter(existing)),
      update: { $set: { status: toStatus, history, updatedAt: now } },
      audit: {
        tenantId: existing.tenantId,
        action: 'ISSUE_STATUS',
        entityType: 'material_issue',
        entityId: id,
        summary: `Issue ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
        ...auditActor(auth),
      },
    });
    if (statusConflict) return statusConflict;
    const saved = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    return ok(project(saved as Record<string, unknown>));
  }

  if (path[0] === 'material-issues' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(MATERIAL_ISSUES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as MaterialIssueDoc | null;
    if (!existing) return err('Pengambilan bahan tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id: path[1], status: 'CANCELLED' });
    if (existing.status === 'COMPLETED') {
      return err(
        isReferenceIssue(existing)
          ? 'PBL acuan yang sudah selesai tidak dapat dibatalkan (sudah jadi konfirmasi rencana)'
          : 'Dokumen selesai tidak dapat dibatalkan (stok sudah keluar)',
        400,
      );
    }
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED', ISSUE_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Dibatalkan',
    });
    const cancelConflict = await casUpdateWithAudit({
      collection: MATERIAL_ISSUES_COLLECTION,
      filter: withTenantFilter(scopeAuth, casStatusFilter(existing)),
      update: { $set: { status: 'CANCELLED', history, updatedAt: now } },
      audit: {
        tenantId: existing.tenantId,
        action: 'ISSUE_CANCEL',
        entityType: 'material_issue',
        entityId: path[1],
        summary: `Issue ${existing.noDokumen} dibatalkan`,
        ...auditActor(auth),
      },
    });
    if (cancelConflict) return cancelConflict;
    return ok({ id: path[1], status: 'CANCELLED' });
  }

  return null;
}
