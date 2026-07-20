/**
 * Quality complaint / recall adapter — Phase 0 stub (owner: Quality).
 * Returns OK placeholder until Quality module owns real complaint events.
 */

import type { KaPolicyDoc } from '@/lib/kitchen-assurance/policy';
import type {
  KitchenScope,
  MonitoringAdapter,
  MonitoringSignal,
} from '@/lib/kitchen-assurance/monitoring';

const CAPABILITY_ID = 'quality-complaint';

export function createQualityComplaintAdapter(): MonitoringAdapter {
  return {
    capabilityId: CAPABILITY_ID,
    async listSignals(_scope: KitchenScope, policies: KaPolicyDoc[]): Promise<MonitoringSignal[]> {
      const policy = policies.find((p) => p.capabilityId === CAPABILITY_ID && p.aktif);
      return [
        {
          capabilityId: CAPABILITY_ID,
          category: 'FOOD',
          kind: 'EVENT',
          key: 'quality-complaint:stub',
          label: 'Food Complaint / Recall — belum ada event (Quality stub)',
          status: 'OK',
          href: '/kitchen-assurance/cases',
          severity: policy?.rules?.severity,
          meta: { stub: true, owner: 'QUALITY' },
        },
      ];
    },
  };
}
