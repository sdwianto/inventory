import type { NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import type { ClientSession, Db } from 'mongodb';
import { ok, err, clean } from '@/lib/api/db';
import {
  tenantIdForWrite,
  withTenantFilter,
  resolveOperationalScope,
} from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { writeAuditLog, auditActor } from '@/lib/api/audit-log';
import { nextDocNumber } from '@/lib/api/document-sequence';
import { guardPosting } from '@/lib/api/period-lock';
import { computeLineEstimasi, sumPoEstimasi, mergePoItemsByStokId } from '@/lib/api/po-estimasi';
import { vendorPoWriteFields } from '@/lib/api/po-channel';
import { listProductUomsByProductIds } from '@/lib/api/product-uom';
import { invalidateDashboardSnapshot } from '@/lib/api/dashboard-snapshot';
import { runInTransactionOrFallback, txOpts } from '@/lib/api/transaction';
import {
  PURCHASE_REQUIREMENTS_COLLECTION,
  buildPurchaseLinesFromMrp,
  summarizePurchaseLines,
  toDraftCpoItemPayloads,
  PR_ELIGIBLE_MRP_STATUSES,
  PR_ACTIVE_STATUSES,
  isPrEditable,
  canRecreateDraftCpo,
  isLinkedCpoSupersedable,
  type PurchaseRequirementDoc,
  type PurchaseRequirementStatus,
} from '@/lib/food-production/purchase-requirement';
import {
  MATERIAL_REQUIREMENTS_COLLECTION,
  type MaterialRequirementDoc,
} from '@/lib/food-production/material-requirement';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { nextFpDocNumber } from '@/lib/food-production/document-number';
import type { HandlerContext } from '@/types/api/handler';

const MANAGE_ROLES = ['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER'] as const;
const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));
const OPEN_PR_STATUSES = ['DRAFT', ...PR_ACTIVE_STATUSES] as const;
const SUPERSEDE_CPO_REASON = 'Digantikan PR baru (supersede)';

interface PrBody extends Record<string, unknown> {
  materialRequirementId?: string;
  catatan?: string;
  status?: string;
  note?: string;
  tanggalKedatangan?: string;
}

function actorFields(auth: HandlerContext['auth']) {
  return auditActor(auth);
}

function projectPr(doc: Record<string, unknown> | null) {
  if (!doc) return null;
  return clean(doc);
}

function isDuplicateKeyError(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: number }).code === 11000);
}

async function enrichDraftCpoStatus(
  db: Db,
  docs: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const ids = [...new Set(
    docs.map((d) => String(d.draftCpoId || '').trim()).filter(Boolean),
  )];
  if (!ids.length) return docs;
  const cpos = await db.collection('customer_purchase_orders')
    .find({ id: { $in: ids } })
    .project({ id: 1, status: 1 })
    .toArray();
  const statusById = new Map(cpos.map((c) => [String(c.id), String(c.status || '')]));
  return docs.map((d) => {
    const cpoId = String(d.draftCpoId || '').trim();
    if (!cpoId) return { ...d, draftCpoStatus: undefined };
    return { ...d, draftCpoStatus: statusById.get(cpoId) || 'MISSING' };
  });
}

async function cancelDraftCpoIfEligible(
  db: Db,
  opts: {
    tenantId: string;
    cpoId?: string;
    reason: string;
    actor: { userId?: string; userName?: string };
    session?: ClientSession;
  },
): Promise<string | null> {
  const cpoId = String(opts.cpoId || '').trim();
  if (!cpoId) return null;
  const cpo = await db.collection('customer_purchase_orders').findOne(
    { id: cpoId, tenantId: opts.tenantId },
    txOpts(opts.session),
  );
  if (!cpo) return null;
  if (cpo.status !== 'DRAFT') return null;
  const now = new Date();
  await db.collection('customer_purchase_orders').updateOne(
    { id: cpoId, tenantId: opts.tenantId },
    {
      $set: {
        status: 'CANCELLED',
        cancelledBy: {
          userId: opts.actor.userId,
          name: opts.actor.userName,
        },
        cancelledAt: now,
        cancelReason: opts.reason,
        updatedAt: now,
      },
    },
    txOpts(opts.session),
  );
  if (!opts.session) {
    await invalidateDashboardSnapshot(db, opts.tenantId);
  }
  return String(cpo.noPO || cpoId);
}

