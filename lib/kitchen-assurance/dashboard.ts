/**
 * Kitchen Status dashboard — ADR-002 P1.
 * Traffic lights per pillar (not weighted health index).
 */

import type {
  KaAttentionItem,
  KaKitchenStatusPillar,
  KaPillarTraffic,
} from '@/lib/kitchen-assurance/attention';
import { KA_PILLARS, KA_PILLAR_LABELS, type KaPillar } from '@/lib/kitchen-assurance/categories';

export type { KaKitchenStatusPillar, KaPillarTraffic };

export interface KaDashboardSnapshot {
  generatedAt: string;
  kitchenId?: string;
  /** Ordered Food → People → Operational → Equipment */
  pillars: KaKitchenStatusPillar[];
  attentions: KaAttentionItem[];
  allClear: boolean;
  openCases: number;
  openFollowUps: number;
}

export function emptyKitchenStatus(): KaKitchenStatusPillar[] {
  return KA_PILLARS.map((pillar) => ({
    pillar,
    label: KA_PILLAR_LABELS[pillar],
    traffic: 'GREEN' as const,
    attentionCount: 0,
    items: [],
  }));
}

export function trafficEmoji(t: KaPillarTraffic): string {
  if (t === 'GREEN') return '🟢';
  if (t === 'YELLOW') return '🟡';
  return '🔴';
}

/** Human label — Equipment uses Ready / Attention / Unsafe vocabulary. */
export function trafficLabel(t: KaPillarTraffic, pillar?: KaPillar): string {
  if (pillar === 'EQUIPMENT') {
    if (t === 'GREEN') return 'Ready';
    if (t === 'YELLOW') return 'Attention';
    return 'Unsafe';
  }
  if (t === 'GREEN') return 'Aman';
  if (t === 'YELLOW') return 'Perhatian';
  return 'Kritis';
}

export type { KaPillar };
