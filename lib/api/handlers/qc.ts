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
import { storeBase64Image } from '@/lib/api/media-storage';
import {
  QC_TEMPLATES_COLLECTION,
  QC_RESULTS_COLLECTION,
  QC_STATUS_TRANSITIONS,
  DEFAULT_QC_TEMPLATES,
  normalizeQcTemplateItems,
  normalizeQcCategory,
  normalizeQcResultItems,
  summarizeQcItems,
  assertQcCanComplete,
  isQcEditable,
  type QcTemplateDoc,
  type QcResultDoc,
  type QcResultItem,
  type QcResultStatus,
} from '@/lib/food-production/qc';
import {
  PRODUCTION_PLANS_COLLECTION,
  type ProductionPlanDoc,
} from '@/lib/food-production/production-plan';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  nextFpDocNumber,
  type DocHistoryEntry,
  type FpDocStatus,
} from '@/lib/food-production/document';
import { FP_MANAGE_ROLES, FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import type { HandlerContext } from '@/types/api/handler';

const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

async function ensureDefaultTemplates(
  db: HandlerContext['db'],
  tenantId: string,
) {
  const count = await db.collection(QC_TEMPLATES_COLLECTION).countDocuments({ tenantId });
  if (count > 0) return;
  const now = new Date();
  const docs: QcTemplateDoc[] = DEFAULT_QC_TEMPLATES.map((t) => ({
    id: uuidv4(),
    tenantId,
    kode: t.kode,
    nama: t.nama,
    category: t.category,
    items: t.items,
    aktif: true,
    createdAt: now,
    updatedAt: now,
  }));
  await db.collection(QC_TEMPLATES_COLLECTION).insertMany(docs);
}

/** Persist data-URL photos on each item; keep existing /api/media URLs. */
async function persistItemEvidence(
  tenantId: string,
  items: QcResultItem[],
): Promise<QcResultItem[] | { error: string }> {
  const out: QcResultItem[] = [];
  for (const item of items) {
    const urls: string[] = [];
    for (const raw of item.evidenceUrls || []) {
      const s = String(raw || '').trim();
      if (!s) continue;
      if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
        urls.push(s);
        continue;
      }
      if (s.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 80))) {
        const stored = await storeBase64Image(tenantId, s, { prefix: 'qc', maxBytes: 768_000 });
        if ('error' in stored) return { error: `${item.label}: ${stored.error}` };
        urls.push(stored.url);
        continue;
      }
      urls.push(s);
    }
    if (urls.length > 3) return { error: `Maksimal 3 foto untuk "${item.label}"` };
    out.push({
      ...item,
      evidenceUrls: urls.length ? urls : undefined,
    });
  }
  return out;
}