/** Ensure prior DRAFT PRs only link to Draft/cancelled/missing CPO — else block. */
async function assertPriorsSupersedable(
  db: Db,
  scopeAuth: HandlerContext['auth'],
  materialRequirementId: string,
  session?: ClientSession,
): Promise<{ error: string } | { prior: PurchaseRequirementDoc[] }> {
  const prior = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      materialRequirementId,
      status: 'DRAFT',
    }), txOpts(session))
    .toArray() as unknown as PurchaseRequirementDoc[];

  const cpoIds = [...new Set(
    prior.map((old) => String(old.draftCpoId || '').trim()).filter(Boolean),
  )];
  const cpos = cpoIds.length
    ? await db.collection('customer_purchase_orders')
      .find({ id: { $in: cpoIds } }, txOpts(session))
      .project({ id: 1, status: 1, noPO: 1, tenantId: 1 })
      .toArray()
    : [];
  const cpoById = new Map(cpos.map((c) => [String(c.id), c]));

  for (const old of prior) {
    const cpoId = String(old.draftCpoId || '').trim();
    if (!cpoId) continue;
    const cpo = cpoById.get(cpoId);
    const sameTenant = cpo && String(cpo.tenantId || '') === String(old.tenantId || '');
    const st = sameTenant ? String(cpo!.status) : 'MISSING';
    if (!isLinkedCpoSupersedable(st)) {
      return {
        error: `PR ${old.noDokumen} masih tertaut CPO ${String(sameTenant ? cpo?.noPO : cpoId)} status ${st} — batalkan/selesaikan CPO dulu sebelum buat ulang`,
      };
    }
  }
  return { prior };
}

async function supersedeDraftPrsForMrp(
  db: Db,
  scopeAuth: HandlerContext['auth'],
  opts: {
    materialRequirementId: string;
    keepPrId: string;
    actor: { userId?: string; userName?: string };
    now: Date;
    session?: ClientSession;
  },
): Promise<PurchaseRequirementDoc[]> {
  const prior = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION)
    .find(withTenantFilter(scopeAuth, {
      materialRequirementId: opts.materialRequirementId,
      status: 'DRAFT',
      id: { $ne: opts.keepPrId },
    }), txOpts(opts.session))
    .toArray() as unknown as PurchaseRequirementDoc[];

  for (const old of prior) {
    const cancelledCpoNo = await cancelDraftCpoIfEligible(db, {
      tenantId: old.tenantId,
      cpoId: old.draftCpoId,
      reason: SUPERSEDE_CPO_REASON,
      actor: opts.actor,
      session: opts.session,
    });
    const history = appendDocHistory(old.history, {
      at: opts.now,
      fromStatus: old.status,
      toStatus: 'CANCELLED',
      userId: opts.actor.userId,
      userName: opts.actor.userName,
      note: cancelledCpoNo
        ? `Digantikan dokumen baru; Draft CPO ${cancelledCpoNo} dibatalkan`
        : 'Digantikan dokumen PR baru',
    });
    await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: old.id }),
      { $set: { status: 'CANCELLED', history, updatedAt: opts.now } },
      txOpts(opts.session),
    );
  }
  return prior;
}

/**
 * Non-tx fallback compensate: restore DRAFT PRs (+ Draft CPO) cancelled during a failed create.
 */
