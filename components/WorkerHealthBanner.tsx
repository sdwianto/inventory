'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

type WorkerHealth = {
  pendingCount?: number;
  oldestPendingAgeSec?: number | null;
  deadLetterCount?: number;
  workerStale?: boolean;
};

/** Alert MASTER jika cron/worker bg_jobs tidak memproses antrian ≤ 5 menit (Phase 4.5). */
export default function WorkerHealthBanner({ enabled }: { enabled: boolean }) {
  const [worker, setWorker] = useState<WorkerHealth | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/health', { credentials: 'include', cache: 'no-store' });
        const data = await res.json() as { checks?: { worker?: WorkerHealth } };
        if (!cancelled) setWorker(data.checks?.worker || null);
      } catch {
        if (!cancelled) setWorker(null);
      }
    };

    void poll();
    const id = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);

  if (!enabled || !worker?.workerStale) return null;

  const ageMin = worker.oldestPendingAgeSec != null
    ? Math.floor(worker.oldestPendingAgeSec / 60)
    : null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        Worker background tertunda
        {ageMin != null ? ` (${ageMin} menit)` : ''}
        — {worker.pendingCount ?? 0} job PENDING
        {worker.deadLetterCount ? `, ${worker.deadLetterCount} dead-letter` : ''}
        . Periksa cron <code className="text-xs">/api/bg-jobs/process</code>.
      </span>
    </div>
  );
}
