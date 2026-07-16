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
import { storeBase64Image, deleteMediaFile } from '@/lib/api/media-storage';
import {
  HACCP_TEMPLATES_COLLECTION,
  HACCP_RESULTS_COLLECTION,
  HACCP_STATUS_TRANSITIONS,
  DEFAULT_HACCP_TEMPLATES,
  normalizeHaccpTemplateItems,
  normalizeHaccpCategory,
  normalizeHaccpResultItems,
  summarizeHaccpItems,
  assertHaccpCanComplete,
  isHaccpEditable,
  type HaccpTemplateDoc,
  type HaccpResultDoc,
  type HaccpResultStatus,
} from '@/lib/food-production/haccp';
import { PRODUCTION_BATCHES_COLLECTION, type ProductionBatchDoc } from '@/lib/food-production/production-batch';
import { QC_RESULTS_COLLECTION } from '@/lib/food-production/qc';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { FP_MANAGE_ROLES, FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import {
  FP_DOC_TYPES,
  FP_DEFAULT_TRANSITIONS,
  assertStatusTransition,
  appendDocHistory,
  nextFpDocNumber,
  type DocHistoryEntry,
} from '@/lib/food-production/document';
import type { HandlerContext } from '@/types/api/handler';

const KNOWN_STATUSES = new Set<string>(Object.keys(FP_DEFAULT_TRANSITIONS));

async function ensureDefaultHaccpTemplates(
  db: HandlerContext['db'],
  tenantId: string,
) {
  const count = await db.collection(HACCP_TEMPLATES_COLLECTION).countDocuments({ tenantId });
  if (count > 0) return;
  const now = new Date();
  const docs: HaccpTemplateDoc[] = DEFAULT_HACCP_TEMPLATES.map((t) => ({
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
  try {
    await db.collection(HACCP_TEMPLATES_COLLECTION).insertMany(docs, { ordered: false });
  } catch (e: unknown) {
    // Concurrent first-hit seed — unique kode race is expected.
    const code = e && typeof e === 'object' ? (e as { code?: number }).code : undefined;
    const msg = e instanceof Error ? e.message : String(e);
    if (code !== 11000 && !msg.includes('E11000')) throw e;
  }
}

/** Persist new data-URL photos; keep existing /api/media URLs. */
async function persistEvidenceList(
  tenantId: string,
  incoming: unknown,
  existing: string[] = [],
): Promise<{ urls: string[]; files: string[] } | { error: string }> {
  const urls: string[] = [];
  const files: string[] = [];
  const list = Array.isArray(incoming) ? incoming : existing;
  for (const raw of list) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
      urls.push(s);
      continue;
    }
    if (s.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 80))) {
      const stored = await storeBase64Image(tenantId, s, { prefix: 'haccp', maxBytes: 768_000 });
      if ('error' in stored) return { error: stored.error };
      urls.push(stored.url);
      files.push(stored.filename);
      continue;
    }
    urls.push(s);
  }
  if (urls.length > 10) return { error: 'Maksimal 10 evidence foto' };
  return { urls, files };
}

