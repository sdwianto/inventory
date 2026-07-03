'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCatalogSyncJob } from '@/lib/hooks/use-catalog-sync-job';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { queryKeys } from '@/lib/query-keys';
import type { SessionUser } from '@/types/auth';

const STORAGE_KEY = 'vendor-catalog-auto-sync-at';
const MIN_INTERVAL_MS = 15 * 60 * 1000;

const AUTO_SYNC_ROLES = new Set(['ADMIN', 'OWNER', 'MASTER']);

function canAutoSyncCatalog(user: SessionUser | null): boolean {
  if (!user || !AUTO_SYNC_ROLES.has(user.role)) return false;
  if (user.role === 'MASTER' && !getActingTenantId()) return false;
  return true;
}

/** Auto-sync katalog vendor setelah login — throttle browser + poll job 202. */
export function useVendorCatalogAutoSync(user: SessionUser | null) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const completedRef = useRef<string | null>(null);
  const { data: jobData } = useCatalogSyncJob(jobId);
  const enabled = canAutoSyncCatalog(user);

  useEffect(() => {
    if (!enabled || jobId) return undefined;

    const last = parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);
    if (Date.now() - last < MIN_INTERVAL_MS) return undefined;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/integrations/auto-sync', {
          method: 'POST',
          credentials: 'include',
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled || data.skipped) return;

        if (res.status === 202 && data.jobId) {
          setJobId(String(data.jobId));
          return;
        }

        if (res.ok) {
          sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
          window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: data }));
        }
      } catch {
        /* network — coba lagi sesi berikutnya */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, jobId]);

  useEffect(() => {
    if (!jobId || !jobData) return undefined;
    if (completedRef.current === jobId) return undefined;

    const status = String(jobData.status || '');
    if (status === 'PENDING' || status === 'RUNNING') return undefined;

    // Defer supaya setState tidak sinkron di dalam effect (react-hooks/set-state-in-effect).
    const t = setTimeout(() => {
      completedRef.current = jobId;
      sessionStorage.setItem(STORAGE_KEY, String(Date.now()));
      setJobId(null);

      if (status === 'DONE') {
        void queryClient.invalidateQueries({ queryKey: ['pages'] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspace.all });
        void queryClient.invalidateQueries({ queryKey: ['products'] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.integrations.all });
        window.dispatchEvent(
          new CustomEvent('vendor-catalog-synced', { detail: jobData.result || jobData }),
        );
      }
    }, 0);
    return () => clearTimeout(t);
  }, [jobId, jobData, queryClient]);
}
