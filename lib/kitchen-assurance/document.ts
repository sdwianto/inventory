/**
 * Kitchen Assurance document helpers — ADR-002 Phase 0.
 * Pure / client-safe — no Mongo imports. Separate from FP_DOC_TYPES.
 */

export const KA_DOC_TYPES = {
  POLICY: 'KA_POL',
  OBSERVATION: 'KA_OBS',
  SAFETY_CASE: 'KA_SCF',
  FOLLOW_UP: 'KA_KFU',
} as const;

export type KaDocType = (typeof KA_DOC_TYPES)[keyof typeof KA_DOC_TYPES];

export const KA_DOC_PREFIX: Record<KaDocType, string> = {
  KA_POL: 'POL',
  KA_OBS: 'OBS',
  KA_SCF: 'SCF',
  KA_KFU: 'KFU',
};

export interface KaDocHistoryEntry {
  at: Date | string;
  fromStatus: string | null;
  toStatus: string;
  userId?: string;
  userName?: string;
  note?: string;
}

export function assertKaStatusTransition(
  from: string,
  to: string,
  allowed: Record<string, string[]>,
): string | null {
  if (from === to) return null;
  const next = allowed[from];
  if (!next || !next.includes(to)) {
    return `Status tidak boleh dari ${from} ke ${to}`;
  }
  return null;
}

export function appendKaHistory(
  history: KaDocHistoryEntry[] | null | undefined,
  entry: KaDocHistoryEntry,
): KaDocHistoryEntry[] {
  return [...(history || []), entry];
}
