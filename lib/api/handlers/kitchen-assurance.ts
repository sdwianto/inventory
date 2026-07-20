/**
 * Kitchen Assurance API — ADR-002.
 * P1: Dashboard + exception Monitoring.
 * P2: Cases (Issue) + Follow Up operasional (Resolution Engine frozen).
 * Routes: ka-monitoring | ka-dashboard | ka-safety-cases | ka-follow-ups | …
 */

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
import { KA_MANAGE_ROLES, KA_OPS_WRITE_ROLES } from '@/lib/kitchen-assurance/roles';
import { KA_DOC_TYPES, assertKaStatusTransition, appendKaHistory } from '@/lib/kitchen-assurance/document';
import { nextKaDocNumber } from '@/lib/kitchen-assurance/document-number';
import { normalizeKaCategory } from '@/lib/kitchen-assurance/categories';
import { KA_POLICIES_COLLECTION } from '@/lib/kitchen-assurance/policy';
import {
  KA_MONITORING_DEFINITIONS_COLLECTION,
} from '@/lib/kitchen-assurance/monitoring';
import { storeBase64Image } from '@/lib/api/media-storage';
import {
  KA_OBSERVATIONS_COLLECTION,
  KA_OBSERVATION_TRANSITIONS,
  normalizeObservationStatus,
  type KaObservationDoc,
  type KaObservationStatus,
} from '@/lib/kitchen-assurance/observation';
import {
  KA_SAFETY_CASES_COLLECTION,
  KA_CASE_TRANSITIONS,
  normalizeCaseKind,
  normalizeCaseStatus,
  type KaSafetyCaseDoc,
  type KaCaseStatus,
} from '@/lib/kitchen-assurance/safety-case';
import {
  KA_FOLLOW_UPS_COLLECTION,
  KA_FOLLOW_UP_TRANSITIONS,
  KA_ACTIVE_FOLLOW_UP_STATUSES,
  normalizeFollowUpStatus,
  normalizeFollowUpPriority,
  assertFollowUpCanVerify,
  activeFollowUpConflictMessage,
  type KaFollowUpDoc,
  type KaFollowUpStatus,
} from '@/lib/kitchen-assurance/follow-up';
import type { KaDashboardSnapshot } from '@/lib/kitchen-assurance/dashboard';
import {
  collectAttentions,
  buildKitchenStatus,
} from '@/lib/kitchen-assurance/attention';
import { ensureOpenKaIssue, resolveKitchenNama } from '@/lib/kitchen-assurance/auto-issue';
import { buildKaReports, resolveReportRange } from '@/lib/kitchen-assurance/reports';
import { buildKaAnalytics } from '@/lib/kitchen-assurance/analytics';
import { toPillar } from '@/lib/kitchen-assurance/categories';
import { KA_CAPABILITIES } from '@/lib/kitchen-assurance/capability-registry';
import type { HandlerContext } from '@/types/api/handler';
import type { KaSignalStatus } from '@/lib/kitchen-assurance/monitoring';

