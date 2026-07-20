/**
 * Apply Policy onBreach actions for monitoring signals (ADR-002 Phase 0).
 * OBSERVE → open Observation
 * SUGGEST_CASE → Observation + flagged for escalate
 * AUTO_CASE → Observation + Safety Case
 * LINK_WR → Observation with maintenance deep-link meta
 */

import { v4 as uuidv4 } from 'uuid';
import type { Db } from 'mongodb';
import { KA_DOC_TYPES, appendKaHistory } from '@/lib/kitchen-assurance/document';
import { nextKaDocNumber } from '@/lib/kitchen-assurance/document-number';
import {
  KA_OBSERVATIONS_COLLECTION,
  type KaObservationDoc,
} from '@/lib/kitchen-assurance/observation';
import {
  KA_SAFETY_CASES_COLLECTION,
  type KaSafetyCaseDoc,
} from '@/lib/kitchen-assurance/safety-case';
import type { KaPolicyDoc, KaBreachAction } from '@/lib/kitchen-assurance/policy';
import type { MonitoringSignal } from '@/lib/kitchen-assurance/monitoring';

export interface BreachApplyResult {
  signalKey: string;
  action: KaBreachAction;
  observationId?: string;
  observationNo?: string;
  safetyCaseId?: string;
  safetyCaseNo?: string;
  skipped?: string;
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveAction(
  signal: MonitoringSignal,
  policy: KaPolicyDoc | undefined,
): KaBreachAction | null {
  if (signal.status !== 'BREACH' && signal.status !== 'WATCH') return null;
  // WATCH only observes when policy says so; BREACH always acts
  const onBreach = policy?.rules?.onBreach || 'OBSERVE';
  if (signal.status === 'WATCH' && onBreach !== 'OBSERVE' && !policy?.rules?.autoEscalate) {
    return 'OBSERVE';
  }
  if (signal.status === 'WATCH' && onBreach === 'AUTO_CASE') {
    return 'SUGGEST_CASE'; // don't auto-case on WATCH
  }
  return onBreach;
}

export async function applyPolicyBreaches(opts: {
  db: Db;
  tenantId: string;
  signals: MonitoringSignal[];
  policies: KaPolicyDoc[];
  actor: { userId?: string; userName?: string };
}): Promise<BreachApplyResult[]> {
  const { db, tenantId, signals, policies, actor } = opts;
  const byCap = new Map(policies.map((p) => [p.capabilityId, p]));
  const results: BreachApplyResult[] = [];
  const now = new Date();

  for (const signal of signals) {
    if (signal.status === 'OK') continue;
    if (signal.meta?.stub === true) continue;

    const policy = byCap.get(signal.capabilityId);
    const action = resolveAction(signal, policy);
    if (!action) continue;

    // Dedup: one OPEN observation per signalKey
    const existing = await db.collection(KA_OBSERVATIONS_COLLECTION).findOne({
      tenantId,
      signalKey: signal.key,
      status: 'OPEN',
    });
    if (existing) {
      results.push({
        signalKey: signal.key,
        action,
        observationId: String(existing.id),
        observationNo: String(existing.noDokumen || ''),
        skipped: 'observation_open_exists',
      });
      continue;
    }

    const obs: KaObservationDoc = {
      id: uuidv4(),
      tenantId,
      noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.OBSERVATION),
      category: signal.category,
      capabilityId: signal.capabilityId,
      policyId: policy?.id,
      policyKode: policy?.kode,
      signalKind: signal.kind,
      signalKey: signal.key,
      signalLabel: signal.label,
      signalStatus: signal.status,
      severity: signal.severity || policy?.rules?.severity,
      value: signal.value,
      unit: signal.unit,
      kitchenId: signal.kitchenId,
      kitchenNama: signal.kitchenNama,
      sourceRef: signal.sourceRef,
      sourceCollection: signal.sourceCollection,
      href:
        action === 'LINK_WR'
          ? '/maintenance/permintaan'
          : signal.href,
      status: 'OPEN',
      catatan:
        action === 'SUGGEST_CASE'
          ? 'Policy: disarankan eskalasi ke Safety Case'
          : action === 'LINK_WR'
            ? 'Policy: link Work Request Maintenance'
            : undefined,
      history: appendKaHistory([], {
        at: now,
        fromStatus: null,
        toStatus: 'OPEN',
        userId: actor.userId,
        userName: actor.userName,
        note: `Auto from policy ${policy?.kode || 'default'} → ${action}`,
      }),
      observedAt: now,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      createdByName: actor.userName,
    };

    let safetyCaseId: string | undefined;
    let safetyCaseNo: string | undefined;

    if (action === 'AUTO_CASE' || (action === 'SUGGEST_CASE' && policy?.rules?.autoEscalate)) {
      const caseCategory = signal.category === 'COMPLIANCE' ? 'OPERATION' : signal.category;
      const caseDoc: KaSafetyCaseDoc = {
        id: uuidv4(),
        tenantId,
        noDokumen: await nextKaDocNumber(db, tenantId, KA_DOC_TYPES.SAFETY_CASE),
        category: caseCategory as KaSafetyCaseDoc['category'],
        caseKind: 'BREACH',
        title: signal.label,
        description: `Auto-case dari monitoring (${signal.key})`,
        severity: signal.severity || policy?.rules?.severity || 'HIGH',
        status: 'OPEN',
        observationId: obs.id,
        observationNo: obs.noDokumen,
        capabilityId: signal.capabilityId,
        policyId: policy?.id,
        kitchenId: signal.kitchenId,
        kitchenNama: signal.kitchenNama,
        resolution: { type: 'NONE' },
        photos: [],
        loggedAt: now,
        history: appendKaHistory([], {
          at: now,
          fromStatus: null,
          toStatus: 'OPEN',
          userId: actor.userId,
          userName: actor.userName,
          note: 'AUTO_CASE from policy breach',
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
      obs.status = 'ESCALATED';
      obs.safetyCaseId = safetyCaseId;
      obs.safetyCaseNo = safetyCaseNo;
      obs.history = appendKaHistory(obs.history, {
        at: now,
        fromStatus: 'OPEN',
        toStatus: 'ESCALATED',
        userId: actor.userId,
        userName: actor.userName,
        note: `Auto escalate → ${safetyCaseNo}`,
      });
    }

    await db.collection(KA_OBSERVATIONS_COLLECTION).insertOne(obs);
    results.push({
      signalKey: signal.key,
      action,
      observationId: obs.id,
      observationNo: obs.noDokumen,
      safetyCaseId,
      safetyCaseNo,
    });
  }

  return results;
}