async function restoreSupersededDraftPrs(
  db: Db,
  scopeAuth: HandlerContext['auth'],
  priors: PurchaseRequirementDoc[],
  tenantId: string,
): Promise<void> {
  if (!priors.length) return;
  const now = new Date();
  for (const old of priors) {
    await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: old.id, status: 'CANCELLED' }),
      {
        $set: {
          status: 'DRAFT',
          history: old.history || [],
          draftCpoId: old.draftCpoId,
          draftCpoNo: old.draftCpoNo,
          updatedAt: now,
        },
      },
    );
    const cpoId = String(old.draftCpoId || '').trim();
    if (!cpoId) continue;
    await db.collection('customer_purchase_orders').updateOne(
      {
        id: cpoId,
        tenantId: old.tenantId || tenantId,
        status: 'CANCELLED',
        cancelReason: SUPERSEDE_CPO_REASON,
      },
      {
        $set: { status: 'DRAFT', updatedAt: now },
        $unset: { cancelledBy: '', cancelledAt: '', cancelReason: '' },
      },
    );
  }
  await invalidateDashboardSnapshot(db, tenantId);
}

async function mapCpoItemsFromProducts(
  db: Db,
  tenantId: string,
  rawItems: ReturnType<typeof toDraftCpoItemPayloads>,
): Promise<
  | { error: string }
  | { items: ReturnType<typeof mergePoItemsByStokId>; warnings: string[] }
> {
  const localIds = [...new Set(rawItems.map((it) => it.localStokId).filter(Boolean))];
  const productRows = localIds.length
    ? await db.collection('products').find({ tenantId, id: { $in: localIds } }).toArray()
    : [];
  const prodById = new Map(productRows.map((p) => [String(p.id), p]));
  const uomsByProduct = await listProductUomsByProductIds(db, tenantId, localIds);

  const warnings: string[] = [];
  for (const it of rawItems) {
    const prod = prodById.get(String(it.localStokId));
    if (!prod) {
      return { error: `Produk ${it.kode || it.localStokId} tidak ditemukan di katalog` };
    }
    if (prod.aktif === false) {
      const label = String(prod.nama || prod.kode || it.localStokId);
      return {
        error: `Produk "${label}" tidak aktif — aktifkan / Sync Katalog sebelum buat Draft CPO`,
      };
    }
    if (!prod.vendorStokId || !prod.vendorTenantId) {
      warnings.push(
        `${prod.nama || prod.kode || it.localStokId} belum sync vendor — Draft CPO perlu Sync Katalog sebelum kirim`,
      );
    }
  }

  const mapped = rawItems.map((it) => {
    const prod = prodById.get(String(it.localStokId))!;
    const hargaBeli = parseInt(String(prod.hargaBeli || 0), 10) || 0;
    const uoms = uomsByProduct.get(String(it.localStokId)) || [];
    const satuanWant = String(it.satuan || prod.satuan || '').trim().toLowerCase();
    const matchedUom = satuanWant
      ? uoms.find((u) => String(u.satuan || '').trim().toLowerCase() === satuanWant)
      : uoms.find((u) => u.isBase) || uoms[0];
    let vendorUomId = matchedUom?.vendorUomId || '';
    if (!vendorUomId || String(vendorUomId).startsWith('legacy:')) {
      const fromProduct = prod.vendorBaseUomId != null ? String(prod.vendorBaseUomId).trim() : '';
      if (fromProduct && !fromProduct.startsWith('legacy:')) vendorUomId = fromProduct;
    }
    return computeLineEstimasi({
      lineId: uuidv4(),
      localStokId: it.localStokId,
      vendorStokId: prod.vendorStokId != null ? String(prod.vendorStokId) : undefined,
      vendorTenantId: prod.vendorTenantId != null ? String(prod.vendorTenantId) : undefined,
      vendorKode: prod.kode != null ? String(prod.kode) : it.kode,
      kode: (prod.kode != null ? String(prod.kode) : it.kode) || undefined,
      nama: (prod.nama != null ? String(prod.nama) : it.nama) || undefined,
      satuan: matchedUom?.satuan || it.satuan || (prod.satuan != null ? String(prod.satuan) : undefined),
      uomId: matchedUom?.id || '',
      vendorUomId,
      qty: it.qty,
      estimasiHarga: hargaBeli,
      hargaBeliReferensi: hargaBeli,
    });
  });

  return {
    items: mergePoItemsByStokId(mapped),
    warnings: [...new Set(warnings)].slice(0, 20),
  };
}

