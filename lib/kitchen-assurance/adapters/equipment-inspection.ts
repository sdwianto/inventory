/**
 * Equipment inspection adapter — surface Maintenance PM overdue (owner: Maintenance).
 * Phase 0: cheap read of maintenance_schedules; deep-link to WR/PM.
 */

import type { Db } from 'mongodb';
import { MAINTENANCE_SCHEDULES_COLLECTION } from '@/lib/maintenance/constants';
import type { KaPolicyDoc } from '@/lib/kitchen-assurance/policy';
import type {
  KitchenScope,
  MonitoringAdapter,
  MonitoringSignal,
} from '@/lib/kitchen-assurance/monitoring';
import { assetIdsForKitchen } from '@/lib/kitchen-assurance/kitchen-assets';

const CAPABILITY_ID = 'equipment-inspection';

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createEquipmentInspectionAdapter(db: Db): MonitoringAdapter {
  return {
    capabilityId: CAPABILITY_ID,
    async listSignals(scope: KitchenScope, policies: KaPolicyDoc[]): Promise<MonitoringSignal[]> {
      const policy = policies.find((p) => p.capabilityId === CAPABILITY_ID && p.aktif);
      const today = todayYmd();

      const filter: Record<string, unknown> = {
        tenantId: scope.tenantId,
        status: 'ACTIVE',
        nextDueDate: { $lte: today },
      };
      if (scope.kitchenId) {
        const assetIds = await assetIdsForKitchen(db, scope.tenantId, scope.kitchenId);
        if (!assetIds?.length) {
          return [
            {
              capabilityId: CAPABILITY_ID,
              category: 'EQUIPMENT',
              kind: 'EVENT',
              key: 'equipment-inspection:ok',
              label: 'Inspection — tidak ada PM overdue (dapur ini)',
              status: 'OK',
              href: '/maintenance/jadwal',
              kitchenId: scope.kitchenId,
              severity: policy?.rules?.severity,
            },
          ];
        }
        filter.assetId = { $in: assetIds };
      }

      const overdue = await db
        .collection(MAINTENANCE_SCHEDULES_COLLECTION)
        .find(filter)
        .sort({ nextDueDate: 1 })
        .limit(20)
        .toArray();

      if (!overdue.length) {
        return [
          {
            capabilityId: CAPABILITY_ID,
            category: 'EQUIPMENT',
            kind: 'EVENT',
            key: 'equipment-inspection:ok',
            label: 'Inspection — tidak ada PM overdue',
            status: 'OK',
            href: '/maintenance/jadwal',
            severity: policy?.rules?.severity,
          },
        ];
      }

      return overdue.map((row) => {
        const r = row as Record<string, unknown>;
        const judul = String(r.judul || r.assetNama || 'PM');
        const due = String(r.nextDueDate || '');
        return {
          capabilityId: CAPABILITY_ID,
          category: 'EQUIPMENT' as const,
          kind: 'EVENT' as const,
          key: `equipment-inspection:${String(r.id)}`,
          label: `Inspection overdue — ${judul}`,
          status: 'BREACH' as const,
          value: due,
          recordedAt: due,
          href: '/maintenance/jadwal',
          sourceRef: String(r.id),
          sourceCollection: MAINTENANCE_SCHEDULES_COLLECTION,
          severity: policy?.rules?.severity || 'HIGH',
          meta: { eventType: 'INSPECTION_OVERDUE', assetId: r.assetId },
        };
      });
    },
  };
}
