import type { Db } from 'mongodb';
// Release inventory — pengeluaran barang operasional (creator → approver).

import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, clean } from '@/lib/api/db';
import { requireRole, RELEASE_CREATE_ROLES, RELEASE_APPROVE_ROLES } from '@/lib/api/require-auth';
import { tenantIdForWrite, withTenantFilter, findMasterDoc, resolveOperationalScope } from '@/lib/api/tenant-master';
import { stampTenantId } from '@/lib/api/tenant-operational';
import { guardPosting } from '@/lib/api/period-lock';
import { getAvailableQtyAtLokasi, postStockMovements, qtyLt } from '@/lib/stock-ledger';
import { resolveLineQtyBase } from '@/lib/uom/resolve-line-qty';
import { isValidWarehouseKode, warehouseLabel, normalizeWarehouseKode } from '@/lib/api/warehouses';
import { assertProductWarehouse } from '@/lib/api/product-warehouse';
import type { HandlerContext } from '@/types/api/handler';
import { writeAuditLog } from '@/lib/api/audit-log';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import type { AuthContext } from '@/types/auth';
import { applyWrResolutionLink, assertWrResolvable, loadWrById } from '@/lib/api/maintenance-resolve';
import { tryAutoCompleteWrFromRelease } from '@/lib/api/maintenance-wr-loop';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { consumeBatchesFefo } from '@/lib/food-production/fefo-consume';
import { isFoodSafetyHoldEnforced, isTenantFeatureEnabled } from '@/lib/api/feature-flags';
import { assertFefoExitNotBlockedByHold, assertConsumeShortfallNotDueToHold } from '@/lib/food-production/food-safety-exit-gate';
import type { FefoAllocation } from '@/lib/food-production/fefo-allocate';
import {
  PRODUCTION_PLANS_COLLECTION,
  isIsoDate,
  shiftIsoDate,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import {
  inferProductionPlanForRelease,
  isExcludedOperationalKeperluan,
  looksLikeProductionKeperluan,
} from '@/lib/food-production/material-issue-reconcile';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { casConflict, casEditFilter, casStatusFilter, CasConflictError, insertWithAudit, isCasConflict } from '@/lib/api/cas';
import { planFallbackMrpLines } from '@/lib/api/handlers/material-requirements';
import {
  computeRlOverIssue,
  rlOverIssueMissingReasonMessage,
  rlOverIssueSnapshot,
  sanitizeOverReason,
  type RlOverIssueInputLine,
  type RlOverIssueSnapshot,
} from '@/lib/food-production/rl-over-issue';
import {
  RL_LINKABLE_PLAN_STATUSES,
  RL_UNLINKED_MAX_RANGE_DAYS,
  listUnlinkedReleases,
  unlinkedReleaseFilter,
} from '@/lib/food-production/rl-unlinked';

interface ReleaseItemInput {
  stokId?: string;
  kode?: string;
  qty?: number | string;
  uomId?: string;
  satuan?: string;
  overReason?: string;
}

interface ReleaseBody extends Record<string, unknown> {
  items?: ReleaseItemInput[];
  keperluan?: string;
  lokasiKode?: string;
  lokasi?: string;
  keterangan?: string;
  submit?: boolean;
  note?: string;
  reason?: string;
  maintenanceRequestId?: string;
  assetId?: string;
  productionPlanId?: string;
}

interface ReleaseLineItem {
  stokId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  qty: number;
  qtyBase?: number;
  qtyEntered?: number;
  uomId?: string;
  hargaBeli: number;
  overReason?: string;
}

interface ReleaseUserRef {
  userId?: string;
  userName?: string;
  role?: string;
}

interface InventoryReleaseDoc extends Record<string, unknown> {
  id: string;
  tenantId?: string;
  status?: string;
  noRelease?: string;
  lokasiKode?: string;
  lokasiNama?: string;
  keperluan?: string;
  items?: ReleaseLineItem[];
  createdBy?: ReleaseUserRef;
  submittedBy?: ReleaseUserRef | null;
  lastEditedBy?: ReleaseUserRef;
  productionPlanId?: string;
  productionPlanNo?: string;
  tanggal?: Date | string;
  kitchenId?: string;
  keterangan?: string;
  planLinkDismissedAt?: Date;
}

/** Error approve/tautkan dengan status HTTP; dilempar dari dalam transaksi. */
class ReleaseRuleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function overIssueItems(items: Array<ReleaseLineItem & { qtyBase?: number }>): RlOverIssueInputLine[] {
  return items.map((it) => ({
    stokId: String(it.stokId),
    qtyBase: Number(it.qtyBase ?? it.qty) || 0,
    kode: it.kode,
    nama: it.nama,
    overReason: it.overReason,
  }));
}

/** Rencana harus satu tenant dengan RL (MASTER bisa punya scope lintas tenant). */
async function loadPlanDoc(
  db: Db,
  scopeAuth: AuthContext,
  planId: string,
  tenantId: string,
): Promise<ProductionPlanDoc | null> {
  return db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: planId, tenantId }),
  ) as Promise<ProductionPlanDoc | null>;
}

/** Pembuat, penyunting terakhir, dan pengaju RL tidak boleh menyetujui/menautkan RL yang melebihi acuan. */
function isReleaseMaker(doc: InventoryReleaseDoc, userId: string | undefined): boolean {
  if (!userId) return false;
  return [doc.createdBy, doc.lastEditedBy, doc.submittedBy].some((u) => u?.userId === userId);
}

/**
 * Cek melebihi acuan saat RL diajukan (flag `rlFromPoReference`, RL tertaut rencana).
 * Tolak bila ada baris melebihi tanpa alasan; snapshot disimpan untuk penyetuju.
 * Keputusan final tetap di approve (dalam transaksi).
 */