type PreparedCpo =
  | { locked: NextResponse }
  | { error: string }
  | {
      insertDoc: Record<string, unknown>;
      warnings: string[];
    };

async function prepareDraftCpo(
  db: Db,
  opts: {
    tenantId: string;
    scopeAuth: HandlerContext['auth'];
    body: PrBody;
    auth: HandlerContext['auth'];
    pr: Pick<PurchaseRequirementDoc, 'id' | 'noDokumen' | 'materialRequirementId' | 'productionPlanId' | 'lines' | 'tanggal'>;
  },
): Promise<PreparedCpo> {
  const rawItems = toDraftCpoItemPayloads(opts.pr.lines);
  if (!rawItems.length) return { error: 'Tidak ada baris kekurangan untuk Draft CPO' };

  const tanggalKedatangan = opts.body.tanggalKedatangan
    ? new Date(String(opts.body.tanggalKedatangan))
    : new Date(opts.pr.tanggal || Date.now());
  if (Number.isNaN(tanggalKedatangan.getTime())) {
    return { error: 'tanggalKedatangan tidak valid' };
  }
  const locked = await guardPosting(db, opts.scopeAuth, opts.body, tanggalKedatangan);
  if (locked) return { locked };

  const mapped = await mapCpoItemsFromProducts(db, opts.tenantId, rawItems);
  if ('error' in mapped) return { error: mapped.error };
  if (!mapped.items.length) return { error: 'Gagal memetakan item Draft CPO' };

  const now = new Date();
  const noPO = await nextDocNumber(db, opts.tenantId, 'CPO', 'CPO');
  const actor = actorFields(opts.auth);
  const insertDoc = {
    id: uuidv4(),
    tenantId: opts.tenantId,
    noPO,
    tanggal: now,
    tanggalKedatangan,
    status: 'DRAFT',
    items: mapped.items,
    estimasiTotal: sumPoEstimasi(mapped.items),
    catatan: `Dari Kebutuhan Beli ${opts.pr.noDokumen}`,
    paymentTerms: 'KREDIT',
    ...vendorPoWriteFields({
      purchaseRequirementId: opts.pr.id,
      purchaseRequirementNo: opts.pr.noDokumen,
      materialRequirementId: opts.pr.materialRequirementId,
      productionPlanId: opts.pr.productionPlanId,
    }),
    createdBy: {
      userId: actor.userId,
      name: actor.userName,
    },
    createdAt: now,
    updatedAt: now,
  };

  return { insertDoc, warnings: mapped.warnings };
}

