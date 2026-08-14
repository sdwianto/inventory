/**
 * ADR-004 Fase 6 — Audit readiness read-model.
 * Agregasi evidence BGN/PRP + HACCP plan/verification → NOT_READY | PARTIAL | READY.
 * Bukan dashboard Food Safety mandiri (dicoret); panel di atas data existing.
 */

import type { Db } from 'mongodb';
import {
  FOOD_SAFETY_PROGRAMS_COLLECTION,
  FOOD_SAFETY_REQUIREMENTS_COLLECTION,
  type FoodSafetyProgramDoc,
  type FoodSafetyRequirementDoc,
} from '@/lib/food-production/food-safety-program';
import { HACCP_PLANS_COLLECTION, type HaccpPlanDoc, hasHaccpPlanValidation, hasHaccpTrainingEvidence } from '@/lib/food-production/haccp-plan';
import { HACCP_VERIFICATIONS_COLLECTION } from '@/lib/food-production/haccp-verification';
import { QC_RESULTS_COLLECTION } from '@/lib/food-production/qc';
import { PRODUCTION_BATCHES_COLLECTION } from '@/lib/food-production/production-batch';
import { HACCP_RESULTS_COLLECTION } from '@/lib/food-production/haccp';
import { auditPillarHref } from '@/lib/food-safety/audit-links';
import { buildPrpSetupHref, resolvePrpMeta } from '@/lib/food-safety/prp-meta';

export type AuditReadinessStatus = 'NOT_READY' | 'PARTIAL' | 'READY';

export const AUDIT_READINESS_STATUS_LABELS: Record<AuditReadinessStatus, string> = {
  NOT_READY: 'Belum siap',
  PARTIAL: 'Sebagian',
  READY: 'Siap audit',
};

export interface AuditReadinessPillar {
  key: string;
  label: string;
  status: AuditReadinessStatus;
  detail: string;
  evidenceCount?: number;
  requiredCount?: number;
  /** Gelombang E — deep-link perbaikan (Setup / Operasi / Temuan / Wizard). */
  href?: string;
}

export interface BgnRequirementEvidence {
  requirementId: string;
  programId: string;
  programKode?: string;
  kode: string;
  nama: string;
  sourceRef?: string;
  requirementGroup?: string;
  bgnCode?: string;
  /** Ada QC PREREQUISITE PASS yang merujuk requirement di jendela lookback. */
  hasEvidence: boolean;
  lastEvidenceAt?: string;
  /** Gelombang D — deep-link Setup accordion item. */
  href?: string;
}

export interface AuditReadinessSnapshot {
  status: AuditReadinessStatus;
  asOf: string;
  lookbackDays: number;
  pillars: AuditReadinessPillar[];
  bgnRequirements: BgnRequirementEvidence[];
  disclaimer: string;
}

export function aggregateReadinessStatus(
  pillars: Array<Pick<AuditReadinessPillar, 'status'>>,
): AuditReadinessStatus {
  if (!pillars.length) return 'NOT_READY';
  if (pillars.every((p) => p.status === 'READY')) return 'READY';
  if (pillars.every((p) => p.status === 'NOT_READY')) return 'NOT_READY';
  return 'PARTIAL';
}

export function pillarFromCounts(input: {
  evidenceCount: number;
  requiredCount: number;
  /** Bila required 0, anggap READY (tidak ada yang harus dibuktikan). */
  emptyIsReady?: boolean;
}): AuditReadinessStatus {
  const req = Math.max(0, input.requiredCount);
  const ev = Math.max(0, input.evidenceCount);
  if (req === 0) return input.emptyIsReady === false ? 'NOT_READY' : 'READY';
  if (ev <= 0) return 'NOT_READY';
  if (ev >= req) return 'READY';
  return 'PARTIAL';
}

/**
 * Bangun snapshot audit readiness untuk tenant (opsional filter kitchen).
 */
