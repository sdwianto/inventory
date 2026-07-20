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
  TEMPERATURE_LOGS_COLLECTION,
  TEMPERATURE_THRESHOLDS_COLLECTION,
  DEFAULT_TEMP_THRESHOLDS,
  normalizeTempStage,
  normalizeSuhuC,
  normalizeAlertStatus,
  normalizeThresholdNumbers,
  resolveThresholdBand,
  evaluateTempAlert,
  isOpenTempAlert,
  TEMP_STAGE_LABELS,
  type TempStage,
  type TemperatureLogDoc,
  type TemperatureThresholdDoc,
  type TempThresholdBand,
} from '@/lib/food-production/temperature-log';
import { KITCHENS_COLLECTION } from '@/lib/food-production/kitchen';
import { PRODUCTION_PLANS_COLLECTION, isIsoDate } from '@/lib/food-production/production-plan';
import { PRODUCTION_BATCHES_COLLECTION } from '@/lib/food-production/production-batch';
import { QC_RESULTS_COLLECTION } from '@/lib/food-production/qc';
import { SERVICE_POINTS_COLLECTION } from '@/lib/food-production/service-point';
import { FP_MANAGE_ROLES, FP_OPS_WRITE_ROLES } from '@/lib/food-production/roles';
import { resolveKitchenIdFilter } from '@/lib/food-production/kitchen-scope';
import { ensureOpenKaIssue } from '@/lib/kitchen-assurance/auto-issue';
import type { HandlerContext } from '@/types/api/handler';
import type { AuthContext } from '@/types/auth';

interface LogBody extends Record<string, unknown> {
  stage?: string;
  suhuC?: number;
  kitchenId?: string;
  tanggal?: string;
  recordedAt?: string;
  productionPlanId?: string;
  productionBatchId?: string;
  qcResultId?: string;
  servicePointId?: string;
  catatan?: string;
  minC?: number;
  maxC?: number;
}

interface ThresholdBody extends Record<string, unknown> {
  stage?: string;
  minC?: number | null;
  maxC?: number | null;
  warnBandC?: number | null;
  criticalMarginC?: number | null;
  catatan?: string;
}

async function loadThresholdOverride(
  db: HandlerContext['db'],
  scopeAuth: AuthContext,
  stage: TempStage,
): Promise<TempThresholdBand | null> {
  const doc = await db.collection(TEMPERATURE_THRESHOLDS_COLLECTION).findOne(
    withTenantFilter(scopeAuth, { stage }),
  ) as TemperatureThresholdDoc | null;
  if (!doc) return null;
  return {
    minC: doc.minC,
    maxC: doc.maxC,
    warnBandC: doc.warnBandC,
    criticalMarginC: doc.criticalMarginC,
  };
}