export async function handlePurchaseRequirements(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const prBody = (body || {}) as PrBody;

  if (route === '/purchase-requirements' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    const tanggal = url.searchParams.get('tanggal');
    const status = (url.searchParams.get('status') || '').trim();
    const materialRequirementId = url.searchParams.get('materialRequirementId');
    const productionPlanId = url.searchParams.get('productionPlanId');
    if (tanggal) filter.tanggal = tanggal;
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    if (materialRequirementId) filter.materialRequirementId = materialRequirementId;
    if (productionPlanId) filter.productionPlanId = productionPlanId;

    const list = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    const enriched = await enrichDraftCpoStatus(db, list as Array<Record<string, unknown>>);
    return ok(enriched.map((doc) => projectPr(doc)));
  }

  if (route === '/purchase-requirements' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: prBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const materialRequirementId = String(prBody.materialRequirementId || '').trim();
    if (!materialRequirementId) return err('materialRequirementId wajib');

    const mrp = await db.collection(MATERIAL_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: materialRequirementId }),
    ) as MaterialRequirementDoc | null;
    if (!mrp) return err('Kebutuhan bahan tidak ditemukan', 404);
    if (!PR_ELIGIBLE_MRP_STATUSES.has(mrp.status)) {
      return err(`MRP status ${mrp.status} belum siap (wajib Disetujui)`, 400);
    }

    const lines = buildPurchaseLinesFromMrp(mrp.lines || []);
    if (!lines.length) {
      return err('Tidak ada kekurangan (qtyNet) dari MRP — tidak perlu beli', 400);
    }

    const activePr = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        materialRequirementId,
        status: { $in: [...PR_ACTIVE_STATUSES] },
      }),
    );
    if (activePr) {
      return err(
        `Sudah ada PR aktif ${String((activePr as { noDokumen?: string }).noDokumen || activePr.id)} (${String((activePr as { status?: string }).status)}) — batalkan dulu`,
        400,
      );
    }

    const supersedeCheck = await assertPriorsSupersedable(db, scopeAuth, materialRequirementId);
    if ('error' in supersedeCheck) return err(supersedeCheck.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, prBody);
    const now = new Date();
    const actor = actorFields(auth);
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.PURCHASE_REQUIREMENT);
    const summary = summarizePurchaseLines(lines);
    const doc: PurchaseRequirementDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      materialRequirementId: mrp.id,
      materialRequirementNo: mrp.noDokumen,
      productionPlanId: mrp.productionPlanId,
      productionPlanNo: mrp.productionPlanNo,
      tanggal: mrp.tanggal,
      kitchenId: mrp.kitchenId,
      kitchenNama: mrp.kitchenNama,
      warehouseKode: mrp.warehouseKode,
      lines,
      status: 'DRAFT',
      history: appendDocHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'DRAFT',
        userId: actor.userId,
        userName: actor.userName,
        note: `Dari MRP ${mrp.noDokumen}`,
      }),
      summary,
      catatan: String(prBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    const prepared = await prepareDraftCpo(db, {
      tenantId,
      scopeAuth,
      body: prBody,
      auth,
      pr: doc,
    });
    if ('locked' in prepared) return prepared.locked;
    if ('error' in prepared) return err(prepared.error, 400);

    doc.draftCpoId = String(prepared.insertDoc.id);
    doc.draftCpoNo = String(prepared.insertDoc.noPO);
    doc.draftCpoStatus = 'DRAFT';
    if (prepared.warnings.length) {
      doc.summary = { ...doc.summary, warnings: prepared.warnings };
    }
    doc.history = appendDocHistory(doc.history, {
      at: now,
      fromStatus: 'DRAFT',
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: `Draft CPO ${doc.draftCpoNo} dibuat`,
    });

    let createCommitted = false;
    let usedNonTxFallback = false;
    let supersededPriors: PurchaseRequirementDoc[] = [];
    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        if (!session) usedNonTxFallback = true;

        const activeAgain = await txDb.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, {
            materialRequirementId,
            status: { $in: [...PR_ACTIVE_STATUSES] },
          }),
          txOpts(session),
        );
        if (activeAgain) {
          throw Object.assign(new Error('ACTIVE_PR'), { httpStatus: 400, detail: activeAgain });
        }

        const again = await assertPriorsSupersedable(txDb, scopeAuth, materialRequirementId, session);
        if ('error' in again) {
          throw Object.assign(new Error(again.error), { httpStatus: 400 });
        }

        // Cancel prior DRAFT first (unique open index allows only one open PR).
        supersededPriors = await supersedeDraftPrsForMrp(txDb, scopeAuth, {
          materialRequirementId,
          keepPrId: doc.id,
          actor,
          now,
          session,
        });

        await txDb.collection('customer_purchase_orders').insertOne(
          prepared.insertDoc,
          txOpts(session),
        );
        await txDb.collection(PURCHASE_REQUIREMENTS_COLLECTION).insertOne(
          doc,
          txOpts(session),
        );
        createCommitted = true;
      });
    } catch (e) {
      if (!createCommitted && usedNonTxFallback) {
        const prInserted = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
          withTenantFilter(scopeAuth, { id: doc.id }),
        );
        if (!prInserted) {
          await db.collection('customer_purchase_orders').deleteOne({
            id: prepared.insertDoc.id,
            tenantId,
            status: 'DRAFT',
          });
          await restoreSupersededDraftPrs(db, scopeAuth, supersededPriors, tenantId);
        }
      }
      if (isDuplicateKeyError(e)) {
        return err('PR untuk MRP ini sedang dibuat oleh user lain — muat ulang dan coba lagi', 409);
      }
      if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 400) {
        const detail = (e as { detail?: { noDokumen?: string; id?: string; status?: string } }).detail;
        if (detail) {
          return err(
            `Sudah ada PR aktif ${detail.noDokumen || detail.id} (${detail.status}) — batalkan dulu`,
            400,
          );
        }
        return err(e instanceof Error ? e.message : 'Gagal membuat PR', 400);
      }
      throw e;
    }

    await invalidateDashboardSnapshot(db, tenantId);
    await writeAuditLog(db, {
      tenantId,
      action: 'PR_CREATE',
      entityType: 'purchase_requirement',
      entityId: doc.id,
      summary: `PR ${doc.noDokumen} → Draft CPO ${doc.draftCpoNo} (${doc.summary.lineCount} item)`,
      ...auditActor(auth),
    });
    return ok(projectPr(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'purchase-requirements' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Kebutuhan beli tidak ditemukan', 404);
    const [enriched] = await enrichDraftCpoStatus(db, [existing as Record<string, unknown>]);
    return ok(projectPr(enriched));
  }

  if (path[0] === 'purchase-requirements' && path[1] && path[2] === 'create-draft-cpo' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: prBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as PurchaseRequirementDoc | null;
    if (!existing) return err('Kebutuhan beli tidak ditemukan', 404);
    if (!isPrEditable(existing.status) && existing.status !== 'APPROVED' && existing.status !== 'PROCESSING') {
      return err(`Status ${existing.status} tidak dapat membuat Draft CPO`, 400);
    }

    let draftCpoStatus: string | undefined;
    if (existing.draftCpoId) {
      const existingCpo = await db.collection('customer_purchase_orders').findOne({
        id: existing.draftCpoId,
        tenantId: existing.tenantId,
      });
      draftCpoStatus = existingCpo ? String(existingCpo.status) : 'MISSING';
      if (!canRecreateDraftCpo(existing.status, draftCpoStatus)) {
        return err(`Sudah punya Draft CPO ${existing.draftCpoNo || existing.draftCpoId}`, 400);
      }
    } else if (!canRecreateDraftCpo(existing.status, null)) {
      return err(`Status ${existing.status} tidak dapat membuat Draft CPO`, 400);
    }

    const tenantId = existing.tenantId;
    const prepared = await prepareDraftCpo(db, {
      tenantId,
      scopeAuth,
      body: prBody,
      auth,
      pr: existing,
    });
    if ('locked' in prepared) return prepared.locked;
    if ('error' in prepared) return err(prepared.error, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const warnings = prepared.warnings.length
      ? [...new Set([...(existing.summary.warnings || []), ...prepared.warnings])].slice(0, 20)
      : existing.summary.warnings;
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: existing.status,
      userId: actor.userId,
      userName: actor.userName,
      note: `Draft CPO ${String(prepared.insertDoc.noPO)} dibuat ulang`,
    });

    try {
      await runInTransactionOrFallback(async ({ db: txDb, session }) => {
        await txDb.collection('customer_purchase_orders').insertOne(
          prepared.insertDoc,
          txOpts(session),
        );
        const upd = await txDb.collection(PURCHASE_REQUIREMENTS_COLLECTION).updateOne(
          withTenantFilter(scopeAuth, { id }),
          {
            $set: {
              draftCpoId: prepared.insertDoc.id,
              draftCpoNo: prepared.insertDoc.noPO,
              summary: { ...existing.summary, ...(warnings?.length ? { warnings } : {}) },
              history,
              updatedAt: now,
            },
          },
          txOpts(session),
        );
        if (!upd.matchedCount) {
          throw Object.assign(new Error('PR hilang saat update'), { httpStatus: 404 });
        }
      });
    } catch (e) {
      // Non-tx fallback / failed update: drop orphan Draft CPO if not linked on PR.
      const linked = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id, draftCpoId: prepared.insertDoc.id }),
      );
      if (!linked) {
        await db.collection('customer_purchase_orders').deleteOne({
          id: prepared.insertDoc.id,
          tenantId,
          status: 'DRAFT',
        });
      }
      if (e && typeof e === 'object' && (e as { httpStatus?: number }).httpStatus === 404) {
        return err('Kebutuhan beli tidak ditemukan', 404);
      }
      throw e;
    }

    const saved = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    const [enriched] = await enrichDraftCpoStatus(db, [saved as Record<string, unknown>]);
    await invalidateDashboardSnapshot(db, tenantId);
    await writeAuditLog(db, {
      tenantId,
      action: 'PR_DRAFT_CPO',
      entityType: 'purchase_requirement',
      entityId: id,
      summary: `PR ${existing.noDokumen} → Draft CPO ${String(prepared.insertDoc.noPO)}`,
      ...auditActor(auth),
    });
    return ok(projectPr(enriched));
  }

  if (path[0] === 'purchase-requirements' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: prBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const toStatus = String(prBody.status || '').trim() as PurchaseRequirementStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);

    const existing = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as PurchaseRequirementDoc | null;
    if (!existing) return err('Kebutuhan beli tidak ditemukan', 404);

    const transitionErr = assertStatusTransition(existing.status, toStatus);
    if (transitionErr) return err(transitionErr, 400);

    if ((PR_ACTIVE_STATUSES as readonly string[]).includes(toStatus)) {
      const other = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          materialRequirementId: existing.materialRequirementId,
          status: { $in: [...OPEN_PR_STATUSES] },
          id: { $ne: id },
        }),
      );
      if (other) {
        return err(
          `MRP ini sudah punya PR terbuka ${String((other as { noDokumen?: string }).noDokumen || other.id)}`,
          400,
        );
      }
    }

    const actor = actorFields(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(prBody.note || '').trim() || undefined,
    });

    try {
      await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id }),
        { $set: { status: toStatus, history, updatedAt: now } },
      );
    } catch (e) {
      if (isDuplicateKeyError(e)) {
        return err('Konflik status PR untuk MRP yang sama — muat ulang', 409);
      }
      throw e;
    }
    const saved = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    const [enriched] = await enrichDraftCpoStatus(db, [saved as Record<string, unknown>]);
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PR_STATUS',
      entityType: 'purchase_requirement',
      entityId: id,
      summary: `PR ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(projectPr(enriched));
  }

  if (path[0] === 'purchase-requirements' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as PurchaseRequirementDoc | null;
    if (!existing) return err('Kebutuhan beli tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id, status: 'CANCELLED' });
    if (existing.status === 'COMPLETED') {
      return err('Dokumen selesai tidak dapat dibatalkan', 400);
    }
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED');
    if (transitionErr) return err(transitionErr, 400);

    const actor = actorFields(auth);
    const now = new Date();
    const cancelledCpoNo = await cancelDraftCpoIfEligible(db, {
      tenantId: existing.tenantId,
      cpoId: existing.draftCpoId,
      reason: `Dibatalkan bersama PR ${existing.noDokumen}`,
      actor,
    });
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: actor.userId,
      userName: actor.userName,
      note: cancelledCpoNo
        ? `Dibatalkan; Draft CPO ${cancelledCpoNo} ikut dibatalkan`
        : 'Dibatalkan',
    });
    await db.collection(PURCHASE_REQUIREMENTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'PR_CANCEL',
      entityType: 'purchase_requirement',
      entityId: id,
      summary: cancelledCpoNo
        ? `PR ${existing.noDokumen} + Draft CPO ${cancelledCpoNo} dibatalkan`
        : `PR ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id, status: 'CANCELLED', cancelledDraftCpoNo: cancelledCpoNo });
  }

  return null;
}