async function persistEvidenceMedia(
  tenantId: string,
  urls: string[],
  opts?: { max?: number; prefix?: string },
): Promise<string[] | { error: string }> {
  const max = opts?.max ?? 5;
  const prefix = opts?.prefix || 'ka-fu';
  const out: string[] = [];
  for (const raw of urls) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (s.startsWith('/api/media/') || s.startsWith('http://') || s.startsWith('https://')) {
      out.push(s);
      continue;
    }
    if (s.startsWith('data:') || /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 80))) {
      const stored = await storeBase64Image(tenantId, s, { prefix, maxBytes: 768_000 });
      if ('error' in stored) return { error: stored.error };
      out.push(stored.url);
      continue;
    }
    out.push(s);
  }
  if (out.length > max) return { error: `Maksimal ${max} foto` };
  return out;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleKitchenAssurance(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, url, request, body } = ctx;
  const b = (body || {}) as Record<string, unknown>;

  // ── Capabilities (read-only registry) ──
  if (route === '/ka-monitoring/capabilities' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    return ok(KA_CAPABILITIES);
  }

  // ── Policies (FROZEN — ADR-002: read-only compat; no write/seed expansion) ──
  if (route === '/ka-policies' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const onlyActive = url.searchParams.get('aktif') === '1';
    const filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    const capabilityId = url.searchParams.get('capabilityId');
    if (capabilityId) filter.capabilityId = capabilityId;
    const list = await db.collection(KA_POLICIES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ kode: 1 })
      .limit(200)
      .toArray();
    return ok({
      frozen: true,
      items: list.map((d) => clean(d as Record<string, unknown>)),
      note: 'Policy Engine dibekukan (ADR-002). KA membaca threshold milik owner domain.',
    });
  }

  if (route === '/ka-policies' && method === 'POST') {
    return err('Policy Engine dibekukan (ADR-002) — tidak menerima create', 410);
  }

  if (route.startsWith('/ka-policies/') && method === 'PATCH') {
    return err('Policy Engine dibekukan (ADR-002) — tidak menerima update', 410);
  }

  // ── Monitoring definitions (FROZEN surplus — read-only) ──
  if (route === '/ka-monitoring/definitions' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const onlyActive = url.searchParams.get('aktif') === '1';
    const filter: Record<string, unknown> = {};
    if (onlyActive) filter.aktif = true;
    const list = await db.collection(KA_MONITORING_DEFINITIONS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ kode: 1 })
      .limit(200)
      .toArray();
    return ok({
      frozen: true,
      items: list.map((d) => clean(d as Record<string, unknown>)),
    });
  }

  if (route === '/ka-monitoring/definitions' && method === 'POST') {
    return err('Monitoring definitions dibekukan (ADR-002)', 410);
  }

  if (route.startsWith('/ka-monitoring/definitions/') && method === 'PATCH') {
    return err('Monitoring definitions dibekukan (ADR-002)', 410);
  }

  // ── Monitoring (exception-driven attention surface — ADR-002 P1) ──
  // P3: raise Issue from Monitoring attention (idempotent via sourceKey)
  if (route === '/ka-monitoring/raise-issue' && method === 'POST') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, b);
    const actor = auditActor(auth);
    const sourceKey = String(b.sourceKey || b.key || '').trim();
    const title = String(b.title || b.label || '').trim();
    if (!sourceKey) return err('sourceKey wajib', 400);
    if (!title) return err('title wajib', 400);
    const category = toPillar(String(b.category || b.pillar || 'FOOD'));
    const level = String(b.level || '').toUpperCase();
    const kitchenId = String(b.kitchenId || '').trim() || undefined;
    const kitchenNama = await resolveKitchenNama(
      db,
      tenantId,
      kitchenId,
      String(b.kitchenNama || '').trim() || undefined,
    );
    const ensured = await ensureOpenKaIssue(db, {
      tenantId,
      sourceKey,
      title,
      category,
      caseKind: level === 'CRITICAL' ? 'BREACH' : 'OTHER',
      severity: level === 'CRITICAL' ? 'HIGH' : 'MEDIUM',
      description: String(b.detail || b.description || '').trim() || undefined,
      kitchenId,
      kitchenNama,
      sourceHref: String(b.href || b.sourceHref || '').trim() || undefined,
      actor,
    });
    if (ensured.created) {
      await writeAuditLog(db, {
        tenantId,
        action: 'KA_CASE_CREATE',
        entityType: 'ka_safety_case',
        entityId: ensured.case.id,
        summary: `Case ${ensured.case.noDokumen} dari Monitoring`,
        ...actor,
      });
    }
    return ok({
      ...clean(ensured.case as unknown as Record<string, unknown>),
      created: ensured.created,
      skipped: ensured.skipped,
    }, ensured.created ? 201 : 200);
  }

  if (route === '/ka-monitoring' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const kitchenId = url.searchParams.get('kitchenId') || undefined;
    const category = url.searchParams.get('category') || undefined;

    let attentions = await collectAttentions(db, { tenantId, kitchenId });
    if (category) {
      const pillar = toPillar(category);
      attentions = attentions.filter((a) => a.pillar === pillar);
    }
    return ok({
      attentions,
      allClear: attentions.length === 0,
      generatedAt: new Date().toISOString(),
      kitchenId,
    });
  }

  // Apply-by-policy — FROZEN (P3 uses raise-issue / auto-issue instead)
  if (route === '/ka-monitoring/apply' && method === 'POST') {
    return err(
      'ka-monitoring/apply dibekukan (ADR-002). Gunakan Monitoring → Buat Issue atau auto Issue cold-chain.',
      410,
    );
  }

  // ── Observations ──
  if (route === '/ka-observations' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const kitchenId = url.searchParams.get('kitchenId');
    if (status) filter.status = status;
    if (category) filter.category = String(category).toUpperCase();
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(KA_OBSERVATIONS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/ka-observations' && method === 'POST') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const category = normalizeKaCategory(b.category);
    if (typeof category !== 'string') return err(category.error, 400);
    const capabilityId = String(b.capabilityId || '').trim();
    const signalLabel = String(b.signalLabel || b.title || '').trim();
    if (!capabilityId || !signalLabel) return err('capabilityId dan signalLabel wajib');

    const signalStatus = String(b.signalStatus || 'WATCH').toUpperCase() as KaSignalStatus;
    if (signalStatus !== 'OK' && signalStatus !== 'WATCH' && signalStatus !== 'BREACH') {
      return err('signalStatus wajib OK | WATCH | BREACH', 400);
    }
    const signalKindRaw = String(b.signalKind || 'EVENT').toUpperCase();
    if (
      signalKindRaw !== 'MEASUREMENT' &&
      signalKindRaw !== 'CHECKLIST' &&
      signalKindRaw !== 'EVENT'
    ) {
      return err('signalKind wajib MEASUREMENT | CHECKLIST | EVENT', 400);
    }

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const actor = auditActor(auth);
    const now = new Date();
    const doc: KaObservationDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.OBSERVATION),
      category,
      capabilityId,
      policyId: String(b.policyId || '').trim() || undefined,
      policyKode: String(b.policyKode || '').trim() || undefined,
      signalKind: signalKindRaw,
      signalKey: String(b.signalKey || `${capabilityId}:${Date.now()}`),
      signalLabel,
      signalStatus,
      severity: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(b.severity || '').toUpperCase())
        ? String(b.severity).toUpperCase()
        : undefined) as KaObservationDoc['severity'],
      value: b.value as KaObservationDoc['value'],
      unit: String(b.unit || '').trim() || undefined,
      kitchenId: String(b.kitchenId || '').trim() || undefined,
      kitchenNama: String(b.kitchenNama || '').trim() || undefined,
      sourceRef: String(b.sourceRef || '').trim() || undefined,
      sourceCollection: String(b.sourceCollection || '').trim() || undefined,
      href: String(b.href || '').trim() || undefined,
      status: 'OPEN',
      catatan: String(b.catatan || '').trim() || undefined,
      history: appendKaHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'OPEN',
        userId: actor.userId,
        userName: actor.userName,
      }),
      observedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(KA_OBSERVATIONS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'KA_OBSERVATION_CREATE',
      entityType: 'ka_observation',
      entityId: doc.id,
      summary: `Observation ${doc.noDokumen}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (route.startsWith('/ka-observations/') && method === 'PATCH') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const id = route.split('/')[2];
    if (!id) return err('id wajib', 400);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(KA_OBSERVATIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as KaObservationDoc | null;
    if (!existing) return err('Observation tidak ditemukan', 404);

    const toStatus = normalizeObservationStatus(b.status);
    if (typeof toStatus !== 'string') return err(toStatus.error, 400);
    const gate = assertKaStatusTransition(
      existing.status,
      toStatus,
      KA_OBSERVATION_TRANSITIONS as unknown as Record<string, string[]>,
    );
    if (gate) return err(gate, 400);

    // Escalate → create Safety Case
    let safetyCaseId = existing.safetyCaseId;
    let safetyCaseNo = existing.safetyCaseNo;
    const actor = auditActor(auth);
    const now = new Date();
    if (toStatus === 'ESCALATED' && !safetyCaseId) {
      const tenantId = existing.tenantId;
      const caseCategory =
        existing.category === 'COMPLIANCE' ? 'OPERATION' : existing.category;
      const caseDoc: KaSafetyCaseDoc = {
        id: uuidv4(),
        tenantId,
        noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.SAFETY_CASE),
        category: caseCategory,
        caseKind: 'BREACH',
        title: existing.signalLabel,
        description: existing.catatan,
        severity: existing.severity,
        status: 'OPEN',
        observationId: existing.id,
        observationNo: existing.noDokumen,
        capabilityId: existing.capabilityId,
        policyId: existing.policyId,
        kitchenId: existing.kitchenId,
        kitchenNama: existing.kitchenNama,
        resolution: { type: 'NONE' },
        photos: [],
        loggedAt: now,
        history: appendKaHistory([], {
          at: now,
          fromStatus: null,
          toStatus: 'OPEN',
          userId: actor.userId,
          userName: actor.userName,
          note: `Escalated from ${existing.noDokumen}`,
        }),
        tanggal: todayYmd(),
        createdAt: now,
        updatedAt: now,
        createdBy: actor.userId,
        createdByName: actor.userName,
      };
      await db.collection(KA_SAFETY_CASES_COLLECTION).insertOne(caseDoc);
      safetyCaseId = caseDoc.id;
      safetyCaseNo = caseDoc.noDokumen;
      await writeAuditLog(db, {
        tenantId,
        action: 'KA_CASE_CREATE',
        entityType: 'ka_safety_case',
        entityId: caseDoc.id,
        summary: `Case ${caseDoc.noDokumen} from observation`,
        ...actor,
      });
    }

    const history = appendKaHistory(existing.history, {
      at: now,
      fromStatus: existing.status,
      toStatus,
      userId: actor.userId,
      userName: actor.userName,
      note: String(b.note || '').trim() || undefined,
    });
    await db.collection(KA_OBSERVATIONS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      {
        $set: {
          status: toStatus as KaObservationStatus,
          safetyCaseId,
          safetyCaseNo,
          history,
          updatedAt: now,
          ...(b.catatan != null ? { catatan: String(b.catatan).trim() || undefined } : {}),
        },
      },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'KA_OBSERVATION_STATUS',
      entityType: 'ka_observation',
      entityId: id,
      summary: `Observation ${existing.noDokumen} → ${toStatus}`,
      ...actor,
    });
    const updated = await db.collection(KA_OBSERVATIONS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    return ok(clean(updated as Record<string, unknown>));
  }

  // ── Safety Cases (Issues) ──
  if (route === '/ka-safety-cases' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = url.searchParams.get('status');
    const category = url.searchParams.get('category');
    const kitchenId = url.searchParams.get('kitchenId');
    if (status) filter.status = status;
    if (category) filter.category = String(category).toUpperCase();
    if (kitchenId) filter.kitchenId = kitchenId;
    const list = await db.collection(KA_SAFETY_CASES_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    const caseIds = list.map((d) => String((d as { id?: string }).id)).filter(Boolean);
    const openFuByCase = new Map<string, number>();
    if (caseIds.length) {
      const fuRows = await db.collection(KA_FOLLOW_UPS_COLLECTION).aggregate([
        {
          $match: withTenantFilter(scopeAuth, {
            safetyCaseId: { $in: caseIds },
            status: { $in: ['OPEN', 'DONE'] },
          }),
        },
        { $group: { _id: '$safetyCaseId', n: { $sum: 1 } } },
      ]).toArray();
      for (const row of fuRows) {
        openFuByCase.set(String((row as { _id: string })._id), Number((row as { n: number }).n) || 0);
      }
    }
    return ok(list.map((d) => {
      const row = clean(d as Record<string, unknown>) as Record<string, unknown>;
      row.openFollowUps = openFuByCase.get(String(row.id)) || 0;
      return row;
    }));
  }

  if (route === '/ka-safety-cases' && method === 'POST') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const category = normalizeKaCategory(b.category);
    if (typeof category !== 'string') return err(category.error, 400);
    if (category === 'COMPLIANCE') {
      return err('Safety Case category tidak boleh COMPLIANCE (pakai FOOD|PEOPLE|OPERATION|EQUIPMENT)', 400);
    }
    const caseKind = normalizeCaseKind(b.caseKind || 'OTHER');
    if (typeof caseKind !== 'string') return err(caseKind.error, 400);
    const title = String(b.title || '').trim();
    if (!title) return err('title wajib');

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const actor = auditActor(auth);
    const now = new Date();
    const kitchenId = String(b.kitchenId || '').trim() || undefined;
    const kitchenNama = await resolveKitchenNama(
      db,
      tenantId,
      kitchenId,
      String(b.kitchenNama || '').trim() || undefined,
    );
    const sourceKey = String(b.sourceKey || '').trim() || undefined;
    const sourceHref = String(b.sourceHref || '').trim() || undefined;

    // P3: idempotent raise from Monitoring / automation
    if (sourceKey) {
      const ensured = await ensureOpenKaIssue(db, {
        tenantId,
        sourceKey,
        title,
        category: category as KaSafetyCaseDoc['category'],
        caseKind,
        severity: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(b.severity || '').toUpperCase())
          ? String(b.severity).toUpperCase()
          : 'MEDIUM') as KaSafetyCaseDoc['severity'],
        description: String(b.description || '').trim() || undefined,
        kitchenId,
        kitchenNama,
        sourceHref,
        actor,
      });
      if (ensured.created) {
        await writeAuditLog(db, {
          tenantId,
          action: 'KA_CASE_CREATE',
          entityType: 'ka_safety_case',
          entityId: ensured.case.id,
          summary: `Case ${ensured.case.noDokumen}`,
          ...actor,
        });
        return ok({
          ...clean(ensured.case as unknown as Record<string, unknown>),
          created: true,
        }, 201);
      }
      return ok({
        ...clean(ensured.case as unknown as Record<string, unknown>),
        created: false,
        skipped: ensured.skipped,
      });
    }

    const rawPhotos = Array.isArray(b.photos)
      ? b.photos.map((x) => String(x)).filter(Boolean)
      : [];
    const persistedPhotos = await persistEvidenceMedia(tenantId, rawPhotos, {
      max: 3,
      prefix: 'ka-case',
    });
    if ('error' in persistedPhotos) return err(persistedPhotos.error, 400);

    let loggedAt = now;
    if (b.loggedAt) {
      const parsed = new Date(String(b.loggedAt));
      if (Number.isNaN(parsed.getTime())) return err('loggedAt tidak valid', 400);
      loggedAt = parsed;
    }

    const doc: KaSafetyCaseDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.SAFETY_CASE),
      category: category as KaSafetyCaseDoc['category'],
      caseKind,
      title,
      description: String(b.description || '').trim() || undefined,
      severity: (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(b.severity || '').toUpperCase())
        ? String(b.severity).toUpperCase()
        : 'MEDIUM') as KaSafetyCaseDoc['severity'],
      status: 'OPEN',
      observationId: String(b.observationId || '').trim() || undefined,
      capabilityId: String(b.capabilityId || '').trim() || undefined,
      sourceKey,
      sourceHref,
      kitchenId,
      kitchenNama,
      batchId: String(b.batchId || '').trim() || undefined,
      planId: String(b.planId || '').trim() || undefined,
      assetId: String(b.assetId || '').trim() || undefined,
      maintenanceRequestId: String(b.maintenanceRequestId || '').trim() || undefined,
      productId: String(b.productId || '').trim() || undefined,
      inventoryHoldRef: String(b.inventoryHoldRef || '').trim() || undefined,
      resolution: { type: 'NONE' },
      photos: persistedPhotos,
      loggedAt,
      history: appendKaHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'OPEN',
        userId: actor.userId,
        userName: actor.userName,
      }),
      tanggal: String(b.tanggal || '').trim() || loggedAt.toISOString().slice(0, 10),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    await db.collection(KA_SAFETY_CASES_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId,
      action: 'KA_CASE_CREATE',
      entityType: 'ka_safety_case',
      entityId: doc.id,
      summary: `Case ${doc.noDokumen}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (route.startsWith('/ka-safety-cases/') && method === 'PATCH') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const id = route.split('/')[2];
    if (!id) return err('id wajib', 400);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(KA_SAFETY_CASES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as KaSafetyCaseDoc | null;
    if (!existing) return err('Safety case tidak ditemukan', 404);

    const actor = auditActor(auth);
    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };

    if (b.status != null) {
      const toStatus = normalizeCaseStatus(b.status);
      if (typeof toStatus !== 'string') return err(toStatus.error, 400);
      const gate = assertKaStatusTransition(
        existing.status,
        toStatus,
        KA_CASE_TRANSITIONS as unknown as Record<string, string[]>,
      );
      if (gate) return err(gate, 400);
      if (toStatus === 'CLOSED') {
        const openFu = await db.collection(KA_FOLLOW_UPS_COLLECTION).countDocuments(
          withTenantFilter(scopeAuth, {
            safetyCaseId: existing.id,
            status: { $in: ['OPEN', 'DONE'] },
          }),
        );
        if (openFu > 0) {
          return err(`Tidak bisa tutup: masih ada ${openFu} follow-up aktif/belum diverifikasi`, 400);
        }
      }
      patch.status = toStatus as KaCaseStatus;
      patch.history = appendKaHistory(existing.history, {
        at: now,
        fromStatus: existing.status,
        toStatus,
        userId: actor.userId,
        userName: actor.userName,
        note: String(b.note || '').trim() || undefined,
      });
    }

    let createdFollowUp: KaFollowUpDoc | null = null;

    // P2: create Follow Up from Issue (no Resolution Engine)
    if (b.createFollowUp != null && typeof b.createFollowUp === 'object') {
      if (existing.status === 'CLOSED' || existing.status === 'CANCELLED') {
        return err('Tidak bisa buat follow-up pada issue yang sudah ditutup/dibatalkan', 400);
      }
      const activeFu = await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, {
          safetyCaseId: existing.id,
          status: { $in: KA_ACTIVE_FOLLOW_UP_STATUSES },
        }),
        { projection: { noDokumen: 1 } },
      ) as Pick<KaFollowUpDoc, 'noDokumen'> | null;
      if (activeFu) {
        return err(activeFollowUpConflictMessage(activeFu.noDokumen), 409);
      }
      const f = b.createFollowUp as Record<string, unknown>;
      const fuTitle = String(f.title || `Follow-up: ${existing.title}`).trim();
      if (!fuTitle) return err('createFollowUp.title wajib', 400);
      const fu: KaFollowUpDoc = {
        id: uuidv4(),
        tenantId: existing.tenantId,
        noDokumen: await nextKaDocNumber(db, existing.tenantId, KA_DOC_TYPES.FOLLOW_UP),
        safetyCaseId: existing.id,
        safetyCaseNo: existing.noDokumen,
        category: existing.category,
        kitchenId: existing.kitchenId,
        kitchenNama: existing.kitchenNama,
        title: fuTitle,
        description: String(f.description || '').trim() || undefined,
        ownerUserId: String(f.ownerUserId || '').trim() || undefined,
        ownerName: String(f.ownerName || '').trim() || undefined,
        priority: normalizeFollowUpPriority(f.priority),
        dueAt: f.dueAt ? new Date(String(f.dueAt)) : undefined,
        evidenceMedia: [],
        status: 'OPEN',
        history: appendKaHistory([], {
          at: now,
          fromStatus: null,
          toStatus: 'OPEN',
          userId: actor.userId,
          userName: actor.userName,
        }),
        createdAt: now,
        updatedAt: now,
        createdBy: actor.userId,
        createdByName: actor.userName,
      };
      try {
        await db.collection(KA_FOLLOW_UPS_COLLECTION).insertOne(fu);
      } catch (e) {
        const code = (e as { code?: number }).code;
        if (code === 11000) return err(activeFollowUpConflictMessage(), 409);
        throw e;
      }
      createdFollowUp = fu;
      if (existing.status === 'OPEN' && patch.status == null) {
        patch.status = 'IN_PROGRESS' as KaCaseStatus;
        patch.history = appendKaHistory(
          (patch.history as KaSafetyCaseDoc['history']) || existing.history,
          {
            at: now,
            fromStatus: existing.status,
            toStatus: 'IN_PROGRESS',
            userId: actor.userId,
            userName: actor.userName,
            note: `Follow-up ${fu.noDokumen} dibuat`,
          },
        );
      }
      await writeAuditLog(db, {
        tenantId: existing.tenantId,
        action: 'KA_FOLLOW_UP_CREATE',
        entityType: 'ka_follow_up',
        entityId: fu.id,
        summary: `Follow-up ${fu.noDokumen} dari ${existing.noDokumen}`,
        ...actor,
      });
    }

    if (b.resolution != null) {
      return err('Resolution Engine dibekukan (ADR-002). Pakai Follow Up + Tutup.', 410);
    }

    if (b.description != null) patch.description = String(b.description).trim() || undefined;

    await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: patch },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'KA_CASE_UPDATE',
      entityType: 'ka_safety_case',
      entityId: id,
      summary: `Case ${existing.noDokumen} updated`,
      ...actor,
    });
    const updated = await db.collection(KA_SAFETY_CASES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );

    return ok({
      ...clean(updated as Record<string, unknown>),
      ...(createdFollowUp
        ? { followUp: clean(createdFollowUp as unknown as Record<string, unknown>) }
        : {}),
    });
  }

  // ── Follow Ups ──
  if (route === '/ka-follow-ups' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const filter: Record<string, unknown> = {};
    const status = url.searchParams.get('status');
    const kitchenId = url.searchParams.get('kitchenId');
    const safetyCaseId = url.searchParams.get('safetyCaseId') || url.searchParams.get('caseId');
    if (status) filter.status = status;
    if (kitchenId) filter.kitchenId = kitchenId;
    if (safetyCaseId) filter.safetyCaseId = safetyCaseId;
    const list = await db.collection(KA_FOLLOW_UPS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  if (route === '/ka-follow-ups' && method === 'POST') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const title = String(b.title || '').trim();
    if (!title) return err('title wajib');

    const tenantId = tenantIdForWrite(scopeAuth, b);
    const actor = auditActor(auth);
    const now = new Date();
    const rawEvidence = Array.isArray(b.evidenceMedia)
      ? b.evidenceMedia.map((x) => String(x)).filter(Boolean)
      : [];
    const persistedEv = await persistEvidenceMedia(tenantId, rawEvidence);
    if ('error' in persistedEv) return err(persistedEv.error, 400);

    const safetyCaseId = String(b.safetyCaseId || '').trim();
    if (!safetyCaseId) {
      return err('Follow-up wajib tertaut ke Issue (safetyCaseId)', 400);
    }
    let kitchenId = String(b.kitchenId || '').trim() || undefined;
    let kitchenNama = String(b.kitchenNama || '').trim() || undefined;
    const linkedCase = await db.collection(KA_SAFETY_CASES_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id: safetyCaseId }),
    ) as KaSafetyCaseDoc | null;
    if (!linkedCase) return err('Issue/case tidak ditemukan', 404);
    if (linkedCase.status === 'CLOSED' || linkedCase.status === 'CANCELLED') {
      return err('Tidak bisa buat follow-up pada issue yang sudah ditutup/dibatalkan', 400);
    }
    const activeFu = await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, {
        safetyCaseId,
        status: { $in: KA_ACTIVE_FOLLOW_UP_STATUSES },
      }),
      { projection: { noDokumen: 1 } },
    ) as Pick<KaFollowUpDoc, 'noDokumen'> | null;
    if (activeFu) {
      return err(activeFollowUpConflictMessage(activeFu.noDokumen), 409);
    }
    const safetyCaseNo = linkedCase.noDokumen;
    kitchenId = kitchenId || linkedCase.kitchenId;
    kitchenNama = kitchenNama || linkedCase.kitchenNama;
    const category = linkedCase.category;
    kitchenNama = await resolveKitchenNama(db, tenantId, kitchenId, kitchenNama);

    const doc: KaFollowUpDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.FOLLOW_UP),
      safetyCaseId,
      safetyCaseNo,
      observationId: String(b.observationId || '').trim() || undefined,
      observationNo: String(b.observationNo || '').trim() || undefined,
      category: category as KaFollowUpDoc['category'],
      kitchenId,
      kitchenNama,
      title,
      description: String(b.description || '').trim() || undefined,
      ownerUserId: String(b.ownerUserId || '').trim() || undefined,
      ownerName: String(b.ownerName || '').trim() || undefined,
      priority: normalizeFollowUpPriority(b.priority),
      dueAt: b.dueAt ? new Date(String(b.dueAt)) : undefined,
      evidenceMedia: persistedEv,
      status: 'OPEN',
      history: appendKaHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'OPEN',
        userId: actor.userId,
        userName: actor.userName,
      }),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };
    try {
      await db.collection(KA_FOLLOW_UPS_COLLECTION).insertOne(doc);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 11000) return err(activeFollowUpConflictMessage(), 409);
      throw e;
    }

    if (linkedCase.status === 'OPEN') {
      await db.collection(KA_SAFETY_CASES_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id: linkedCase.id }),
        {
          $set: {
            status: 'IN_PROGRESS',
            updatedAt: now,
            history: appendKaHistory(linkedCase.history, {
              at: now,
              fromStatus: 'OPEN',
              toStatus: 'IN_PROGRESS',
              userId: actor.userId,
              userName: actor.userName,
              note: `Follow-up ${doc.noDokumen} dibuat`,
            }),
          },
        },
      );
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'KA_FOLLOW_UP_CREATE',
      entityType: 'ka_follow_up',
      entityId: doc.id,
      summary: `Follow-up ${doc.noDokumen}`,
      ...actor,
    });
    return ok(clean(doc as unknown as Record<string, unknown>), 201);
  }

  if (route.startsWith('/ka-follow-ups/') && method === 'PATCH') {
    const id = route.split('/')[2];
    if (!id) return err('id wajib', 400);
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: b, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const existing = await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as KaFollowUpDoc | null;
    if (!existing) return err('Follow-up tidak ditemukan', 404);

    const toStatus = normalizeFollowUpStatus(b.status);
    if (typeof toStatus !== 'string') return err(toStatus.error, 400);

    const needsManage = toStatus === 'VERIFIED';
    const deniedRole = requireRole(auth, [...(needsManage ? KA_MANAGE_ROLES : KA_OPS_WRITE_ROLES)]);
    if (deniedRole) return deniedRole;

    const gate = assertKaStatusTransition(
      existing.status,
      toStatus,
      KA_FOLLOW_UP_TRANSITIONS as unknown as Record<string, string[]>,
    );
    if (gate) return err(gate, 400);

    let evidenceMedia = existing.evidenceMedia || [];
    if (Array.isArray(b.evidenceMedia)) {
      const persistedEv = await persistEvidenceMedia(
        existing.tenantId,
        b.evidenceMedia.map((x) => String(x)).filter(Boolean),
      );
      if ('error' in persistedEv) return err(persistedEv.error, 400);
      evidenceMedia = persistedEv;
    }
    if (toStatus === 'VERIFIED') {
      const vGate = assertFollowUpCanVerify({ evidenceMedia, status: 'DONE' });
      if (existing.status !== 'DONE') return err('Hanya status DONE yang bisa diverifikasi', 400);
      if (vGate) return err(vGate, 400);
    }
    if (toStatus === 'DONE' && !evidenceMedia.length) {
      return err('Evidence wajib sebelum menandai selesai', 400);
    }

    const actor = auditActor(auth);
    const now = new Date();
    const evidenceNote =
      b.evidenceNote != null ? String(b.evidenceNote).trim() || undefined : undefined;
    const historyNote =
      evidenceNote || (b.note != null ? String(b.note).trim() || undefined : undefined);
    const patch: Record<string, unknown> = {
      status: toStatus as KaFollowUpStatus,
      evidenceMedia,
      history: appendKaHistory(existing.history, {
        at: now,
        fromStatus: existing.status,
        toStatus,
        userId: actor.userId,
        userName: actor.userName,
        note: historyNote,
      }),
      updatedAt: now,
    };
    if (toStatus === 'DONE' && b.evidenceNote != null) {
      patch.evidenceNote = evidenceNote;
    }
    if (toStatus === 'VERIFIED') {
      patch.verifiedAt = now;
      patch.verifiedBy = actor.userId;
      patch.verifiedByName = actor.userName;
    }
    await db.collection(KA_FOLLOW_UPS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      { $set: patch },
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'KA_FOLLOW_UP_STATUS',
      entityType: 'ka_follow_up',
      entityId: id,
      summary: `Follow-up ${existing.noDokumen} → ${toStatus}`,
      ...actor,
    });
    const updated = await db.collection(KA_FOLLOW_UPS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    return ok(clean(updated as Record<string, unknown>));
  }

  // ── Dashboard (Kitchen Status — ADR-002 P1) ──
  if (route === '/ka-dashboard' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const kitchenId = url.searchParams.get('kitchenId') || undefined;

    const attentions = await collectAttentions(db, { tenantId, kitchenId });
    const pillars = buildKitchenStatus(attentions);

    const openCases = await db.collection(KA_SAFETY_CASES_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, {
        status: { $in: ['OPEN', 'IN_PROGRESS', 'PENDING_VERIFY'] },
        ...(kitchenId ? { kitchenId } : {}),
      }),
    );
    const openFu = await db.collection(KA_FOLLOW_UPS_COLLECTION).countDocuments(
      withTenantFilter(scopeAuth, {
        status: { $in: ['OPEN', 'DONE'] },
        ...(kitchenId ? { kitchenId } : {}),
      }),
    );

    const snap: KaDashboardSnapshot = {
      generatedAt: new Date().toISOString(),
      kitchenId,
      pillars,
      attentions,
      allClear: attentions.length === 0,
      openCases,
      openFollowUps: openFu,
    };
    return ok(snap);
  }

  // ── Reports (P4) ──
  if (route === '/ka-reports' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const kitchenId = url.searchParams.get('kitchenId') || undefined;
    const range = resolveReportRange({
      days: url.searchParams.get('days'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    const snap = await buildKaReports(db, {
      tenantId,
      kitchenId,
      from: range.from,
      to: range.to,
    });
    return ok(snap);
  }

  // ── Analytics + Recommendations (P5) ──
  if (route === '/ka-analytics' && method === 'GET') {
    const deniedRole = requireRole(auth, [...KA_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);
    const tenantId = tenantIdForWrite(scopeAuth, {});
    const kitchenId = url.searchParams.get('kitchenId') || undefined;
    const range = resolveReportRange({
      days: url.searchParams.get('days') || '14',
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    const snap = await buildKaAnalytics(db, {
      tenantId,
      kitchenId,
      from: range.from,
      to: range.to,
    });
    return ok(snap);
  }

  return null;
}
