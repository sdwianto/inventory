'use client';

import { useCallback } from 'react';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { useInvalidateMaintenance } from '@/lib/hooks/use-maintenance';
import { queryKeys } from '@/lib/query-keys';

const MAINTENANCE_INVALIDATE_KEYS = [
  queryKeys.maintenance.assets.all,
  queryKeys.maintenance.requests.all,
  queryKeys.maintenance.schedules.all,
  queryKeys.maintenance.reports.all,
  queryKeys.maintenance.serviceOrders.all,
] as const;

/** Mutasi maintenance — invalidate cache + dukungan offline queue. */
export function useMaintenanceMutations() {
  const invalidate = useInvalidateMaintenance();
  const mutation = useApiMutation([...MAINTENANCE_INVALIDATE_KEYS]);

  const run = useCallback(async (
    input: Parameters<typeof mutation.mutateAsync>[0],
  ) => {
    const result = await mutation.mutateAsync(input);
    invalidate();
    return result;
  }, [mutation, invalidate]);

  return {
    run,
    isPending: mutation.isPending,
  };
}
