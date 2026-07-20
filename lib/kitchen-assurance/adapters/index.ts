/** Phase 0 monitoring adapters — Capability → Policy → Adapter. */

import type { Db } from 'mongodb';
import { createColdChainAdapter } from '@/lib/kitchen-assurance/adapters/cold-chain';
import { createCleaningAdapter } from '@/lib/kitchen-assurance/adapters/cleaning';
import { createEquipmentInspectionAdapter } from '@/lib/kitchen-assurance/adapters/equipment-inspection';
import { createQualityComplaintAdapter } from '@/lib/kitchen-assurance/adapters/quality-complaint';
import type { KaPolicyDoc } from '@/lib/kitchen-assurance/policy';
import type {
  KitchenScope,
  MonitoringAdapter,
  MonitoringSignal,
} from '@/lib/kitchen-assurance/monitoring';
import { phase0Capabilities } from '@/lib/kitchen-assurance/capability-registry';

export function buildPhase0Adapters(db: Db): MonitoringAdapter[] {
  return [
    createColdChainAdapter(db),
    createCleaningAdapter(),
    createEquipmentInspectionAdapter(db),
    createQualityComplaintAdapter(),
  ];
}

export async function collectPhase0Signals(
  db: Db,
  scope: KitchenScope,
  policies: KaPolicyDoc[],
): Promise<MonitoringSignal[]> {
  const enabled = new Set(phase0Capabilities().map((c) => c.id));
  const adapters = buildPhase0Adapters(db);
  const out: MonitoringSignal[] = [];
  for (const adapter of adapters) {
    if (!enabled.has(adapter.capabilityId)) continue;
    out.push(...(await adapter.listSignals(scope, policies)));
  }
  return out;
}
