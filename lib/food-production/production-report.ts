/**
 * Production Report — ADR-001 Phase 2.
 * Agregat Plan + Issue + Result. Cooking = status turun dari PBL/HSL (bukan dokumen terpisah).
 */

import { planCompleteGateMessage } from '@/lib/food-production/production-result';
import { roundQty } from '@/lib/food-production/material-requirement';

export type CookingPhase = 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE';

export interface ProductionReportInput {
  plan: {
    id: string;
    noDokumen: string;
    tanggal: string;
    status: string;
    kitchenNama?: string;
    warehouseKode?: string;
    totalTargetPorsi?: number;
  };
  issue?: {
    id: string;
    noDokumen: string;
    status: string;
    qtyIssuedTotal?: number;
    lineCount?: number;
    stockPostedAt?: Date | string | null;
  } | null;
  result?: {
    id: string;
    noDokumen: string;
    status: string;
    targetPorsiTotal?: number;
    actualPorsiTotal?: number;
    wastePorsiTotal?: number;
    lineCount?: number;
    stockPostedAt?: Date | string | null;
  } | null;
  hasCompletedIssue: boolean;
  hasOpenIssue: boolean;
  hasCompletedResult: boolean;
  hasOpenResult: boolean;
}

export interface ProductionReport {
  plan: ProductionReportInput['plan'];
  issue: ProductionReportInput['issue'];
  result: ProductionReportInput['result'];
  cooking: {
    phase: CookingPhase;
    label: string;
    note: string;
  };
  integrity: {
    canCompletePlan: boolean;
    message: string | null;
    hasCompletedIssue: boolean;
    hasOpenIssue: boolean;
    hasCompletedResult: boolean;
    hasOpenResult: boolean;
  };
  summary: {
    targetPorsi: number;
    actualPorsi: number;
    wastePorsi: number;
    qtyIssuedTotal: number;
    yieldPct: number | null;
  };
}

export function cookingPhaseOf(input: {
  hasCompletedIssue: boolean;
  hasCompletedResult: boolean;
  /** Status rencana — COMPLETED menutup cooking meski HSL belum ada. */
  planStatus?: string;
}): { phase: CookingPhase; label: string; note: string } {
  const planDone = String(input.planStatus || '').toUpperCase() === 'COMPLETED';
  const planProcessing = String(input.planStatus || '').toUpperCase() === 'PROCESSING';

  if (input.hasCompletedResult || planDone) {
    return {
      phase: 'DONE',
      label: 'Selesai dimasak',
      note: input.hasCompletedResult
        ? 'Hasil produksi (HSL) sudah diposting — siklus dapur tertutup untuk dokumen ini.'
        : 'Rencana produksi sudah selesai — cooking ditutup mengikuti status rencana.',
    };
  }
  if (input.hasCompletedIssue || planProcessing) {
    return {
      phase: 'IN_PROGRESS',
      label: 'Sedang dimasak',
      note: planProcessing
        ? 'Rencana sedang diproses. Cooking berjalan hingga rencana selesai atau HSL diposting.'
        : 'Bahan sudah diambil (PBL selesai). Cooking dicatat via status rencana PROCESSING hingga selesai — tanpa dokumen Cooking terpisah.',
    };
  }
  return {
    phase: 'NOT_STARTED',
    label: 'Belum mulai',
    note: 'Belum ada pengambilan bahan selesai. Mulai dari PBL setelah rencana disetujui.',
  };
}

export function buildProductionReport(input: ProductionReportInput): ProductionReport {
  const gateMsg = planCompleteGateMessage({
    hasCompletedIssue: input.hasCompletedIssue,
    hasOpenIssue: input.hasOpenIssue,
    hasOpenResult: input.hasOpenResult,
    hasCompletedResult: input.hasCompletedResult,
  });
  const cooking = cookingPhaseOf({
    hasCompletedIssue: input.hasCompletedIssue,
    hasCompletedResult: input.hasCompletedResult,
    planStatus: input.plan.status,
  });
  const targetPorsi = roundQty(
    Number(input.result?.targetPorsiTotal ?? input.plan.totalTargetPorsi ?? 0),
  );
  const actualPorsi = roundQty(Number(input.result?.actualPorsiTotal ?? 0));
  const wastePorsi = roundQty(Number(input.result?.wastePorsiTotal ?? 0));
  const qtyIssuedTotal = roundQty(Number(input.issue?.qtyIssuedTotal ?? 0));
  const yieldPct = targetPorsi > 0 ? roundQty((actualPorsi / targetPorsi) * 100) : null;

  return {
    plan: input.plan,
    issue: input.issue || null,
    result: input.result || null,
    cooking,
    integrity: {
      canCompletePlan: gateMsg == null,
      message: gateMsg,
      hasCompletedIssue: input.hasCompletedIssue,
      hasOpenIssue: input.hasOpenIssue,
      hasCompletedResult: input.hasCompletedResult,
      hasOpenResult: input.hasOpenResult,
    },
    summary: {
      targetPorsi,
      actualPorsi,
      wastePorsi,
      qtyIssuedTotal,
      yieldPct,
    },
  };
}
