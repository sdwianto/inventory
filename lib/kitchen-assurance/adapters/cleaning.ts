/**
 * Cleaning adapter — KA-owned stub (Phase 0).
 * Returns WATCH placeholder until cleaning schedules are recorded (P1).
 */

import type { KaPolicyDoc } from '@/lib/kitchen-assurance/policy';
import type {
  KitchenScope,
  MonitoringAdapter,
  MonitoringSignal,
} from '@/lib/kitchen-assurance/monitoring';

const CAPABILITY_ID = 'cleaning';

export function createCleaningAdapter(): MonitoringAdapter {
  return {
    capabilityId: CAPABILITY_ID,
    async listSignals(_scope: KitchenScope, policies: KaPolicyDoc[]): Promise<MonitoringSignal[]> {
      const policy = policies.find((p) => p.capabilityId === CAPABILITY_ID && p.aktif);
      const every = policy?.rules?.everyHours ?? 4;
      return [
        {
          capabilityId: CAPABILITY_ID,
          category: 'OPERATION',
          kind: 'CHECKLIST',
          key: 'cleaning:schedule',
          label: `Cleaning — jadwal setiap ${every} jam (belum diaktifkan)`,
          status: 'OK',
          href: '/kitchen-assurance/monitoring',
          severity: policy?.rules?.severity,
          meta: { stub: true, everyHours: every },
        },
      ];
    },
  };
}