async function submitOverIssueCheck(
  db: Db,
  scopeAuth: AuthContext,
  tenantId: string,
  planId: string | undefined,
  items: ReleaseLineItem[],
): Promise<{ snapshot?: RlOverIssueSnapshot } | { error: string }> {
  const id = String(planId || '').trim();
  if (!id || !(await isTenantFeatureEnabled(db, tenantId, 'rlFromPoReference'))) return {};
  const plan = await loadPlanDoc(db, scopeAuth, id, tenantId);
  if (!plan) return { error: 'Rencana produksi tidak ditemukan' };
  const result = await computeRlOverIssue(db, scopeAuth, {
    plan,
    items: overIssueItems(items),
    fallbackMrpLines: await planFallbackMrpLines(db, scopeAuth, plan),
  });
  const missing = rlOverIssueMissingReasonMessage(result);
  if (missing) return { error: missing };
  return result.overCount ? { snapshot: rlOverIssueSnapshot(result, new Date()) } : {};
}

async function loadRelease(
  db: HandlerContext['db'],
  scopeAuth: AuthContext | null,
  id: string,
): Promise<InventoryReleaseDoc | null> {
  return db.collection('inventory_releases').findOne(
    withTenantFilter(scopeAuth, { id }),
  ) as Promise<InventoryReleaseDoc | null>;
}

function canEditReleaseDoc(auth: AuthContext, doc: InventoryReleaseDoc): boolean {
  if (doc.status !== 'REJECTED' && doc.status !== 'DRAFT') return false;
  if (auth.isMaster || auth.role === 'ADMIN') return true;
  return doc.createdBy?.userId === auth.userId;
}

async function buildReleaseLineItems(
  db: Db,
  scopeAuth: AuthContext,
  tenantId: string,
  lokasiKode: string,
  items: ReleaseItemInput[],
  uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>(),
): Promise<{ lineItems: ReleaseLineItem[] } | { error: string; status?: number }> {
  if (!items.length) return { error: 'Minimal 1 item', status: 400 };
  const lineItems: ReleaseLineItem[] = [];
  for (const it of items) {
    const prod = await findMasterDoc(db, 'products', scopeAuth, { id: it.stokId });
    if (!prod) return { error: `Produk tidak ditemukan: ${it.kode || it.stokId}`, status: 404 };
    const prodRow = prod as {
      id?: string;
      kode?: string;
      nama?: string;
      satuan?: string;
      hargaBeli?: number | string;
      gudangKode?: string | null;
    };
    if (!prodRow.id) return { error: `Produk tidak ditemukan: ${it.kode || it.stokId}`, status: 404 };
    const whErr = assertProductWarehouse(prodRow, lokasiKode);
    if (whErr) return { error: whErr.error, status: 400 };
    const resolved = await resolveLineQtyBase(db, tenantId, prodRow.id, {
      qty: it.qty,
      uomId: it.uomId,
      satuan: it.satuan,
    }, uomsCache);
    if ('error' in resolved) return { error: resolved.error, status: 400 };
    const qtyBase = resolved.qtyBase;
    if (qtyBase <= 0) return { error: `Qty tidak valid: ${prodRow.nama}`, status: 400 };
    const avail = await getAvailableQtyAtLokasi(db, tenantId, prodRow.id, lokasiKode);
    if (qtyLt(avail, qtyBase)) {
      return {
        error: `Stok ${prodRow.nama} di ${warehouseLabel(lokasiKode)} tidak cukup (sisa: ${avail} satuan dasar)`,
        status: 400,
      };
    }
    lineItems.push({
      stokId: prodRow.id,
      kode: String(prodRow.kode || ''),
      nama: String(prodRow.nama || ''),
      satuan: resolved.satuan || String(prodRow.satuan || ''),
      qty: resolved.qty,
      qtyBase,
      qtyEntered: resolved.qty,
      uomId: resolved.uomId,
      hargaBeli: parseInt(String(prodRow.hargaBeli || 0), 10),
      ...(sanitizeOverReason(it.overReason) ? { overReason: sanitizeOverReason(it.overReason) } : {}),
    });
  }
  return { lineItems };
}

async function resolveReleaseProductionPlan(
  db: Db,
  scopeAuth: AuthContext,
  url: HandlerContext['url'],
  request: HandlerContext['request'],
  opts: {
    keperluan: string;
    productIds: string[];
    productQtyById?: Record<string, number>;
    explicitPlanId?: string;
    releaseDate?: Date;
  },
): Promise<
  | { productionPlanId?: string; productionPlanNo?: string; autoLinked?: boolean }
  | { error: string }
> {
  const kitchenId = resolveKitchenIdFilter(url, request);
  const infer = await inferProductionPlanForRelease(db, scopeAuth, {
    keperluan: opts.keperluan,
    productIds: opts.productIds,
    productQtyById: opts.productQtyById,
    releaseDate: opts.releaseDate,
    kitchenId,
    explicitPlanId: opts.explicitPlanId,
  });

  if (infer && 'autoLinked' in infer) {
    return {
      productionPlanId: infer.productionPlanId,
      productionPlanNo: infer.productionPlanNo,
      autoLinked: true,
    };
  }
  if (infer && 'ambiguous' in infer) {
    const list = infer.ambiguous.map((m) => m.productionPlanNo).join(', ');
    return {
      error: `Barang cocok beberapa rencana produksi (${list}). Pilih Rencana Produksi.`,
    };
  }
  if (infer && 'planAlreadyCompleted' in infer) {
    const list = infer.planAlreadyCompleted.map((m) => m.productionPlanNo).join(', ');
    return {
      error: `Rencana ${list} sudah selesai — bahan sudah tercatat. Jangan release operasional duplikat; cek PBL/RL yang ada.`,
    };
  }
  if (infer && 'requiresPlan' in infer) {
    return {
      error: 'Keperluan terlihat untuk produksi — pilih Rencana Produksi atau gunakan Mode Produksi (PBL).',
    };
  }

  const explicit = String(opts.explicitPlanId || '').trim();
  if (!explicit) return {};
  return resolveProductionPlanLink(db, scopeAuth, explicit);
}

