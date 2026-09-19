/**
 * Handoff Perencanaan Menu ↔ RPN (tanpa rework komposisi).
 */

import { weekStartFrom } from '@/lib/food-production/weekly-menu-plan';

export const ADHOC_CATATAN_PREFIX = 'ADHOC:';
export const ADHOC_REASON_MIN = 8;
export const WEEKLY_LINKED_COMPOSITION_LOCKED =
  'Komposisi RPN dari papan minggu tidak diubah di sini.';

export type FpFlowStep = 'menu' | 'approve' | 'fulfill' | 'result';

export function isWeeklyLinkedPlan(row: {
  weeklyMenuPlanId?: string | null;
  status?: string;
}): boolean {
  const id = String(row.weeklyMenuPlanId || '').trim();
  if (!id) return false;
  return String(row.status || '').trim() !== 'CANCELLED';
}

export function menuPlanHref(input: {
  kitchenId?: string | null;
  tanggal: string;
}): string {
  const params = new URLSearchParams();
  const start = weekStartFrom(input.tanggal);
  if (typeof start === 'string') params.set('weekStart', start);
  const kitchenId = String(input.kitchenId || '').trim();
  if (kitchenId) params.set('kitchenId', kitchenId);
  const q = params.toString();
  return q ? `/food-production/menu-plan?${q}` : '/food-production/menu-plan';
}

export function planHref(input: {
  productionPlanId?: string | null;
  tanggal?: string | null;
}): string {
  const params = new URLSearchParams();
  const id = String(input.productionPlanId || '').trim();
  const tanggal = String(input.tanggal || '').trim();
  if (id) params.set('productionPlanId', id);
  if (tanggal) params.set('tanggal', tanggal);
  const q = params.toString();
  return q ? `/food-production/plan?${q}` : '/food-production/plan';
}

export function fpFlowStepForPlanStatus(status?: string): FpFlowStep {
  const st = String(status || '').trim();
  if (st === 'COMPLETED') return 'result';
  if (st === 'APPROVED' || st === 'PROCESSING') return 'fulfill';
  return 'approve';
}

export function isAdHocReasonValid(reason: string): boolean {
  return String(reason || '').trim().length >= ADHOC_REASON_MIN;
}

/** Change order: buka kunci papan tanpa menghapus jejak persetujuan. */
export const MENU_REVISE_REASON_MIN = ADHOC_REASON_MIN;
export const MENU_REVISE_NOTE_PREFIX = 'REVISI MENU:';
export const WEEKLY_MENU_PUBLISH_NOTE = 'Diperbarui dari perencanaan menu mingguan';
export const MENU_REVISE_REPUBLISH_REQUIRED =
  'Menu hasil revisi belum diterbitkan ulang dari Perencanaan Menu. Terbitkan hari ini dulu, baru setujui.';
export const MENU_REVISE_DRAFT_REVERT_BLOCKED =
  'RPN dari papan yang sudah pernah disetujui tidak dikembalikan ke Draft. Terbitkan dan setujui ulang, atau batalkan.';

export function canReviseApprovedMenu(status?: string | null): boolean {
  return String(status || '').trim() === 'APPROVED';
}

export function reviseMenuReasonError(reason: unknown): string | null {
  const trimmed = String(reason || '').trim();
  if (trimmed.length < MENU_REVISE_REASON_MIN) {
    return `Alasan revisi minimal ${MENU_REVISE_REASON_MIN} karakter`;
  }
  return null;
}

export function formatMenuReviseHistoryNote(reason: string): string {
  const trimmed = String(reason || '').trim();
  if (!trimmed) return MENU_REVISE_NOTE_PREFIX;
  if (trimmed.toUpperCase().startsWith(MENU_REVISE_NOTE_PREFIX)) return trimmed;
  return `${MENU_REVISE_NOTE_PREFIX} ${trimmed}`;
}

export function isMenuReviseHistoryNote(note?: string | null): boolean {
  return String(note || '').trim().toUpperCase().startsWith(MENU_REVISE_NOTE_PREFIX);
}

export function reviseMenuKitchenScopeError(
  planKitchenId?: string | null,
  actingKitchenId?: string | null,
): string | null {
  const acting = String(actingKitchenId || '').trim();
  if (!acting) return null;
  if (String(planKitchenId || '').trim() !== acting) {
    return 'RPN bukan milik dapur yang sedang dipilih';
  }
  return null;
}

/** Stok sudah/sedang keluar atau hasil sudah tercatat — jangan buka papan. */
export function reviseMenuOperationalBlockError(input: {
  status?: string | null;
  issueNo?: string | null;
  resultNo?: string | null;
}): string | null {
  if (!canReviseApprovedMenu(input.status)) {
    const st = String(input.status || '').trim() || '—';
    return `Revisi menu hanya untuk RPN Disetujui (status sekarang ${st})`;
  }
  const issueNo = String(input.issueNo || '').trim();
  if (issueNo) {
    return `Tidak bisa revisi menu — bahan sudah/sedang dikeluarkan (${issueNo}).`;
  }
  const resultNo = String(input.resultNo || '').trim();
  if (resultNo) {
    return `Tidak bisa revisi menu — hasil produksi sudah tercatat (${resultNo}).`;
  }
  return null;
}

type HistoryLite = {
  fromStatus?: string | null;
  toStatus?: string | null;
  note?: string | null;
};

