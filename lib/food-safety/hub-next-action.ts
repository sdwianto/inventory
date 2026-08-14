/**
 * Next-CTA priority for Keamanan Pangan hub (Gelombang 0).
 * Priority: Temuan terbuka → Setup belum selesai → Operasi jatuh tempo → Audit partial → default Operasi.
 */

import { countAuditOpenItems } from '@/lib/food-safety/audit-links';

export type FoodSafetyHubMode = 'setup' | 'operasi' | 'temuan' | 'audit';

export type FoodSafetyNextAction = {
  mode: FoodSafetyHubMode;
  title: string;
  description: string;
  href: string;
  tone: 'critical' | 'warning' | 'neutral' | 'ok';
};

export type FoodSafetyHubSignals = {
  openCases: number;
  openFollowUps: number;
  heldBatches: number;
  hasActiveHaccpPlan: boolean;
  haccpPlanDraftId?: string | null;
  haccpPlanProgressPct?: number | null;
  prpCovered?: number | null;
  prpTotal?: number | null;
  /** Pilar non-PRP yang belum READY (verifikasi, HOLD sudah diprioritaskan di atas). */
  extraOpenPillars?: number | null;
  auditStatus?: 'NOT_READY' | 'PARTIAL' | 'READY' | null;
  operasiPendingCount?: number | null;
};

export function resolveFoodSafetyNextAction(
  s: FoodSafetyHubSignals,
): FoodSafetyNextAction {
  const openIssues = (s.openCases || 0) + (s.openFollowUps || 0);
  if ((s.heldBatches || 0) > 0 || openIssues > 0) {
    const holdNote = (s.heldBatches || 0) > 0
      ? `${s.heldBatches} batch ditahan`
      : `${openIssues} perbaikan terbuka`;
    return {
      mode: 'temuan',
      title: 'Selesaikan perbaikan',
      description: `${holdNote}. Upload bukti lalu verifikasi agar batch bisa dilanjutkan.`,
      href: '/kitchen-assurance/temuan',
      tone: 'critical',
    };
  }

  if (!s.hasActiveHaccpPlan) {
    const pct = s.haccpPlanProgressPct;
    const draftHref = s.haccpPlanDraftId
      ? `/food-production/haccp-plan?planId=${encodeURIComponent(s.haccpPlanDraftId)}`
      : '/kitchen-assurance/setup';
    return {
      mode: 'setup',
      title: s.haccpPlanDraftId ? 'Lanjutkan rencana HACCP' : 'Siapkan keamanan pangan',
      description: s.haccpPlanDraftId
        ? `Rencana masih draft${pct != null ? ` (${pct}%)` : ''}. Ikuti panduan langkah demi langkah.`
        : 'Lengkapi checklist prasyarat dan buat rencana HACCP — tidak perlu hafal istilah teknis.',
      href: draftHref,
      tone: 'warning',
    };
  }

  if ((s.operasiPendingCount || 0) > 0 && s.auditStatus === 'READY') {
    return {
      mode: 'operasi',
      title: 'Catat yang wajib hari ini',
      description: `${s.operasiPendingCount} catatan CCP / suhu / prasyarat menunggu.`,
      href: '/kitchen-assurance/operasi',
      tone: 'warning',
    };
  }

  if (s.auditStatus && s.auditStatus !== 'READY') {
    const n = countAuditOpenItems({
      prpCovered: s.prpCovered,
      prpTotal: s.prpTotal,
      extraOpenPillars: s.extraOpenPillars,
    });
    return {
      mode: 'audit',
      title: n > 0 ? `${n} item belum siap audit` : 'Lengkapi kesiapan audit',
      description: n > 0
        ? `${n} item belum siap audit. Buka panel merah, lalu klik untuk memperbaiki.`
        : 'Beberapa bukti prasyarat atau verifikasi masih kurang.',
      href: '/kitchen-assurance/audit',
      tone: 'warning',
    };
  }

  if ((s.operasiPendingCount || 0) > 0) {
    return {
      mode: 'operasi',
      title: 'Catat yang wajib hari ini',
      description: `${s.operasiPendingCount} catatan CCP / suhu / prasyarat menunggu.`,
      href: '/kitchen-assurance/operasi',
      tone: 'warning',
    };
  }

  return {
    mode: 'operasi',
    title: 'Operasi harian',
    description: 'Rencana aktif. Catat pemantauan CCP dan suhu sesuai shift.',
    href: '/kitchen-assurance/operasi',
    tone: 'ok',
  };
}