async function resolveProductionPlanLink(
  db: Db,
  scopeAuth: AuthContext,
  productionPlanId?: string,
): Promise<{ productionPlanId?: string; productionPlanNo?: string } | { error: string }> {
  const planId = String(productionPlanId || '').trim();
  if (!planId) return {};
  const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { id: planId }),
    { projection: { id: 1, noDokumen: 1, status: 1 } },
  ) as { id?: string; noDokumen?: string; status?: string } | null;
  if (!plan) return { error: 'Rencana produksi tidak ditemukan' };
  if (!ISSUE_ELIGIBLE_PLAN_STATUSES.has(String(plan.status || ''))) {
    return { error: `Rencana ${plan.noDokumen || planId} belum siap (wajib Disetujui/Diproses)` };
  }
  return {
    productionPlanId: String(plan.id),
    productionPlanNo: String(plan.noDokumen || ''),
  };
}

export async function handleInventoryReleases({
  db,
  route,
  method,
  path,
  body,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  const releaseBody = (body || {}) as ReleaseBody;

  if (route === '/inventory-releases' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const list = await db.collection('inventory_releases')
      .find(withTenantFilter(scopeAuth, {}))
      .sort({ tanggal: -1 })
      .limit(300)
      .toArray();
    return ok(list.map(clean));
  }

  if (route === '/inventory-releases/unlinked' && method === 'GET') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Unauthorized', 401);
    const tenantId = tenantIdForWrite(scopeAuth, { tenantId: url.searchParams.get('tenantId') || undefined });
    if (!(await isTenantFeatureEnabled(db, tenantId, 'rlFromPoReference'))) {
      return err('Fitur RL dari acuan PO belum aktif untuk tenant ini', 403);
    }
    const todayWib = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const to = url.searchParams.get('to') || todayWib;
    const from = url.searchParams.get('from') || shiftIsoDate(to, -30);
    if (!isIsoDate(from) || !isIsoDate(to)) return err('Format tanggal wajib YYYY-MM-DD', 400);
    const rangeDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (rangeDays < 0) return err('Tanggal awal melebihi tanggal akhir', 400);
    if (rangeDays > RL_UNLINKED_MAX_RANGE_DAYS) {
      return err(`Rentang maksimal ${RL_UNLINKED_MAX_RANGE_DAYS} hari`, 400);
    }
    const rows = await listUnlinkedReleases(db, scopeAuth, {
      from,
      to,
      kitchenId: resolveKitchenIdFilter(url, request),
    });
    return ok({ from, to, rows });
  }

  if (route === '/inventory-releases/over-issue-preview' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Unauthorized', 401);
    const tenantId = tenantIdForWrite(scopeAuth, releaseBody);
    const planId = String(releaseBody.productionPlanId || '').trim();
    const empty = { enabled: false, overCount: 0, missingReasonCount: 0, lines: [] };
    if (!planId) return ok(empty);
    if (!(await isTenantFeatureEnabled(db, tenantId, 'rlFromPoReference'))) return ok(empty);
    const lokasiKode = normalizeWarehouseKode(releaseBody.lokasiKode || releaseBody.lokasi);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);
    const built = await buildReleaseLineItems(db, scopeAuth, tenantId, lokasiKode, releaseBody.items || []);
    if ('error' in built) return err(built.error, built.status || 400);
    const plan = await loadPlanDoc(db, scopeAuth, planId, tenantId);
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    const result = await computeRlOverIssue(db, scopeAuth, {
      plan,
      items: overIssueItems(built.lineItems),
      fallbackMrpLines: await planFallbackMrpLines(db, scopeAuth, plan),
    });
    return ok({ enabled: true, ...result });
  }

  if (path[0] === 'inventory-releases' && path.length === 3
    && (path[2] === 'link-plan' || path[2] === 'dismiss-link') && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth || !scopeAuth) return err('Unauthorized', 401);
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    const tenantId = String(doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody));
    if (!(await isTenantFeatureEnabled(db, tenantId, 'rlFromPoReference'))) {
      return err('Fitur RL dari acuan PO belum aktif untuk tenant ini', 403);
    }
    if (doc.status !== 'POSTED') return err('Hanya release yang sudah diposting yang bisa ditautkan', 400);
    if (String(doc.productionPlanId || '').trim()) {
      return err(`Release sudah tertaut ke ${doc.productionPlanNo || doc.productionPlanId}`, 400);
    }
    if (doc.planLinkDismissedAt) return err('Release sudah ditandai bukan untuk produksi', 400);
    const reason = sanitizeOverReason(releaseBody.reason);
    if (reason.length < 5) return err('Alasan wajib diisi (minimal 5 karakter)', 400);
    const locked = await guardPosting(db, scopeAuth, releaseBody, String(doc.tanggal || doc.createdAt || ''));
    if (locked) return locked;
    const actor = { userId: auth.userId, userName: auth.name || auth.email, role: auth.role };
    const now = new Date();

    if (path[2] === 'dismiss-link') {
      try {
        await runInTransactionOrFallback(async ({ db: txDb, session }) => {
          const res = await txDb.collection('inventory_releases').updateOne(
            withTenantFilter(scopeAuth, unlinkedReleaseFilter({ id: doc.id })),
            {
              $set: {
                planLinkDismissedAt: now,
                planLinkDismissedBy: actor,
                planLinkDismissReason: reason,
                updatedAt: now,
              },
            },
            txOpts(session),
          );
          if (res.matchedCount === 0) throw new CasConflictError();
          await writeAuditLog(txDb, {
            tenantId,
            action: 'INVENTORY_RELEASE_LINK_DISMISS',
            entityType: 'inventory_release',
            entityId: String(doc.id),
            summary: `Release ${doc.noRelease} ditandai bukan untuk produksi`,
            userId: auth.userId,
            userName: auth.name || auth.email || 'System',
            metadata: { noRelease: doc.noRelease, reason },
          }, session);
        });
      } catch (e) {
        if (isCasConflict(e)) return casConflict(e.message);
        throw e;
      }
      return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
    }

    const planId = String(releaseBody.productionPlanId || '').trim();
    if (!planId) return err('Pilih Rencana Produksi', 400);
    const plan = await loadPlanDoc(db, scopeAuth, planId, tenantId);
    if (!plan) return err('Rencana produksi tidak ditemukan', 404);
    const planNo = String(plan.noDokumen || plan.id);
    const linkable = new Set<string>(RL_LINKABLE_PLAN_STATUSES);
    if (!linkable.has(String(plan.status || ''))) {
      return err(`Rencana ${planNo} berstatus ${plan.status} — hanya Disetujui/Diproses/Selesai yang bisa ditautkan`, 400);
    }
    const rlKitchen = String(doc.kitchenId || '').trim();
    const planKitchen = String(plan.kitchenId || '').trim();
    if (rlKitchen && planKitchen && rlKitchen !== planKitchen) {
      return err(`Rencana ${planNo} milik dapur lain — pilih rencana dari dapur release ini`, 400);
    }
    const fallbackMrp = await planFallbackMrpLines(db, scopeAuth, plan);
    const items = overIssueItems((doc.items || []).map((it) => ({ ...it, overReason: reason })));
    let snapshot: RlOverIssueSnapshot | undefined;
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        snapshot = undefined;
        const lock = await txDb.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
          withTenantFilter(scopeAuth, { id: planId, tenantId, status: { $in: [...RL_LINKABLE_PLAN_STATUSES] } }),
          { $inc: { rlPostingSeq: 1 } },
          txOpts(session),
        );
        if (lock.matchedCount === 0) throw new ReleaseRuleError(`Status rencana ${planNo} berubah — muat ulang`);
        const over = await computeRlOverIssue(txDb, scopeAuth, {
          plan,
          items,
          fallbackMrpLines: fallbackMrp,
          session,
        });
        if (over.overCount && isReleaseMaker(doc, auth.userId)) {
          throw new ReleaseRuleError(
            'Penautan membuat rencana melebihi acuan — wajib dilakukan pengguna lain, bukan pembuat/pengaju release.',
            403,
          );
        }
        if (over.overCount) snapshot = rlOverIssueSnapshot(over, now);
        const res = await txDb.collection('inventory_releases').updateOne(
          withTenantFilter(scopeAuth, unlinkedReleaseFilter({ id: doc.id })),
          {
            $set: {
              productionPlanId: planId,
              productionPlanNo: planNo,
              planLink: { source: 'MANUAL', reason, linkedBy: actor, linkedAt: now },
              ...(snapshot ? { overIssue: snapshot } : {}),
              updatedAt: now,
            },
          },
          txOpts(session),
        );
        if (res.matchedCount === 0) throw new CasConflictError();
        await writeAuditLog(txDb, {
          tenantId,
          action: 'INVENTORY_RELEASE_LINK_PLAN',
          entityType: 'inventory_release',
          entityId: String(doc.id),
          summary: `Release ${doc.noRelease} ditautkan ke ${planNo}`
            + (snapshot ? ` · melebihi acuan ${snapshot.lines.length} produk` : ''),
          userId: auth.userId,
          userName: auth.name || auth.email || 'System',
          metadata: {
            noRelease: doc.noRelease,
            productionPlanId: planId,
            productionPlanNo: planNo,
            planStatus: plan.status,
            reason,
            ...(snapshot ? { overIssue: snapshot } : {}),
          },
        }, session);
      });
    } catch (e) {
      if (isCasConflict(e)) return casConflict(e.message);
      if (e instanceof ReleaseRuleError) return err(e.message, e.status);
      throw e;
    }
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    return ok(clean(doc));
  }

  if (route === '/inventory-releases' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth || !scopeAuth) return err('Unauthorized', 401);
    const items = releaseBody.items || [];
    if (!items.length) return err('Minimal 1 item');
    if (!releaseBody.keperluan?.trim()) return err('Keperluan operasional wajib diisi');
    const keperluan = String(releaseBody.keperluan).trim();
    const tenantId = tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = normalizeWarehouseKode(releaseBody.lokasiKode || releaseBody.lokasi);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);

    const built = await buildReleaseLineItems(db, scopeAuth, tenantId, lokasiKode, items);
    if ('error' in built) return err(built.error, built.status || 400);
    const lineItems = built.lineItems;

    const productIds = lineItems.map((it) => String(it.stokId || '').trim()).filter(Boolean);
    const productQtyById: Record<string, number> = {};
    for (const it of lineItems) {
      const pid = String(it.stokId || '').trim();
      if (!pid) continue;
      productQtyById[pid] = (productQtyById[pid] || 0) + (Number(it.qtyBase ?? it.qty) || 0);
    }
    const now = new Date();
    const kitchenId = resolveKitchenIdFilter(url, request);
    const planResolved = await resolveReleaseProductionPlan(db, scopeAuth, url, request, {
      keperluan,
      productIds,
      productQtyById,
      explicitPlanId: String(releaseBody.productionPlanId || '').trim() || undefined,
      releaseDate: now,
    });
    if ('error' in planResolved) return err(planResolved.error, 400);

    const submitNow = releaseBody.submit === true;
    let overIssue: RlOverIssueSnapshot | undefined;
    if (submitNow) {
      const over = await submitOverIssueCheck(db, scopeAuth, tenantId, planResolved.productionPlanId, lineItems);
      if ('error' in over) return err(over.error, 400);
      overIssue = over.snapshot;
    }
    const doc = stampTenantId(tenantId, {
      id: uuidv4(),
      noRelease: '',
      status: submitNow ? 'PENDING_APPROVAL' : 'DRAFT',
      tanggal: now,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      ...(kitchenId ? { kitchenId } : {}),
      keperluan: String(releaseBody.keperluan).trim(),
      keterangan: [
        releaseBody.keterangan || '',
        planResolved.autoLinked
          ? `[auto-link ${planResolved.productionPlanNo}]`
          : '',
      ].filter(Boolean).join(' ').trim(),
      maintenanceRequestId: releaseBody.maintenanceRequestId || null,
      assetId: releaseBody.assetId || null,
      ...(planResolved.productionPlanId ? {
        productionPlanId: planResolved.productionPlanId,
        productionPlanNo: planResolved.productionPlanNo,
      } : {}),
      items: lineItems,
      ...(overIssue ? { overIssue } : {}),
      createdBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
      submittedAt: submitNow ? now : null,
      ...(submitNow ? { submittedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role } } : {}),
      createdAt: now,
    });
    await insertWithAudit({
      collection: 'inventory_releases',
      doc,
      before: async ({ db: txDb, session }) => {
        doc.noRelease = await nextDocNumber(txDb, tenantId, 'RL', 'RL', session);
      },
      audit: () => ({
        tenantId,
        action: 'INVENTORY_RELEASE_CREATE',
        entityType: 'inventory_release',
        entityId: String(doc.id),
        summary: `Release ${doc.noRelease} dibuat (${doc.status})`,
        userId: auth.userId,
        userName: auth.name || auth.email || 'System',
        metadata: { noRelease: doc.noRelease, lokasiKode, itemCount: lineItems.length },
      }),
    });

    if (releaseBody.maintenanceRequestId) {
      const wr = await loadWrById(db, scopeAuth, String(releaseBody.maintenanceRequestId));
      const block = assertWrResolvable(wr, 'INTERNAL');
      if (!block && wr && !wr.linkedReleaseId) {
        await applyWrResolutionLink(db, wr, {
          resolutionType: 'INTERNAL',
          linkedReleaseId: doc.id,
          linkedReleaseNo: doc.noRelease,
        });
      }
    }

    return ok(clean(doc));
  }

  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'PATCH') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth || !scopeAuth) return err('Unauthorized', 401);

    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (!canEditReleaseDoc(auth, doc)) {
      return err('Release tidak bisa diedit pada status ini', 403);
    }

    const items = releaseBody.items || [];
    if (!items.length) return err('Minimal 1 item');
    if (!releaseBody.keperluan?.trim()) return err('Keperluan operasional wajib diisi');
    const keperluan = String(releaseBody.keperluan).trim();
    const tenantId = doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = normalizeWarehouseKode(releaseBody.lokasiKode || releaseBody.lokasi || doc.lokasiKode);
    if (!isValidWarehouseKode(lokasiKode)) return err('Pilih gudang: GKERING, GBASAH, atau GJANITOR', 400);

    const built = await buildReleaseLineItems(db, scopeAuth, tenantId, lokasiKode, items);
    if ('error' in built) return err(built.error, built.status || 400);

    const productIds = built.lineItems.map((it) => String(it.stokId || '').trim()).filter(Boolean);
    const productQtyById: Record<string, number> = {};
    for (const it of built.lineItems) {
      const pid = String(it.stokId || '').trim();
      if (!pid) continue;
      productQtyById[pid] = (productQtyById[pid] || 0) + (Number(it.qtyBase ?? it.qty) || 0);
    }
    const explicitPlanId = releaseBody.productionPlanId !== undefined
      ? String(releaseBody.productionPlanId || '').trim()
      : String(doc.productionPlanId || '').trim();
    const planResolved = await resolveReleaseProductionPlan(db, scopeAuth, url, request, {
      keperluan,
      productIds,
      productQtyById,
      explicitPlanId: explicitPlanId || undefined,
      releaseDate: doc.tanggal ? new Date(String(doc.tanggal)) : new Date(),
    });
    if ('error' in planResolved) return err(planResolved.error, 400);

    const submitNow = releaseBody.submit === true;
    let overIssue: RlOverIssueSnapshot | undefined;
    if (submitNow) {
      const locked = await guardPosting(db, scopeAuth, releaseBody, String(doc.tanggal || doc.createdAt || ''));
      if (locked) return locked;
      const linkedPlanId = releaseBody.productionPlanId !== undefined || planResolved.productionPlanId
        ? planResolved.productionPlanId
        : doc.productionPlanId;
      const over = await submitOverIssueCheck(db, scopeAuth, tenantId, linkedPlanId, built.lineItems);
      if ('error' in over) return err(over.error, 400);
      overIssue = over.snapshot;
    }

    const now = new Date();
    const nextStatus = submitNow ? 'PENDING_APPROVAL' : 'DRAFT';
    const wrId = String(releaseBody.maintenanceRequestId || '').trim() || doc.maintenanceRequestId || null;
    const assetId = String(releaseBody.assetId || '').trim() || doc.assetId || null;
    const patch: Record<string, unknown> = {
      status: nextStatus,
      lokasiKode,
      lokasiNama: warehouseLabel(lokasiKode),
      keperluan: String(releaseBody.keperluan).trim(),
      keterangan: releaseBody.keterangan || '',
      maintenanceRequestId: wrId,
      assetId,
      items: built.lineItems,
      submittedAt: submitNow ? now : null,
      submittedBy: submitNow ? { userId: auth.userId, userName: auth.name || auth.email, role: auth.role } : null,
      lastEditedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
      updatedAt: now,
    };

    if (releaseBody.productionPlanId !== undefined || planResolved.productionPlanId) {
      if (planResolved.productionPlanId) {
        patch.productionPlanId = planResolved.productionPlanId;
        patch.productionPlanNo = planResolved.productionPlanNo;
      } else if (releaseBody.productionPlanId !== undefined) {
        patch.productionPlanId = null;
        patch.productionPlanNo = null;
      }
    }

    const unset: Record<string, string> = {};
    if (doc.status === 'REJECTED') {
      unset.rejectedBy = '';
      unset.rejectedAt = '';
      unset.rejectReason = '';
    }
    if (overIssue) patch.overIssue = overIssue;
    else unset.overIssue = '';

    const edited = await db.collection('inventory_releases').updateOne(
      casEditFilter(doc),
      {
        $set: patch,
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
    );
    if (edited.matchedCount === 0) return casConflict();
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path[2] === 'submit' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth) return err('Unauthorized', 401);
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa diajukan', 400);
    const locked = await guardPosting(db, scopeAuth, releaseBody, String(doc.tanggal || doc.createdAt || ''));
    if (locked) return locked;
    if (doc.createdBy?.userId !== auth.userId && !auth.isMaster && auth.role !== 'ADMIN') {
      return err('Hanya pembuat yang bisa mengajukan', 403);
    }
    if (looksLikeProductionKeperluan(String(doc.keperluan || '')) && !String(doc.productionPlanId || '').trim()) {
      return err(
        'Release bahan produksi tanpa Rencana Produksi — pilih RPN dulu sebelum ajukan.',
        400,
      );
    }
    if (!scopeAuth) return err('Unauthorized', 401);
    const over = await submitOverIssueCheck(
      db,
      scopeAuth,
      String(doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody)),
      doc.productionPlanId,
      doc.items || [],
    );
    if ('error' in over) return err(over.error, 400);
    const now = new Date();
    const submitted = await db.collection('inventory_releases').updateOne(
      casStatusFilter(doc, 'DRAFT'),
      {
        $set: {
          status: 'PENDING_APPROVAL',
          submittedAt: now,
          submittedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
          updatedAt: now,
          ...(over.snapshot ? { overIssue: over.snapshot } : {}),
        },
        ...(over.snapshot ? {} : { $unset: { overIssue: '' } }),
      },
    );
    if (submitted.matchedCount === 0) return casConflict();
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path[2] === 'approve' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth || !scopeAuth) return err('Unauthorized', 401);
    const locked = await guardPosting(db, scopeAuth, releaseBody);
    if (locked) return locked;

    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);
    if (doc.createdBy?.userId === auth.userId && !auth.isMaster && auth.role !== 'ADMIN') {
      return err('Tidak bisa menyetujui permintaan sendiri', 403);
    }
    if (looksLikeProductionKeperluan(String(doc.keperluan || '')) && !String(doc.productionPlanId || '').trim()) {
      return err(
        'Release bahan produksi tanpa Rencana Produksi — edit draft & pilih RPN dulu, atau batalkan.',
        400,
      );
    }

    const tenantId = doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody);
    const lokasiKode = doc.lokasiKode;
    if (!lokasiKode) return err('Gudang tidak valid', 400);
    const now = new Date();

    const uomsCache = new Map<string, import('@/lib/uom/types').ProductUom[]>();
    const releaseLines: Array<ReleaseLineItem & { qtyBase: number }> = [];
    for (const it of doc.items || []) {
      if (it.qtyBase != null && it.qtyBase > 0) {
        releaseLines.push({ ...it, qtyBase: it.qtyBase });
        continue;
      }
      const resolved = await resolveLineQtyBase(db, tenantId, String(it.stokId), {
        qty: it.qty,
        uomId: (it as { uomId?: string }).uomId,
        satuan: (it as { satuan?: string }).satuan,
      }, uomsCache);
      if ('error' in resolved) return err(resolved.error, 400);
      releaseLines.push({ ...it, qtyBase: resolved.qtyBase, qty: resolved.qty, uomId: resolved.uomId, satuan: resolved.satuan });
    }
    // ADR-004 — resolve sekali per dokumen, bukan per baris FEFO.
    const enforceFoodSafetyHold = await isFoodSafetyHoldEnforced(db, tenantId);
    const holdGate = await assertFefoExitNotBlockedByHold(db, {
      tenantId,
      enforce: enforceFoodSafetyHold,
      asOf: now,
      context: 'release',
      lines: releaseLines.map((it) => ({
        stokId: String(it.stokId),
        stokNama: it.nama,
        warehouseKode: lokasiKode,
        needQty: it.qtyBase,
      })),
    });
    if (!holdGate.ok) return err(holdGate.error, 400);

    // Fase 1.3 (flag rlFromPoReference): tautan rencana divalidasi ulang, lalu kontrol melebihi acuan.
    const referenceMode = await isTenantFeatureEnabled(db, tenantId, 'rlFromPoReference');
    let planId = String(doc.productionPlanId || '').trim();
    let planNo = String(doc.productionPlanNo || '');
    let autoLinkedAtApprove = false;
    let planForCheck: ProductionPlanDoc | null = null;
    let fallbackMrp: Awaited<ReturnType<typeof planFallbackMrpLines>> = [];
    if (referenceMode) {
      if (!planId && !isExcludedOperationalKeperluan(String(doc.keperluan || ''))) {
        const productQtyById: Record<string, number> = {};
        for (const it of releaseLines) {
          productQtyById[String(it.stokId)] = (productQtyById[String(it.stokId)] || 0) + it.qtyBase;
        }
        const infer = await inferProductionPlanForRelease(db, scopeAuth, {
          keperluan: String(doc.keperluan || ''),
          productIds: Object.keys(productQtyById),
          productQtyById,
          releaseDate: doc.tanggal ? new Date(String(doc.tanggal)) : now,
          kitchenId: doc.kitchenId,
        });
        if (infer && 'autoLinked' in infer) {
          planId = infer.productionPlanId;
          planNo = infer.productionPlanNo;
          autoLinkedAtApprove = true;
        } else if (infer && 'ambiguous' in infer) {
          const list = infer.ambiguous.map((m) => m.productionPlanNo).join(', ');
          return err(`Barang cocok beberapa rencana produksi (${list}) — edit release dan pilih satu Rencana Produksi.`, 400);
        } else if (infer && 'planAlreadyCompleted' in infer) {
          const list = infer.planAlreadyCompleted.map((m) => m.productionPlanNo).join(', ');
          return err(`Rencana ${list} sudah selesai — tolak release ini atau pilih rencana yang masih berjalan.`, 400);
        } else if (infer && 'requiresPlan' in infer) {
          return err('Keperluan terlihat untuk produksi — edit release dan pilih Rencana Produksi.', 400);
        }
      }
      if (planId) {
        planForCheck = await loadPlanDoc(db, scopeAuth, planId, tenantId);
        if (!planForCheck) return err('Rencana produksi tertaut tidak ditemukan', 400);
        planNo = String(planForCheck.noDokumen || planNo || planId);
        if (!ISSUE_ELIGIBLE_PLAN_STATUSES.has(String(planForCheck.status || ''))) {
          return err(`Rencana ${planNo} tidak berstatus Disetujui/Diproses — release tidak bisa disetujui`, 400);
        }
        const rlKitchen = String(doc.kitchenId || '').trim();
        const planKitchen = String(planForCheck.kitchenId || '').trim();
        if (rlKitchen && planKitchen && rlKitchen !== planKitchen) {
          return err(`Rencana ${planNo} milik dapur lain — edit release dan pilih rencana dapur ini`, 400);
        }
        fallbackMrp = await planFallbackMrpLines(db, scopeAuth, planForCheck);
      }
    }

    let overSnapshot: RlOverIssueSnapshot | undefined;
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        overSnapshot = undefined;
        if (planForCheck) {
          // Operasi pertama transaksi: approve RL lain untuk rencana yang sama bentrok di sini dan diulang,
          // sehingga total RL POSTED selalu dihitung dari data terbaru.
          const lock = await txDb.collection(PRODUCTION_PLANS_COLLECTION).updateOne(
            withTenantFilter(scopeAuth, { id: planId, tenantId, status: { $in: [...ISSUE_ELIGIBLE_PLAN_STATUSES] } }),
            { $inc: { rlPostingSeq: 1 } },
            txOpts(session),
          );
          if (lock.matchedCount === 0) {
            throw new ReleaseRuleError(`Rencana ${planNo} tidak berstatus Disetujui/Diproses — release tidak bisa disetujui`);
          }
          const over = await computeRlOverIssue(txDb, scopeAuth, {
            plan: planForCheck,
            items: overIssueItems(releaseLines),
            fallbackMrpLines: fallbackMrp,
            session,
          });
          const missing = rlOverIssueMissingReasonMessage(over);
          if (missing) throw new ReleaseRuleError(`${missing}. Tolak agar pembuat mengisi alasan.`);
          if (over.overCount && isReleaseMaker(doc, auth.userId)) {
            throw new ReleaseRuleError('Release melebihi acuan rencana wajib disetujui pengguna lain, bukan pembuat/pengaju/penyuntingnya.', 403);
          }
          if (over.overCount) overSnapshot = rlOverIssueSnapshot(over, now);
        }

        const claim = await txDb.collection('inventory_releases').updateOne(
          { id: doc.id, status: 'PENDING_APPROVAL' },
          {
            $set: {
              status: 'POSTED',
              approvedBy: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
              approvedAt: now,
              postedAt: now,
              approveNote: releaseBody.note || '',
              ...(autoLinkedAtApprove ? {
                productionPlanId: planId,
                productionPlanNo: planNo,
                keterangan: [doc.keterangan || '', `[auto-link approve ${planNo}]`].filter(Boolean).join(' ').trim(),
              } : {}),
              ...(overSnapshot ? { overIssue: overSnapshot } : {}),
            },
            ...(planForCheck && !overSnapshot ? { $unset: { overIssue: '' } } : {}),
          },
          session ? { session } : {},
        );
        if (claim.modifiedCount === 0) throw new CasConflictError('Release sudah diproses oleh approver lain');

        const fefoLines: Array<{
          stokId: string;
          allocated: number;
          shortfall: number;
          skippedNoBatches: boolean;
          allocations: FefoAllocation[];
        }> = [];
        const ingredientLotLines: Array<{
          stokId: string;
          warehouseKode: string;
          needQty: number;
          allocated: number;
          shortfall: number;
          skippedNoLots: boolean;
          allocations: FefoAllocation[];
        }> = [];

        const kartuAllocations = new Map<number, Record<string, unknown>>();
        for (const [idx, it] of releaseLines.entries()) {
          // W2-1: FEFO consume production batches when present for this FG+warehouse.
          const fefo = await consumeBatchesFefo(
            txDb,
            {
              tenantId,
              stokId: it.stokId,
              warehouseKode: lokasiKode,
              needQty: it.qtyBase,
              asOf: now,
              releaseId: doc.id,
              noRelease: doc.noRelease,
              enforceFoodSafetyHold,
            },
            session,
          );
          if (enforceFoodSafetyHold) {
            const post = await assertConsumeShortfallNotDueToHold(
              txDb,
              {
                tenantId,
                enforce: true,
                shortfall: fefo.shortfall,
                skippedNoBatches: fefo.skippedNoBatches,
                asOf: now,
                context: 'release',
                line: {
                  stokId: String(it.stokId),
                  stokNama: it.nama,
                  warehouseKode: lokasiKode,
                  needQty: it.qtyBase,
                },
              },
              session,
            );
            if (!post.ok) throw new Error(post.error);
          }
          fefoLines.push({
            stokId: it.stokId,
            allocated: fefo.allocated,
            shortfall: fefo.shortfall,
            skippedNoBatches: fefo.skippedNoBatches,
            allocations: fefo.allocations,
          });

          kartuAllocations.set(idx, { fefoAllocations: fefo.allocations });
        }

        const posted = await postStockMovements(txDb, session, {
          tenantId,
          sourceType: 'RELEASE',
          sourceId: String(doc.id),
          noTransaksi: String(doc.noRelease),
          keterangan: `Release operasional: ${doc.keperluan}`,
          postingDate: now,
          actor: { userId: auth.userId, userName: auth.name || auth.email, role: auth.role },
          lines: releaseLines.map((it, idx) => ({
            lineRef: `${idx + 1}:${it.stokId}`,
            productId: String(it.stokId),
            warehouseKode: lokasiKode,
            deltaQtyBase: -it.qtyBase,
            unitCost: Number(it.hargaBeli) > 0 ? Number(it.hargaBeli) : undefined,
            qtyEntered: Number(it.qty) || undefined,
            uomId: it.uomId,
            satuan: it.satuan,
            lokasiLabel: `${lokasiKode} - ${doc.lokasiNama}`,
            kartuExtra: kartuAllocations.get(idx),
            // W2-6: lot bahan ikut FEFO agar SOH Panduan Release tetap sinkron.
            lotPolicy: { mode: 'FEFO_CONSUME' as const },
          })),
        });
        if (!posted.ok) throw new Error(posted.error);
        for (const line of posted.lines) {
          ingredientLotLines.push({
            stokId: line.productId,
            warehouseKode: line.lokasiKode,
            needQty: -line.deltaQtyBase,
            allocated: line.lot?.allocated ?? 0,
            shortfall: line.lot?.shortfall ?? -line.deltaQtyBase,
            skippedNoLots: line.lot?.skippedNoLots ?? true,
            allocations: line.lot?.allocations ?? [],
          });
        }

        await txDb.collection('inventory_releases').updateOne(
          { id: doc.id },
          {
            $set: {
              fefoConsume: fefoLines,
              ingredientLotConsume: ingredientLotLines,
              updatedAt: now,
            },
          },
          session ? { session } : {},
        );

        await writeAuditLog(txDb, {
          tenantId,
          action: 'INVENTORY_RELEASE',
          entityType: 'inventory_release',
          entityId: String(doc.id),
          summary: `Release ${doc.noRelease} disetujui`
            + (overSnapshot ? ` · melebihi acuan ${overSnapshot.lines.length} produk` : ''),
          userId: auth.userId,
          userName: auth.name || auth.email || 'System',
          metadata: {
            noRelease: doc.noRelease,
            lokasiKode,
            itemCount: (doc.items || []).length,
            ...(planId ? { productionPlanId: planId, productionPlanNo: planNo } : {}),
            ...(autoLinkedAtApprove ? { autoLinkedAtApprove: true } : {}),
            ...(overSnapshot ? { overIssue: overSnapshot } : {}),
          },
        }, session);
      });
    } catch (e) {
      if (isCasConflict(e)) return casConflict(e.message);
      if (e instanceof ReleaseRuleError) return err(e.message, e.status);
      const msg = e instanceof Error ? e.message : 'Gagal approve release';
      return err(msg, 400);
    }
    const posted = await loadRelease(db, scopeAuth, doc.id);
    const wrLoop = await tryAutoCompleteWrFromRelease(db, posted || doc);
    return ok(clean({ ...(posted || doc), wrLoop }));
  }

  if (path[0] === 'inventory-releases' && path[2] === 'reject' && method === 'POST') {
    const deniedRole = requireRole(auth, RELEASE_APPROVE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth) return err('Unauthorized', 401);
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'PENDING_APPROVAL') return err('Status harus PENDING_APPROVAL', 400);
    const now = new Date();
    const rejected = await db.collection('inventory_releases').updateOne(
      casStatusFilter(doc, 'PENDING_APPROVAL'),
      {
        $set: {
          status: 'REJECTED',
          rejectedBy: { userId: auth.userId, userName: auth.name || auth.email },
          rejectedAt: now,
          rejectReason: releaseBody.reason || 'Ditolak',
          updatedAt: now,
        },
      },
    );
    if (rejected.matchedCount === 0) return casConflict();
    return ok(clean(await loadRelease(db, scopeAuth, doc.id)));
  }

  if (path[0] === 'inventory-releases' && path.length === 2 && method === 'DELETE') {
    const deniedRole = requireRole(auth, RELEASE_CREATE_ROLES);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: releaseBody, request });
    if (denied) return denied;
    if (!auth || !scopeAuth) return err('Unauthorized', 401);
    const doc = await loadRelease(db, scopeAuth, path[1]);
    if (!doc) return err('Tidak ditemukan', 404);
    if (doc.status !== 'DRAFT') return err('Hanya draft yang bisa dihapus', 400);
    if (!canEditReleaseDoc(auth, doc)) return err('Tidak berwenang menghapus draft ini', 403);
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        const removed = await txDb.collection('inventory_releases').deleteOne(
          withTenantFilter(scopeAuth, { id: doc.id, status: 'DRAFT' }),
          txOpts(session),
        );
        if (removed.deletedCount === 0) throw new CasConflictError();
        await writeAuditLog(txDb, {
          tenantId: doc.tenantId || tenantIdForWrite(scopeAuth, releaseBody),
          action: 'INVENTORY_RELEASE',
          entityType: 'inventory_release',
          entityId: String(doc.id),
          summary: `Draft release ${doc.noRelease} dihapus`,
          userId: auth.userId,
          userName: auth.name || auth.email || 'System',
          metadata: { noRelease: doc.noRelease, status: 'DRAFT', deleted: true },
        }, session);
      });
    } catch (e) {
      if (isCasConflict(e)) return casConflict(e.message);
      throw e;
    }
    return ok({ message: 'deleted' });
  }

  return null;
}
