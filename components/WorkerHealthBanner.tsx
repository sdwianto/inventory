'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

type WorkerHealth = {
  pendingCount?: number;
  oldestPendingAgeSec?: number | null;
  deadLetterCount?: number;
  workerStale?: boolean;
  orphanLegacyCount?: number;
  dispatchedCount?: number;
};

/** Alert MASTER jika antrian bg_jobs open > 5 menit (worker tidak drain). */
export default function WorkerHealthBanner({ enabled }: { enabled: boolean }) {
  const [worker, setWorker] = useState<WorkerHealth | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/health', {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(8_000),
        });
        const data = (await res.json()) as { checks?: { worker?: WorkerHealth } };
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

  const extras: string[] = [];
  if (worker.orphanLegacyCount) extras.push(`${worker.orphanLegacyCount} orphan legacy`);
  if (worker.dispatchedCount) extras.push(`${worker.dispatchedCount} DISPATCHED`);
  if (worker.deadLetterCount) extras.push(`${worker.deadLetterCount} dead-letter`);

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        Worker background tertunda
        {ageMin != null ? ` (${ageMin} menit)` : ''}
        — {worker.pendingCount ?? 0} job di antrian
        {extras.length ? ` (${extras.join(', ')})` : ''}
        . Di VPS pastikan{' '}
        <code className="text-xs">inventory-worker</code> Up/healthy
        {' '}(<code className="text-xs">docker logs</code> / restart) dan{' '}
        <code className="text-xs">WORKER_SECRET</code> cocok.
        Jaring pengaman: POST{' '}
        <code className="text-xs">/api/bg-jobs/process</code>
        {' '}atau <code className="text-xs">npm run diag:bg-jobs</code>.
      </span>
    </div>
  );
}