export async function handleTemperatureLogs(ctx: HandlerContext): Promise<NextResponse | null> {
  const { db, auth, method, route, path, url, request, body } = ctx;
  const logBody = (body || {}) as LogBody;
  const thrBody = (body || {}) as ThresholdBody;

  // ── Thresholds (master) ─────────────────────────────────────────────
  if (route === '/temperature-thresholds' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const overrides = await db.collection(TEMPERATURE_THRESHOLDS_COLLECTION)
      .find(withTenantFilter(scopeAuth, {}))
      .toArray() as unknown as TemperatureThresholdDoc[];
    const byStage = new Map(overrides.map((o) => [o.stage, o]));
    const stages = Object.keys(TEMP_STAGE_LABELS) as TempStage[];
    const list = stages.map((stage) => {
      const def = DEFAULT_TEMP_THRESHOLDS[stage];
      const ov = byStage.get(stage);
      const band = resolveThresholdBand(stage, ov || null);
      return {
        stage,
        label: TEMP_STAGE_LABELS[stage],
        minC: band.minC,
        maxC: band.maxC,
        warnBandC: band.warnBandC,
        criticalMarginC: band.criticalMarginC,
        isDefault: !ov,
        id: ov?.id,
        catatan: ov?.catatan,
      };
    });
    return ok(list);
  }

  if (route === '/temperature-thresholds' && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_MANAGE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: thrBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const stageRaw = normalizeTempStage(thrBody.stage);
    if (typeof stageRaw === 'object') return err(stageRaw.error, 400);

    const clearKeys = ['minC', 'maxC', 'warnBandC', 'criticalMarginC'] as const;
    const unset: Record<string, ''> = {};
    for (const key of clearKeys) {
      const val = thrBody[key] as unknown;
      if (val === null || val === '') unset[key] = '';
    }
    const nums = normalizeThresholdNumbers(thrBody);
    if ('error' in nums) return err(nums.error, 400);

    const now = new Date();
    const tenantId = tenantIdForWrite(scopeAuth, thrBody);
    const existing = await db.collection(TEMPERATURE_THRESHOLDS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { stage: stageRaw }),
    ) as TemperatureThresholdDoc | null;

    const setFields: Record<string, unknown> = {
      ...nums,
      catatan: String(thrBody.catatan || '').trim() || null,
      updatedAt: now,
    };

    if (existing) {
      const ops: Record<string, unknown> = { $set: setFields };
      if (Object.keys(unset).length) ops.$unset = unset;
      await db.collection(TEMPERATURE_THRESHOLDS_COLLECTION).updateOne(
        withTenantFilter(scopeAuth, { id: existing.id }),
        ops,
      );
    } else {
      const doc: TemperatureThresholdDoc = {
        id: uuidv4(),
        tenantId,
        stage: stageRaw,
        ...nums,
        catatan: String(thrBody.catatan || '').trim() || undefined,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await db.collection(TEMPERATURE_THRESHOLDS_COLLECTION).insertOne(doc);
      } catch (e: unknown) {
        if (e && typeof e === 'object' && (e as { code?: number }).code === 11000) {
          return err(`Threshold stage ${stageRaw} sudah ada`, 400);
        }
        throw e;
      }
    }

    await writeAuditLog(db, {
      tenantId,
      action: 'TEMP_THRESHOLD_UPSERT',
      entityType: 'temperature_threshold',
      entityId: existing?.id || stageRaw,
      summary: `Threshold suhu ${TEMP_STAGE_LABELS[stageRaw]} diperbarui`,
      ...auditActor(auth),
    });

    const saved = await db.collection(TEMPERATURE_THRESHOLDS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { stage: stageRaw }),
    );
    return ok(clean(saved as Record<string, unknown>));
  }

  // ── Alert summary ───────────────────────────────────────────────────
  if (route === '/temperature-logs/alerts' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {
      alertStatus: { $in: ['WARN', 'OUT_OF_RANGE', 'CRITICAL'] },
      acknowledgedAt: { $exists: false },
    };
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from || to) {
      filter.tanggal = {};
      if (from) {
        if (!isIsoDate(from)) return err('from tidak valid (YYYY-MM-DD)', 400);
        (filter.tanggal as Record<string, string>).$gte = from;
      }
      if (to) {
        if (!isIsoDate(to)) return err('to tidak valid (YYYY-MM-DD)', 400);
        (filter.tanggal as Record<string, string>).$lte = to;
      }
    }

    const matched = withTenantFilter(scopeAuth, filter);
    const [list, grouped] = await Promise.all([
      db.collection(TEMPERATURE_LOGS_COLLECTION)
        .find(matched)
        .sort({ recordedAt: -1 })
        .limit(100)
        .toArray(),
      db.collection(TEMPERATURE_LOGS_COLLECTION).aggregate<{ _id: string; n: number }>([
        { $match: matched },
        { $group: { _id: '$alertStatus', n: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const counts = { WARN: 0, OUT_OF_RANGE: 0, CRITICAL: 0, total: 0 };
    for (const g of grouped) {
      const s = String(g._id);
      if (s === 'WARN' || s === 'OUT_OF_RANGE' || s === 'CRITICAL') {
        counts[s] = Number(g.n) || 0;
        counts.total += Number(g.n) || 0;
      }
    }
    return ok({
      counts,
      truncated: counts.total > list.length,
      items: list.map((d) => clean(d as Record<string, unknown>)),
    });
  }

  // ── Logs list ───────────────────────────────────────────────────────
  if (route === '/temperature-logs' && method === 'GET') {
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const filter: Record<string, unknown> = {};
    const stageRaw = url.searchParams.get('stage');
    if (stageRaw) {
      const stage = normalizeTempStage(stageRaw);
      if (typeof stage === 'object') return err(stage.error, 400);
      filter.stage = stage;
    }
    const alertStatus = normalizeAlertStatus(url.searchParams.get('alertStatus'));
    if (alertStatus) filter.alertStatus = alertStatus;
    if (url.searchParams.get('alertOnly') === '1') {
      filter.alertStatus = { $in: ['WARN', 'OUT_OF_RANGE', 'CRITICAL'] };
    }
    if (url.searchParams.get('openOnly') === '1') {
      filter.alertStatus = { $in: ['WARN', 'OUT_OF_RANGE', 'CRITICAL'] };
      filter.acknowledgedAt = { $exists: false };
    }
    const kitchenId = resolveKitchenIdFilter(url, request);
    if (kitchenId) filter.kitchenId = kitchenId;
    const planId = String(url.searchParams.get('productionPlanId') || '').trim();
    if (planId) filter.productionPlanId = planId;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const tanggal = url.searchParams.get('tanggal');
    if (tanggal) {
      if (!isIsoDate(tanggal)) return err('tanggal tidak valid (YYYY-MM-DD)', 400);
      filter.tanggal = tanggal;
    } else if (from || to) {
      filter.tanggal = {};
      if (from) {
        if (!isIsoDate(from)) return err('from tidak valid (YYYY-MM-DD)', 400);
        (filter.tanggal as Record<string, string>).$gte = from;
      }
      if (to) {
        if (!isIsoDate(to)) return err('to tidak valid (YYYY-MM-DD)', 400);
        (filter.tanggal as Record<string, string>).$lte = to;
      }
    }

    const list = await db.collection(TEMPERATURE_LOGS_COLLECTION)
      .find(withTenantFilter(scopeAuth, filter))
      .sort({ recordedAt: -1 })
      .limit(300)
      .toArray();
    return ok(list.map((d) => clean(d as Record<string, unknown>)));
  }

  // ── Create log (ops write incl. GUDANG) ─────────────────────────────
  if (route === '/temperature-logs' && method === 'POST') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, body: logBody, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const stageRaw = normalizeTempStage(logBody.stage);
    if (typeof stageRaw === 'object') return err(stageRaw.error, 400);
    const suhu = normalizeSuhuC(logBody.suhuC);
    if (typeof suhu === 'object') return err(suhu.error, 400);

    const kitchenId = String(logBody.kitchenId || resolveKitchenIdFilter(url, request) || '').trim() || undefined;
    let kitchenNama: string | undefined;
    if (kitchenId) {
      const k = await db.collection(KITCHENS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: kitchenId, aktif: true }),
      );
      if (!k) return err('Dapur tidak ditemukan / nonaktif', 400);
      kitchenNama = String(k.nama || '');
    }

    let productionPlanId: string | undefined;
    let productionPlanNo: string | undefined;
    const planId = String(logBody.productionPlanId || '').trim();
    if (planId) {
      const plan = await db.collection(PRODUCTION_PLANS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: planId }),
      );
      if (!plan) return err('Rencana produksi tidak ditemukan', 400);
      productionPlanId = planId;
      productionPlanNo = String(plan.noDokumen || '');
    }

    let productionBatchId: string | undefined;
    let batchNo: string | undefined;
    const batchId = String(logBody.productionBatchId || '').trim();
    if (batchId) {
      const batch = await db.collection(PRODUCTION_BATCHES_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: batchId }),
      );
      if (!batch) return err('Batch tidak ditemukan', 400);
      productionBatchId = batchId;
      batchNo = String(batch.batchNo || '');
    }

    let qcResultId: string | undefined;
    let qcResultNo: string | undefined;
    const qcId = String(logBody.qcResultId || '').trim();
    if (qcId) {
      const qc = await db.collection(QC_RESULTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: qcId }),
      );
      if (!qc) return err('QC result tidak ditemukan', 400);
      qcResultId = qcId;
      qcResultNo = String(qc.noDokumen || '');
    }

    let servicePointId: string | undefined;
    let servicePointNama: string | undefined;
    const spId = String(logBody.servicePointId || '').trim();
    if (spId) {
      const sp = await db.collection(SERVICE_POINTS_COLLECTION).findOne(
        withTenantFilter(scopeAuth, { id: spId, aktif: true }),
      );
      if (!sp) return err('Titik layanan tidak ditemukan / nonaktif', 400);
      servicePointId = spId;
      servicePointNama = String(sp.nama || '');
    }

    const override = await loadThresholdOverride(db, scopeAuth, stageRaw);
    const oneOffRaw = normalizeThresholdNumbers({
      minC: logBody.minC,
      maxC: logBody.maxC,
    });
    if ('error' in oneOffRaw) return err(oneOffRaw.error, 400);
    const oneOff = oneOffRaw;
    const band = resolveThresholdBand(
      stageRaw,
      Object.keys(oneOff).length ? { ...override, ...oneOff } : override,
    );
    const alertStatus = evaluateTempAlert(suhu, band);

    const now = new Date();
    let recordedAt = now;
    if (logBody.recordedAt) {
      const parsed = new Date(String(logBody.recordedAt));
      if (Number.isNaN(parsed.getTime())) return err('recordedAt tidak valid', 400);
      recordedAt = parsed;
    }
    const tanggal = String(logBody.tanggal || '').trim() || recordedAt.toISOString().slice(0, 10);
    if (!isIsoDate(tanggal)) return err('tanggal tidak valid (YYYY-MM-DD)', 400);

    const actor = auditActor(auth);
    const doc: TemperatureLogDoc = {
      id: uuidv4(),
      tenantId: tenantIdForWrite(scopeAuth, logBody),
      kitchenId,
      kitchenNama,
      stage: stageRaw,
      suhuC: suhu,
      recordedAt,
      tanggal,
      productionPlanId,
      productionPlanNo,
      productionBatchId,
      batchNo,
      qcResultId,
      qcResultNo,
      servicePointId,
      servicePointNama,
      thresholdMinC: band.minC,
      thresholdMaxC: band.maxC,
      alertStatus,
      catatan: String(logBody.catatan || '').trim() || undefined,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    await db.collection(TEMPERATURE_LOGS_COLLECTION).insertOne(doc);
    await writeAuditLog(db, {
      tenantId: doc.tenantId,
      action: isOpenTempAlert(alertStatus) ? 'TEMP_LOG_ALERT' : 'TEMP_LOG_CREATE',
      entityType: 'temperature_log',
      entityId: doc.id,
      summary: `Log suhu ${TEMP_STAGE_LABELS[stageRaw]} ${suhu}°C → ${alertStatus}`,
      metadata: { stage: stageRaw, suhuC: suhu, alertStatus },
      ...actor,
    });

    // P3: auto Issue on critical cold-chain (idempotent per kitchen+stage)
    let kaIssue: { noDokumen?: string; created?: boolean; skipped?: string } | undefined;
    if (alertStatus === 'CRITICAL' || alertStatus === 'OUT_OF_RANGE') {
      try {
        const sourceKey = `temp:${kitchenId || 'all'}:${stageRaw}`;
        const ensured = await ensureOpenKaIssue(db, {
          tenantId: doc.tenantId,
          sourceKey,
          title: `Cold chain · ${TEMP_STAGE_LABELS[stageRaw] || stageRaw}${kitchenNama ? ` · ${kitchenNama}` : ''}`,
          category: 'FOOD',
          caseKind: 'BREACH',
          severity: alertStatus === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
          description: `${suhu}°C (${alertStatus}) · threshold ${band.minC}–${band.maxC}°C`,
          kitchenId,
          kitchenNama,
          sourceHref: '/food-production/cold-chain',
          actor,
        });
        kaIssue = {
          noDokumen: ensured.case.noDokumen,
          created: ensured.created,
          skipped: ensured.skipped,
        };
        if (ensured.created) {
          await writeAuditLog(db, {
            tenantId: doc.tenantId,
            action: 'KA_CASE_CREATE',
            entityType: 'ka_safety_case',
            entityId: ensured.case.id,
            summary: `Auto Issue ${ensured.case.noDokumen} dari temp alert`,
            ...actor,
          });
        }
      } catch {
        /* non-blocking — temp log remains source of truth */
      }
    }

    return ok({
      ...clean(doc as unknown as Record<string, unknown>),
      ...(kaIssue ? { kaIssue } : {}),
    }, 201);
  }

  // ── Acknowledge alert ───────────────────────────────────────────────
  if (path[0] === 'temperature-logs' && path[1] && path[2] === 'ack' && !path[3] && method === 'PUT') {
    const deniedRole = requireRole(auth, [...FP_OPS_WRITE_ROLES]);
    if (deniedRole) return deniedRole;
    const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
    if (denied) return denied;
    if (!scopeAuth) return err('Scope tidak valid', 400);

    const id = path[1];
    const existing = await db.collection(TEMPERATURE_LOGS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    ) as TemperatureLogDoc | null;
    if (!existing) return err('Log suhu tidak ditemukan', 404);
    if (!isOpenTempAlert(existing.alertStatus)) {
      return err('Hanya alert terbuka yang bisa di-acknowledge', 400);
    }
    if (existing.acknowledgedAt) return ok(clean(existing as unknown as Record<string, unknown>));

    const actor = auditActor(auth);
    const now = new Date();
    await db.collection(TEMPERATURE_LOGS_COLLECTION).updateOne(
      withTenantFilter(scopeAuth, { id }),
      {
        $set: {
          acknowledgedAt: now,
          acknowledgedBy: actor.userId,
          acknowledgedByName: actor.userName,
          updatedAt: now,
        },
      },
    );
    const saved = await db.collection(TEMPERATURE_LOGS_COLLECTION).findOne(
      withTenantFilter(scopeAuth, { id }),
    );
    await writeAuditLog(db, {
      tenantId: existing.tenantId,
      action: 'TEMP_LOG_ACK',
      entityType: 'temperature_log',
      entityId: id,
      summary: `Alert suhu ${existing.suhuC}°C (${existing.stage}) di-acknowledge`,
      ...actor,
    });
    return ok(clean(saved as Record<string, unknown>));
  }

  return null;
}