export async function handleQc(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const qcBody = (body || {}) as Record<string, unknown>;

  // ── Templates ──
  if (route === '/qc-templates' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    await ensureDefaultTemplates(db, tenantId);
    const onlyActive = url.searchParams.get('aktif') === '1';
    const filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    const list = await db.collection(QC_TEMPLATES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ category: 1, kode: 1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/qc-templates' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: qcBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const kode = String(qcBody.kode || '').trim().toUpperCase();
    const nama = String(qcBody.nama || '').trim();
    if (!kode || !nama) return err('kode dan nama wajib');
    const category = normalizeQcCategory(qcBody.category);
    if (typeof category !== 'string') return err(category.error, 400);
    const items = normalizeQcTemplateItems(qcBody.items);
    if ('error' in items) return err(items.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, qcBody);
    const now = new Date();
    const doc: QcTemplateDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      category,
      items,
      aktif: qcBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    await db.collection(QC_TEMPLATES_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'QC_TEMPLATE_CREATE',
      entityType: 'qc_template',
      entityId: doc.id,
      summary: `QC template ${doc.kode}`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  // ── Results ──
  if (route === '/qc-results' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    const productionPlanId = url.searchParams.get('productionPlanId');
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    const tanggal = url.searchParams.get('tanggal');
    if (tanggal) filter.tanggal = tanggal;
    if (productionPlanId) filter.productionPlanId = productionPlanId;
    const list = await db.collection(QC_RESULTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/qc-results' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: qcBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const templateId = String(qcBody.templateId || '').trim();
    if (!templateId) return err('templateId wajib');
    const tenantId = tenantIdForWrite(scopeAuth, qcBody);
    await ensureDefaultTemplates(db, tenantId);

    const template = await db.collection(QC_TEMPLATES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: templateId, aktif: true }),
    ) as QcTemplateDoc | null;
    if (!template) return err('Template QC tidak ditemukan', 404);

    let productionPlanId: string | undefined;
    let productionPlanNo: string | undefined;
    let kitchenId: string | undefined;
    let kitchenNama: string | undefined;
    let tanggal = String(qcBody.tanggal || '').trim() || new Date().toISOString().slice(0, 10);

    const planId = String(qcBody.productionPlanId || '').trim();
    if (planId) {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: planId }),
      ) as ProductionPlanDoc | null;
      if (!plan) return err('Rencana produksi tidak ditemukan', 404);
      productionPlanId = plan.id;
      productionPlanNo = plan.noDokumen;
      kitchenId = plan.kitchenId;
      kitchenNama = plan.kitchenNama;
      tanggal = plan.tanggal;
    }

    let items = normalizeQcResultItems(qcBody.items ?? [], template.items);
    if ('error' in items) return err(items.error, 400);
    const persisted = await persistItemEvidence(tenantId, items);
    if ('error' in persisted) return err(persisted.error, 400);
    items = persisted;

    const saveNow = qcBody.save === true || qcBody.record === true;
    if (saveNow) {
      const gate = assertQcCanComplete(items, template.items);
      if (gate) return err(gate, 400);
    }

    const actor = auditActor(auth);
    const now = new Date();
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.QC_RESULT);
    const status: QcResultStatus = saveNow ? 'COMPLETED' : 'DRAFT';
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: status,
      userId: actor.userId,
      userName: actor.userName,
      note: saveNow ? 'Checklist finding dicatat' : `Template ${template.kode}`,
    });

    const doc: QcResultDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      templateId: template.id,
      templateKode: template.kode,
      templateNama: template.nama,
      category: template.category,
      productionPlanId,
      productionPlanNo,
      kitchenId,
      kitchenNama,
      tanggal,
      items,
      status,
      history,
      summary: summarizeQcItems(items, template.items),
      catatan: String(qcBody.catatan || '').trim() || undefined,
      ...(saveNow ? {
        recordedAt: now,
        recordedBy: actor.userId,
        recordedByName: actor.userName,
      } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(QC_RESULTS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: saveNow ? 'QC_RESULT_RECORD' : 'QC_RESULT_CREATE',
      entityType: 'qc_result',
      entityId: doc.id,
      summary: `QC ${doc.noDokumen} (${template.kode})`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>));
  }

  if (path[0] === 'qc-results' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(QC_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Hasil QC tidak ditemukan', 404);
    return ok(clean(existing as Record<string, unknown>));
  }

  if (path[0] === 'qc-results' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: qcBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(QC_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as QcResultDoc | null;
    if (!existing) return err('Hasil QC tidak ditemukan', 404);
    if (!isQcEditable(existing.status)) return err(`Status ${existing.status} tidak dapat diedit`, 400);

    const template = await db.collection(QC_TEMPLATES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: existing.templateId }),
    ) as QcTemplateDoc | null;
    if (!template) return err('Template hilang', 400);

    let items = normalizeQcResultItems(
      qcBody.items != null ? qcBody.items : existing.items,
      template.items,
    );
    if ('error' in items) return err(items.error, 400);
    const persisted = await persistItemEvidence(existing.tenantId, items);
    if ('error' in persisted) return err(persisted.error, 400);
    items = persisted;

    const gate = assertQcCanComplete(items, template.items);
    if (gate) return err(gate, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'COMPLETED',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Checklist finding disimpan',
    });

    await db.collection(QC_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      {
        $set: {
          items,
          summary: summarizeQcItems(items, template.items),
          catatan: qcBody.catatan != null
            ? String(qcBody.catatan).trim() || undefined
            : existing.catatan,
          status: 'COMPLETED',
          history,
          recordedAt: now,
          recordedBy: actor.userId,
          recordedByName: actor.userName,
          updatedAt: now,
        },
      },
    );
    const saved = await db.collection(QC_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'QC_RESULT_RECORD',
      entityType: 'qc_result',
      entityId: path[1],
      summary: `QC ${existing.noDokumen} dicatat oleh ${actor.userName}`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'qc-results' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: qcBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const toStatus = String(qcBody.status || '').trim() as QcResultStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);
    const existing = await db.collection(QC_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as QcResultDoc | null;
    if (!existing) return err('Hasil QC tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(clean(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, QC_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: toStatus as FpDocStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(qcBody.note || '').trim() || undefined,
    });
    await db.collection(QC_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(QC_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: toStatus === 'COMPLETED' ? 'QC_RESULT_COMPLETE' : 'QC_RESULT_STATUS',
      entityType: 'qc_result',
      entityId: path[1],
      summary: `QC ${existing.noDokumen}: ${existing.status} → ${toStatus}`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'qc-results' && path[1] && !path[2] && method === 'DELETE') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(QC_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as QcResultDoc | null;
    if (!existing) return err('Hasil QC tidak ditemukan', 404);
    if (existing.status === 'CANCELLED') return ok({ id: path[1], status: 'CANCELLED' });
    const transitionErr = assertStatusTransition(existing.status, 'CANCELLED', QC_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus: 'CANCELLED',
      userId: actor.userId,
      userName: actor.userName,
      note: 'Dibatalkan',
    });
    await db.collection(QC_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: 'CANCELLED', history, updatedAt: now } },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'QC_RESULT_CANCEL',
      entityType: 'qc_result',
      entityId: path[1],
      summary: `QC ${existing.noDokumen} dibatalkan`,
      ...auditActor(auth),
    });
    return ok({ id: path[1], status: 'CANCELLED' });
  }

  return null;
}