/** True sampai papan menerbitkan ulang setelah change order. */
export function menuReviseNeedsRepublish(history?: HistoryLite[] | null): boolean {
  if (!history?.length) return false;
  let pending = false;
  for (const entry of history) {
    const note = String(entry.note || '').trim();
    if (
      isMenuReviseHistoryNote(note)
      && String(entry.fromStatus || '') === 'APPROVED'
      && String(entry.toStatus || '') === 'SUBMITTED'
    ) {
      pending = true;
      continue;
    }
    if (pending && note === WEEKLY_MENU_PUBLISH_NOTE) {
      pending = false;
    }
  }
  return pending;
}

export function weeklyLinkedDraftRevertError(plan: {
  weeklyMenuPlanId?: string | null;
  status?: string;
  history?: HistoryLite[] | null;
}): string | null {
  if (!isWeeklyLinkedPlan(plan)) return null;
  const everApproved = (plan.history || []).some((h) => String(h.toStatus || '') === 'APPROVED');
  if (!everApproved) return null;
  return MENU_REVISE_DRAFT_REVERT_BLOCKED;
}

export type ReviseMenuProcureImpact = {
  mrpNo?: string | null;
  mrpStatus?: string | null;
  prNo?: string | null;
  prStatus?: string | null;
  poNo?: string | null;
  poStatus?: string | null;
};

/** Selaras decideMrpRegenerateMode / mrpRegenerateBlockers (DRAFT PR ikut memblokir). */
const PR_BLOCKS_MRP_REGEN = new Set(['DRAFT', 'SUBMITTED', 'APPROVED', 'PROCESSING']);
const PO_RECREATABLE = new Set(['DRAFT', 'PENDING_APPROVAL', 'REJECTED']);

/** Copy peringatan pengadaan untuk dialog revisi (tidak mengubah dokumen). */
export function reviseMenuProcureWarningLines(impact: ReviseMenuProcureImpact): string[] {
  const lines: string[] = [];
  const mrpNo = String(impact.mrpNo || '').trim();
  const prNo = String(impact.prNo || '').trim();
  const poNo = String(impact.poNo || '').trim();
  if (mrpNo) {
    const st = String(impact.mrpStatus || '').trim();
    if (st === 'DRAFT' || st === 'SUBMITTED') {
      lines.push(`MRP ${mrpNo} (${st}) — hitung ulang (recalculate) setelah setujui ulang.`);
    } else if (st === 'APPROVED') {
      lines.push(
        `MRP ${mrpNo} (APPROVED) — supersede MRP baru setelah setujui ulang jika PR tidak memblokir.`,
      );
    } else {
      lines.push(
        `MRP ${mrpNo}${st ? ` (${st})` : ''} — tidak dihitung ulang otomatis; cek kebutuhan beli manual.`,
      );
    }
  }
  if (prNo) {
    const st = String(impact.prStatus || '').trim();
    if (PR_BLOCKS_MRP_REGEN.has(st)) {
      lines.push(
        `PR ${prNo}${st ? ` (${st})` : ''} aktif — regen MRP terblokir sampai PR dibatalkan.`,
      );
    } else {
      lines.push(
        `PR ${prNo}${st ? ` (${st})` : ''} — tidak diubah otomatis; buat PR susulan bila kurang.`,
      );
    }
  }
  if (poNo) {
    const st = String(impact.poStatus || '').trim();
    if (!st || PO_RECREATABLE.has(st)) {
      lines.push(`PO ${poNo}${st ? ` (${st})` : ''} masih draft — boleh dibuat ulang setelah PR baru.`);
    } else {
      lines.push(
        `PO ${poNo} (${st}) sudah jalan — tidak diubah otomatis; buat PR/PO susulan atau amandemen manual.`,
      );
    }
  }
  if (!lines.length) {
    lines.push(
      'Belum ada MRP/PR/PO terkait. Setelah menu diubah, terbitkan dan setujui ulang lalu hitung kebutuhan beli.',
    );
  }
  return lines;
}

export function isAdHocCatatan(value: string | null | undefined): boolean {
  return String(value || '').trim().toUpperCase().startsWith(ADHOC_CATATAN_PREFIX);
}

export function formatAdHocCatatan(reason: string): string {
  let trimmed = String(reason || '').trim();
  if (!trimmed) return '';
  if (trimmed.toUpperCase().startsWith(ADHOC_CATATAN_PREFIX)) {
    trimmed = trimmed.slice(ADHOC_CATATAN_PREFIX.length).trim();
  }
  if (!trimmed) return '';
  return `${ADHOC_CATATAN_PREFIX} ${trimmed}`;
}

export function adHocCreateBlockedError(plan: {
  noDokumen?: string;
} | null | undefined): string | null {
  if (!plan) return null;
  const no = String(plan.noDokumen || '').trim() || 'RPN';
  return `Hari ini sudah diterbitkan dari Perencanaan Menu (${no}). Ubah di papan, atau batalkan RPN itu dulu.`;
}

export function productionPlanBodyTouchesComposition(body: {
  tanggal?: unknown;
  kitchenId?: unknown;
  lines?: unknown;
  kategoriPorsiList?: unknown;
  kategoriPorsi?: unknown;
}): boolean {
  return body.tanggal !== undefined
    || body.kitchenId !== undefined
    || body.lines !== undefined
    || body.kategoriPorsiList !== undefined
    || body.kategoriPorsi !== undefined;
}

export function weeklyLinkedCompositionLockedError(
  linked: boolean,
  touchesComposition: boolean,
): string | null {
  if (!linked || !touchesComposition) return null;
  return WEEKLY_LINKED_COMPOSITION_LOCKED;
}

export function activeWeeklyLinkedPlanQuery(kitchenId: string, tanggal: string) {
  return {
    kitchenId,
    tanggal,
    weeklyMenuPlanId: { $exists: true, $nin: [null, ''] },
    status: { $ne: 'CANCELLED' },
  };
}
