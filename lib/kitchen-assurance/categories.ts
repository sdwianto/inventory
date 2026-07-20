/**
 * Kitchen Assurance pillars — ADR-002 final.
 * COMPLIANCE kept only for legacy stored docs; not a UI pillar.
 */

/** Dashboard / Monitoring order — Food first (MBG). */
export const KA_PILLARS = ['FOOD', 'PEOPLE', 'OPERATION', 'EQUIPMENT'] as const;

export type KaPillar = (typeof KA_PILLARS)[number];

/** @deprecated Use KaPillar. Includes legacy COMPLIANCE. */
export const KA_CATEGORIES = [...KA_PILLARS, 'COMPLIANCE'] as const;

export type KaCategory = (typeof KA_CATEGORIES)[number];

export const KA_PILLAR_LABELS: Record<KaPillar, string> = {
  FOOD: 'Food Safety',
  PEOPLE: 'People Safety',
  OPERATION: 'Operational Safety',
  EQUIPMENT: 'Equipment Safety',
};

/** @deprecated Prefer KA_PILLAR_LABELS */
export const KA_CATEGORY_LABELS: Record<KaCategory, string> = {
  ...KA_PILLAR_LABELS,
  COMPLIANCE: 'Compliance',
};

export function normalizeKaCategory(raw: unknown): KaCategory | { error: string } {
  const v = String(raw || '').toUpperCase();
  if ((KA_CATEGORIES as readonly string[]).includes(v)) return v as KaCategory;
  return { error: 'category wajib FOOD | PEOPLE | OPERATION | EQUIPMENT' };
}

export function toPillar(category: string | undefined): KaPillar {
  const v = String(category || '').toUpperCase();
  if (v === 'PEOPLE') return 'PEOPLE';
  if (v === 'OPERATION' || v === 'COMPLIANCE') return 'OPERATION';
  if (v === 'EQUIPMENT') return 'EQUIPMENT';
  return 'FOOD';
}
