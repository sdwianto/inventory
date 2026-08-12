/**
 * ADR-004 P0G — pra-validasi jalur keluar sebelum mutasi stok.
 * Filter FEFO saja tidak cukup: stok buku bisa terposting sementara batch HOLD
 * dilewati → shortfall diam. Gate ini menggagalkan dokumen lebih dulu.
 */

import type { ClientSession, Db } from 'mongodb';
import {
  PRODUCTION_BATCHES_COLLECTION,
  effectiveFoodSafetyStatus,
  effectiveQtyRemaining,
  type ProductionBatchDoc,
} from '@/lib/food-production/production-batch';
import { allocateFefo } from '@/lib/food-production/fefo-allocate';

export type FefoExitGateLine = {
  stokId: string;
  stokNama?: string;
  warehouseKode: string;
  needQty: number;
  /** W2-2: batasi ke batch HSL terkait. */
  productionResultId?: string;
};

export type FefoExitGateOk = { ok: true };
export type FefoExitGateBlocked = {
  ok: false;
  error: string;
  stokId?: string;
  heldBatchNos?: string[];
  availableQty?: number;
  heldQty?: number;
  needQty?: number;
};
export type FefoExitGateResult = FefoExitGateOk | FefoExitGateBlocked;

function txOpts(session?: ClientSession | null) {
  return session ? { session } : {};
}

export function buildFoodSafetyHoldBlockMessage(input: {
  stokNama?: string;
  stokId: string;
  needQty: number;
  availableQty: number;
  heldQty: number;
  heldBatchNos: string[];
  context?: 'distribusi' | 'release' | 'transfer';
}): string {
  const label = input.stokNama?.trim() || input.stokId;
  const batches = input.heldBatchNos.length
    ? input.heldBatchNos.slice(0, 5).join(', ') + (input.heldBatchNos.length > 5 ? '…' : '')
    : '—';
  const ctx = input.context === 'transfer'
    ? 'transfer'
    : input.context === 'release'
      ? 'release'
      : 'distribusi';
  return (
    `Stok ditahan karena food safety (HOLD). `
    + `${label}: dibutuhkan ${input.needQty}, tersedia aman ${input.availableQty}, `
    + `tertahan ${input.heldQty} (batch ${batches}). `
    + `Lepas HOLD setelah verifikasi koreksi sebelum ${ctx}.`
  );
}

/**
 * Cek satu baris: apakah needQty bisa dipenuhi dari batch non-HOLD.
 * Legacy tanpa baris production_batches → lolos (bukan jalur FEFO).
 */
export async function checkFefoExitLineAgainstHold(
  db: Db,
  input: {
    tenantId: string;
    line: FefoExitGateLine;
    asOf?: Date;
    allowExpired?: boolean;
  },
  session?: ClientSession | null,
): Promise<FefoExitGateResult> {
  const needQty = Number(input.line.needQty);
  if (!(needQty > 0) || !input.line.stokId || !input.line.warehouseKode) {
    return { ok: true };
  }

  const filter: Record<string, unknown> = {
    tenantId: input.tenantId,
    finishedGoodProductId: input.line.stokId,
    warehouseKode: input.line.warehouseKode,
    status: { $in: ['ACTIVE', 'EXPIRED'] },
  };
  if (input.line.productionResultId) {
    filter.productionResultId = input.line.productionResultId;
  }

  const rows = await db
    .collection(PRODUCTION_BATCHES_COLLECTION)
    .find(filter, txOpts(session))
    .sort({ expiryDate: 1 })
    .toArray() as unknown as ProductionBatchDoc[];

  if (!rows.length) return { ok: true };

  const held: ProductionBatchDoc[] = [];
  const safe: ProductionBatchDoc[] = [];
  for (const b of rows) {
    if (effectiveFoodSafetyStatus(b) === 'HOLD') held.push(b);
    else safe.push(b);
  }

  const heldQty = held.reduce((s, b) => s + effectiveQtyRemaining(b), 0);
  if (!(heldQty > 0)) return { ok: true };

  const candidates = safe.map((b) => ({
    id: b.id,
    batchNo: b.batchNo,
    expiryDate: b.expiryDate,
    qtyRemaining: effectiveQtyRemaining(b),
    status: b.status,
    foodSafetyStatus: effectiveFoodSafetyStatus(b),
  }));

  const plan = allocateFefo(needQty, candidates, {
    asOf: input.asOf ?? new Date(),
    allowExpired: input.allowExpired,
    rejectFoodSafetyHold: true,
  });

  if (plan.shortfall <= 0) return { ok: true };

  const heldBatchNos = held
    .filter((b) => effectiveQtyRemaining(b) > 0)
    .map((b) => b.batchNo || b.id);

  return {
    ok: false,
    error: buildFoodSafetyHoldBlockMessage({
      stokId: input.line.stokId,
      stokNama: input.line.stokNama,
      needQty,
      availableQty: plan.allocated,
      heldQty,
      heldBatchNos,
    }),
    stokId: input.line.stokId,
    heldBatchNos,
    availableQty: plan.allocated,
    heldQty,
    needQty,
  };
}

/** Semua baris harus lolos; pesan memakai baris pertama yang gagal. */
export async function assertFefoExitNotBlockedByHold(
  db: Db,
  input: {
    tenantId: string;
    lines: FefoExitGateLine[];
    enforce: boolean;
    asOf?: Date;
    allowExpired?: boolean;
    context?: 'distribusi' | 'release' | 'transfer';
  },
  session?: ClientSession | null,
): Promise<FefoExitGateResult> {
  if (!input.enforce) return { ok: true };

  for (const line of input.lines) {
    const checked = await checkFefoExitLineAgainstHold(
      db,
      {
        tenantId: input.tenantId,
        line,
        asOf: input.asOf,
        allowExpired: input.allowExpired,
      },
      session,
    );
    if (!checked.ok) {
      return {
        ...checked,
        error: buildFoodSafetyHoldBlockMessage({
          stokId: checked.stokId || line.stokId,
          stokNama: line.stokNama,
          needQty: checked.needQty ?? line.needQty,
          availableQty: checked.availableQty ?? 0,
          heldQty: checked.heldQty ?? 0,
          heldBatchNos: checked.heldBatchNos || [],
          context: input.context,
        }),
      };
    }
  }
  return { ok: true };
}

/**
 * Pertahanan di dalam TX: bila FEFO shortfall setelah filter HOLD,
 * pastikan bukan karena stok tertahan (race / bypass pra-gate).
 */
export async function assertConsumeShortfallNotDueToHold(
  db: Db,
  input: {
    tenantId: string;
    line: FefoExitGateLine;
    enforce: boolean;
    shortfall: number;
    skippedNoBatches: boolean;
    asOf?: Date;
    allowExpired?: boolean;
    context?: 'distribusi' | 'release' | 'transfer';
  },
  session?: ClientSession | null,
): Promise<FefoExitGateResult> {
  if (!input.enforce) return { ok: true };
  if (!(input.shortfall > 0) || input.skippedNoBatches) return { ok: true };
  return assertFefoExitNotBlockedByHold(
    db,
    {
      tenantId: input.tenantId,
      lines: [input.line],
      enforce: true,
      asOf: input.asOf,
      allowExpired: input.allowExpired,
      context: input.context,
    },
    session,
  );
}