export async function buildAuditReadinessSnapshot(
  db: Db,
  input: { tenantId: string; kitchenId?: string; lookbackDays?: number },
): Promise<AuditReadinessSnapshot> {
  const lookbackDays = Math.min(90, Math.max(7, input.lookbackDays ?? 30));
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - lookbackDays);
  const asOf = new Date().toISOString();

  const reqFilter: Record<string, unknown> = {
    tenantId: input.tenantId,
    source: 'BGN',
    aktif: true,
  };
  const bgnReqs = await db.collection(FOOD_SAFETY_REQUIREMENTS_COLLECTION)
    .find(reqFilter)
    .sort({ sortOrder: 1 })
    .toArray() as unknown as FoodSafetyRequirementDoc[];

  const programs = await db.collection(FOOD_SAFETY_PROGRAMS_COLLECTION)
    .find({ tenantId: input.tenantId, aktif: true })
    .toArray() as unknown as FoodSafetyProgramDoc[];
  const programById = new Map(programs.map((p) => [p.id, p]));

  const qcFilter: Record<string, unknown> = {
    tenantId: input.tenantId,
    category: 'PREREQUISITE',
    status: 'COMPLETED',
    'summary.requiredFailCount': { $lte: 0 },
    updatedAt: { $gte: since },
  };
  if (input.kitchenId) qcFilter.kitchenId = input.kitchenId;

  const qcPass = await db.collection(QC_RESULTS_COLLECTION)
    .find(qcFilter)
    .project({ requirementId: 1, programId: 1, updatedAt: 1, createdAt: 1 })
    .limit(2000)
    .toArray();

  const evidenceByReq = new Map<string, Date>();
  for (const q of qcPass) {
    const rid = String(q.requirementId || '').trim();
    if (!rid) continue;
    const at = q.updatedAt instanceof Date
      ? q.updatedAt
      : q.createdAt instanceof Date
        ? q.createdAt
        : new Date(0);
    const prev = evidenceByReq.get(rid);
    if (!prev || at > prev) evidenceByReq.set(rid, at);
  }

  const bgnRequirements: BgnRequirementEvidence[] = bgnReqs.map((r) => {
    const at = evidenceByReq.get(r.id);
    const meta = resolvePrpMeta(r.kode);
    const group = r.requirementGroup || meta?.requirementGroup;
    return {
      requirementId: r.id,
      programId: r.programId,
      programKode: programById.get(r.programId)?.kode || r.programKode,
      kode: r.kode,
      nama: r.nama,
      sourceRef: r.sourceRef,
      requirementGroup: group,
      bgnCode: r.bgnCode || meta?.bgnCode,
      hasEvidence: Boolean(at),
      lastEvidenceAt: at ? at.toISOString() : undefined,
      href: buildPrpSetupHref({ group, requirementId: r.id }),
    };
  });

  const bgnCovered = bgnRequirements.filter((r) => r.hasEvidence).length;
  const bgnTotal = bgnRequirements.length;
  const bgnStatus = pillarFromCounts({
    evidenceCount: bgnCovered,
    requiredCount: bgnTotal,
  });

  const activePlan = await db.collection(HACCP_PLANS_COLLECTION).findOne({
    tenantId: input.tenantId,
    status: 'ACTIVE',
  }) as HaccpPlanDoc | null;
  const planStatus: AuditReadinessStatus = activePlan ? 'READY' : 'NOT_READY';

  const verFilter: Record<string, unknown> = {
    tenantId: input.tenantId,
    status: 'COMPLETED',
    verificationType: { $in: ['VALIDATION', 'PLAN'] },
    verifiedAt: { $gte: since },
  };
  const verCount = await db.collection(HACCP_VERIFICATIONS_COLLECTION).countDocuments(verFilter);
  const validationOk = hasHaccpPlanValidation(activePlan) || verCount > 0;
  const verStatus: AuditReadinessStatus = validationOk ? 'READY' : 'NOT_READY';
  const trainingOk = hasHaccpTrainingEvidence(activePlan);
  const trainingStatus: AuditReadinessStatus = trainingOk ? 'READY' : 'NOT_READY';

  const holdFilter: Record<string, unknown> = {
    tenantId: input.tenantId,
    foodSafetyStatus: 'HOLD',
  };
  if (input.kitchenId) holdFilter.kitchenId = input.kitchenId;
  const holdCount = await db.collection(PRODUCTION_BATCHES_COLLECTION).countDocuments(holdFilter);
  // HOLD terbuka = belum siap penuh; 0 HOLD = READY untuk pilar disposisi.
  const holdStatus: AuditReadinessStatus = holdCount === 0 ? 'READY' : 'PARTIAL';

  const haccpFailFilter: Record<string, unknown> = {
    tenantId: input.tenantId,
    disposition: 'FAIL',
    updatedAt: { $gte: since },
  };
  if (input.kitchenId) haccpFailFilter.kitchenId = input.kitchenId;
  const failCount = await db.collection(HACCP_RESULTS_COLLECTION).countDocuments(haccpFailFilter);
  const failStatus: AuditReadinessStatus = failCount === 0 ? 'READY' : 'PARTIAL';

  const planId = activePlan?.id;
  const pillarHref = (key: string) => auditPillarHref(key, { planId });

  const pillars: AuditReadinessPillar[] = [
    {
      key: 'bgn_prp',
      label: 'Prasyarat (PRP)',
      status: bgnStatus,
      detail: `${bgnCovered}/${bgnTotal} item prasyarat punya bukti checklist lolos dalam ${lookbackDays} hari`,
      evidenceCount: bgnCovered,
      requiredCount: bgnTotal,
      href: pillarHref('bgn_prp'),
    },
    {
      key: 'haccp_plan',
      label: 'Rencana HACCP aktif',
      status: planStatus,
      detail: activePlan
        ? `Rencana aktif: ${activePlan.kode || activePlan.id}`
        : 'Belum ada rencana HACCP yang aktif',
      evidenceCount: activePlan ? 1 : 0,
      requiredCount: 1,
      href: pillarHref('haccp_plan'),
    },
    {
      key: 'haccp_verification',
      label: 'Validasi rencana',
      status: verStatus,
      detail: validationOk
        ? (activePlan?.validatedAt
          ? 'Rencana sudah divalidasi di dapur'
          : `${verCount} catatan validasi/verifikasi plan selesai dalam ${lookbackDays} hari`)
        : 'Belum ada validasi rencana — isi langkah Cek & pelatihan',
      evidenceCount: validationOk ? 1 : 0,
      requiredCount: 1,
      href: pillarHref('haccp_verification'),
    },
    {
      key: 'haccp_training',
      label: 'Bukti pelatihan',
      status: trainingStatus,
      detail: trainingOk
        ? 'Ada catatan atau foto briefing/sertifikat'
        : 'Belum ada bukti pelatihan — unggah di langkah Cek & pelatihan',
      evidenceCount: trainingOk ? 1 : 0,
      requiredCount: 1,
      href: pillarHref('haccp_training'),
    },
    {
      key: 'open_holds',
      label: 'Batch ditahan',
      status: holdStatus,
      detail: holdCount === 0
        ? 'Tidak ada batch ditahan'
        : `${holdCount} batch masih ditahan — selesaikan perbaikan dulu`,
      evidenceCount: holdCount === 0 ? 1 : 0,
      requiredCount: 1,
      href: pillarHref('open_holds'),
    },
    {
      key: 'haccp_fail_window',
      label: 'Catatan CCP gagal',
      status: failStatus,
      detail: failCount === 0
        ? `Tidak ada catatan CCP gagal dalam ${lookbackDays} hari`
        : `${failCount} catatan gagal — tinjau di Operasi lalu selesaikan Temuan`,
      evidenceCount: failCount === 0 ? 1 : 0,
      requiredCount: 1,
      href: pillarHref('haccp_fail_window'),
    },
  ];

  return {
    status: aggregateReadinessStatus(pillars),
    asOf,
    lookbackDays,
    pillars,
    bgnRequirements,
    disclaimer:
      'Status kesiapan audit adalah agregasi evidence operasional, bukan sertifikasi. '
      + 'Konten HACCP & batas kritis wajib divalidasi pihak berkompeten.',
  };
}