export async function handleHaccp(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const haccpBody = (body || {}) as Record<string, unknown>;

  // ── Templates ──
  if (route === '/haccp-templates' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    await ensureDefaultHaccpTemplates(db, tenantId);
    const onlyActive = url.searchParams.get('aktif') === '1';
    const filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    const list = await db.collection(HACCP_TEMPLATES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ category: 1, kode: 1 })
      .limit(100)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/haccp-templates' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: haccpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const kode = String(haccpBody.kode || '').trim().toUpperCase();
    const nama = String(haccpBody.nama || '').trim();
    if (!kode || !nama) return err('kode dan nama wajib', 400);
    const category = normalizeHaccpCategory(haccpBody.category);
    if (typeof category !== 'string') return err(category.error, 400);
    const items = normalizeHaccpTemplateItems(haccpBody.items);
    if ('error' in items) return err(items.error, 400);

    const tenantId = tenantIdForWrite(scopeAuth, haccpBody);
    const now = new Date();
    const doc: HaccpTemplateDoc = {
      id: uuidv4(),
      tenantId,
      kode,
      nama,
      category,
      items,
      aktif: haccpBody.aktif !== false,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await db.collection(HACCP_TEMPLATES_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err(`Kode template ${kode} sudah dipakai`, 400);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'HACCP_TEMPLATE_CREATE',
      entityType: 'haccp_template',
      entityId: doc.id,
      summary: `HACCP template ${doc.kode}`,
      ...auditActor(auth),
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  // ── Results ──
  if (route === '/haccp-results' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    const status = (url.searchParams.get('status') || '').trim();
    if (status) {
      if (!KNOWN_STATUSES.has(status)) return err('Filter status tidak valid', 400);
      filter.status = status;
    }
    const batchId = String(url.searchParams.get('productionBatchId') || '').trim();
    if (batchId) filter.productionBatchId = batchId;
    const planId = String(url.searchParams.get('productionPlanId') || '').trim();
    if (planId) filter.productionPlanId = planId;
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;

    const list = await db.collection(HACCP_RESULTS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/haccp-results' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: haccpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const templateId = String(haccpBody.templateId || '').trim();
    const productionBatchId = String(haccpBody.productionBatchId || '').trim();
    if (!templateId) return err('templateId wajib', 400);
    if (!productionBatchId) return err('productionBatchId wajib', 400);

    const tenantId = tenantIdForWrite(scopeAuth, haccpBody);
    await ensureDefaultHaccpTemplates(db, tenantId);

    const template = await db.collection(HACCP_TEMPLATES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: templateId, aktif: true }),
    ) as HaccpTemplateDoc | null;
    if (!template) return err('Template HACCP tidak ditemukan', 404);

    const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: productionBatchId }),
    ) as ProductionBatchDoc | null;
    if (!batch) return err('Batch tidak ditemukan', 404);

    let linkedQcResultId: string | undefined;
    const qcId = String(haccpBody.linkedQcResultId || '').trim();
    if (qcId) {
      const qc = await db.collection(QC_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: qcId }),
      );
      if (!qc) return err('QC result tidak ditemukan', 400);
      linkedQcResultId = qcId;
    }

    const items = normalizeHaccpResultItems(haccpBody.items ?? [], template.items);
    if ('error' in items) return err(items.error, 400);

    const evidence = await persistEvidenceList(
      tenantId,
      haccpBody.evidenceUrls ?? haccpBody.evidenceBase64 ?? [],
      [],
    );
    if ('error' in evidence) return err(evidence.error, 400);

    const actor = auditActor(auth);
    const now = new Date();
    const noDokumen = await nextFpDocNumber(db, tenantId, FP_DOC_TYPES.HACCP_RESULT);
    const history: DocHistoryEntry[] = appendDocHistory([], {
      at: now,
      fromStatus: null,
      toStatus: 'DRAFT',
      userId: actor.userId,
      userName: actor.userName,
      note: `Template ${template.kode} · batch ${batch.batchNo || batch.id}`,
    });

    const doc: HaccpResultDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen,
      templateId: template.id,
      templateKode: template.kode,
      templateNama: template.nama,
      category: template.category,
      productionBatchId: batch.id,
      batchNo: batch.batchNo,
      productionPlanId: batch.productionPlanId,
      productionPlanNo: batch.productionPlanNo,
      productionResultId: batch.productionResultId,
      productionResultNo: batch.productionResultNo,
      kitchenId: batch.kitchenId,
      kitchenNama: batch.kitchenNama,
      tanggal: String(haccpBody.tanggal || '').trim() || new Date().toISOString().slice(0, 10),
      items,
      evidenceUrls: evidence.urls,
      evidenceMediaFiles: evidence.files,
      linkedQcResultId,
      status: 'DRAFT',
      history,
      summary: summarizeHaccpItems(items, template.items, evidence.urls),
      catatan: String(haccpBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    try {
      await db.collection(HACCP_RESULTS_COLLECTION).insertOne(doc);
    } catch (e: unknown) {
      if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
        return err('Nomor dokumen HACCP bentrok, coba lagi', 409);
      }
      throw e;
    }
    await writeAuditLog(db, {
      tenantId,
      action: 'HACCP_RESULT_CREATE',
      entityType: 'haccp_result',
      entityId: doc.id,
      summary: `HACCP ${doc.noDokumen} · batch ${doc.batchNo || doc.productionBatchId}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (path[0] === 'haccp-results' && path[1] && !path[2] && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const existing = await db.collection(HACCP_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    if (!existing) return err('Hasil HACCP tidak ditemukan', 404);
    return ok(clean(existing as Record<string, unknown>));
  }

  if (path[0] === 'haccp-results' && path[1] && !path[2] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: haccpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(HACCP_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as HaccpResultDoc | null;
    if (!existing) return err('Hasil HACCP tidak ditemukan', 404);
    if (!isHaccpEditable(existing.status)) {
      return err(`Status ${existing.status} tidak dapat diedit`, 400);
    }

    const template = await db.collection(HACCP_TEMPLATES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: existing.templateId }),
    ) as HaccpTemplateDoc | null;
    if (!template) return err('Template hilang', 400);

    const items = normalizeHaccpResultItems(
      haccpBody.items != null ? haccpBody.items : existing.items,
      template.items,
    );
    if ('error' in items) return err(items.error, 400);

    let evidenceUrls = existing.evidenceUrls || [];
    let evidenceMediaFiles = existing.evidenceMediaFiles || [];
    if (haccpBody.evidenceUrls != null || haccpBody.evidenceBase64 != null) {
      const evidence = await persistEvidenceList(
        existing.tenantId,
        haccpBody.evidenceUrls ?? haccpBody.evidenceBase64,
        existing.evidenceUrls || [],
      );
      if ('error' in evidence) return err(evidence.error, 400);
      evidenceUrls = evidence.urls;
      // Keep filenames still referenced by retained /api/media URLs + newly stored.
      const keptFromUrls = (existing.evidenceMediaFiles || []).filter((f) =>
        evidenceUrls.some((u) => u.includes(`/${encodeURIComponent(f)}`) || u.includes(`/${f}`)),
      );
      evidenceMediaFiles = [...new Set([...keptFromUrls, ...evidence.files])];
      const removed = (existing.evidenceMediaFiles || []).filter((f) => !evidenceMediaFiles.includes(f));
      for (const f of removed) {
        await deleteMediaFile(existing.tenantId, f);
      }
    }

    const now = new Date();
    await db.collection(HACCP_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      {
        $set: {
          items,
          evidenceUrls,
          evidenceMediaFiles,
          summary: summarizeHaccpItems(items, template.items, evidenceUrls),
          catatan: haccpBody.catatan != null
            ? String(haccpBody.catatan).trim() || null
            : existing.catatan,
          updatedAt: now,
        },
      },
    );
    const saved = await db.collection(HACCP_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'HACCP_RESULT_UPDATE',
      entityType: 'haccp_result',
      entityId: path[1],
      summary: `HACCP ${existing.noDokumen} diperbarui`,
      ...auditActor(auth),
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  if (path[0] === 'haccp-results' && path[1] && path[2] === 'status' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: haccpBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const toStatus = String(haccpBody.status || '').trim() as HaccpResultStatus;
    if (!toStatus || !KNOWN_STATUSES.has(toStatus)) return err('status tidak valid', 400);
    const existing = await db.collection(HACCP_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    ) as HaccpResultDoc | null;
    if (!existing) return err('Hasil HACCP tidak ditemukan', 404);
    if (existing.status === toStatus) {
      return ok(clean(existing as unknown as Record<string, unknown>));
    }
    const transitionErr = assertStatusTransition(existing.status, toStatus, HACCP_STATUS_TRANSITIONS);
    if (transitionErr) return err(transitionErr, 400);

    if (toStatus === 'COMPLETED') {
      const template = await db.collection(HACCP_TEMPLATES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: existing.templateId }),
      ) as HaccpTemplateDoc | null;
      if (!template) return err('Template hilang', 400);
      const gate = assertHaccpCanComplete(
        existing.items,
        template.items,
        existing.evidenceUrls || [],
      );
      if (gate) return err(gate, 400);
    }

    const actor = auditActor(auth);
    const now = new Date();
    const history = appendDocHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus,
      userId: actor.userId,
      userName: actor.userName,
    });
    await db.collection(HACCP_RESULTS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
      { $set: { status: toStatus, history, updatedAt: now } },
    );
    const saved = await db.collection(HACCP_RESULTS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: path[1] }),
    );
    const action = toStatus === 'COMPLETED'
      ? 'HACCP_RESULT_COMPLETE'
      : toStatus === 'CANCELLED'
        ? 'HACCP_RESULT_CANCEL'
        : 'HACCP_RESULT_STATUS';
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action,
      entityType: 'haccp_result',
      entityId: path[1],
      summary: `HACCP ${existing.noDokumen} → ${toStatus}`,
      ...actor,
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  return null;
}
