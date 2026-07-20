/**
 * Cold Chain adapter — live-read temperature_logs (owner: Food Production).
 * Evaluates against KA Policy when present; falls back to owner alertStatus.
 */

import type { Db } from 'mongodb';
import {
  TEMPERATURE_LOGS_COLLECTION,
  TEMP_STAGE_LABELS,
  type TemperatureLogDoc,
} from '@/lib/food-production/temperature-log';
import type { KaPolicyDoc } from '@/lib/kitchen-assurance/policy';
import {
  evaluateNumericAgainstPolicy,
  mapAlertToSignalStatus,
  type KitchenScope,
  type MonitoringAdapter,
  type MonitoringSignal,
} from '@/lib/kitchen-assurance/monitoring';

const CAPABILITY_ID = 'cold-chain';

export function createColdChainAdapter(db: Db): MonitoringAdapter {
  return {
    capabilityId: CAPABILITY_ID,
    async listSignals(scope: KitchenScope, policies: KaPolicyDoc[]): Promise<MonitoringSignal[]> {
      const policy = policies.find((p) => p.capabilityId === CAPABILITY_ID && p.aktif);
      const filter: Record<string, unknown> = { tenantId: scope.tenantId };
      if (scope.kitchenId) filter.kitchenId = scope.kitchenId;

      const logs = await db
        .collection(TEMPERATURE_LOGS_COLLECTION)
        .find(filter)
        .sort({ recordedAt: -1 })
        .limit(40)
        .toArray() as unknown as TemperatureLogDoc[];

      // Latest per stage (+ kitchen)
      const seen = new Set<string>();
      const signals: MonitoringSignal[] = [];
      for (const log of logs) {
        const bucket = `${log.kitchenId || 'all'}:${log.stage}`;
        if (seen.has(bucket)) continue;
        seen.add(bucket);

        let status = mapAlertToSignalStatus(log.alertStatus);
        if (policy?.rules && Number.isFinite(log.suhuC)) {
          status = evaluateNumericAgainstPolicy(log.suhuC, policy.rules);
          // Prefer owner CRITICAL/OUT as breach even if policy band differs
          if (log.alertStatus === 'CRITICAL' || log.alertStatus === 'OUT_OF_RANGE') {
            status = 'BREACH';
          } else if (log.alertStatus === 'WARN' && status === 'OK') {
            status = 'WATCH';
          }
        }

        signals.push({
          capabilityId: CAPABILITY_ID,
          category: 'FOOD',
          kind: 'MEASUREMENT',
          key: `cold-chain:${log.stage}:${log.kitchenId || 'tenant'}`,
          label: `Cold Chain — ${TEMP_STAGE_LABELS[log.stage] || log.stage}`,
          status,
          value: log.suhuC,
          unit: 'C',
          recordedAt: log.recordedAt,
          href: '/food-production/cold-chain',
          sourceRef: log.id,
          sourceCollection: TEMPERATURE_LOGS_COLLECTION,
          kitchenId: log.kitchenId,
          kitchenNama: log.kitchenNama,
          severity: policy?.rules?.severity,
          meta: { alertStatus: log.alertStatus, stage: log.stage },
        });
      }

      if (!signals.length) {
        signals.push({
          capabilityId: CAPABILITY_ID,
          category: 'FOOD',
          kind: 'MEASUREMENT',
          key: 'cold-chain:empty',
          label: 'Cold Chain — belum ada log suhu',
          status: 'OK',
          href: '/food-production/cold-chain',
          severity: policy?.rules?.severity,
        });
      }

      return signals;
    },
  };
}
