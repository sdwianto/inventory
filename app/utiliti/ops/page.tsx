'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';
import { formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';

type OpsDashboard = {
  health?: {
    status?: string;
    uptimeSec?: number;
    checks?: Record<string, unknown>;
  };
  failedWebhooks?: Array<Record<string, unknown>>;
  pendingJobs?: Array<Record<string, unknown>>;
  deadLetterJobs?: Array<Record<string, unknown>>;
  recentAudit?: Array<Record<string, unknown>>;
  salesHealthUrl?: string | null;
  fpObservability?: {
    hotpath?: { sampleCount: number; p95Ms: number; thresholdMs: number; ok: boolean };
    latency?: Array<{
      metric: string;
      sampleCount: number;
      p50Ms: number;
      p95Ms: number;
      thresholdMs: number;
      ok: boolean;
      slowCount: number;
      count5xx: number;
      count4xx: number;
    }>;
    recentFailures?: Array<{
      at: string;
      method: string;
      route: string;
      status: number;
      durationMs?: number;
      error?: string;
      metric?: string;
    }>;
  };
};

function StatusBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium">
      <CheckCircle2 className="h-3.5 w-3.5" /> OK
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-amber-700 text-xs font-medium">
      <AlertTriangle className="h-3.5 w-3.5" /> Perhatian
    </span>
  );
}

export default function OpsDashboardPage() {
  const [user] = useState<{ role?: string } | null>(() => getUser());

  const { data, isLoading, isError, refetch, isFetching } = useApiQuery<OpsDashboard>(
    queryKeys.ops.dashboard,
    user?.role === 'MASTER' ? '/api/ops/dashboard' : null,
    { enabled: user?.role === 'MASTER', refetchInterval: 60_000 },
  );

  const slo = (data?.health?.checks?.slo || {}) as Record<string, { ok?: boolean }>;
  const worker = (data?.health?.checks?.worker || {}) as Record<string, unknown>;
  const reconcile = (data?.health?.checks?.integrationReconcile || {}) as Record<string, unknown>;

  if (user && user.role !== 'MASTER') {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-destructive">Halaman ini hanya untuk role MASTER.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Ops Dashboard</h1>
            <p className="text-sm text-muted-foreground">Health, webhook inbox, bg_jobs — Inventory (MASTER)</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={isFetching} onClick={() => refetch()} className="gap-2">
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {isError && <p className="text-sm text-destructive">Gagal memuat dashboard ops.</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Memuat…</p>}

      {data && (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border p-4">
              <div className="text-xs text-muted-foreground mb-1">App status</div>
              <div className="font-semibold capitalize">{data.health?.status || '—'}</div>
            </div>
            <div className="rounded-lg border p-4">
              <div className="text-xs text-muted-foreground mb-1">Worker pending</div>
              <div className="font-semibold">{String(worker.pendingCount ?? '—')}</div>
              <StatusBadge ok={!(worker.workerStale as boolean)} />
            </div>
            <div className="rounded-lg border p-4">
              <div className="text-xs text-muted-foreground mb-1">Integration mismatch</div>
              <div className="font-semibold">{String(reconcile.totalMismatch ?? '—')}</div>
              <StatusBadge ok={Number(reconcile.totalMismatch || 0) === 0 && !reconcile.neverRun} />
            </div>
            <div className="rounded-lg border p-4">
              <div className="text-xs text-muted-foreground mb-1">Sales health</div>
              {data.salesHealthUrl ? (
                <Link href={data.salesHealthUrl} target="_blank" className="text-sm text-primary inline-flex items-center gap-1">
                  Buka API <ExternalLink className="h-3.5 w-3.5" />
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground">SALES_APP_URL belum diset</span>
              )}
            </div>
          </section>

          <section className="rounded-lg border p-4">
            <h2 className="font-medium mb-3">SLO (5 kritis)</h2>
            <ul className="grid gap-2 sm:grid-cols-2 text-sm">
              {Object.entries(slo).map(([key, val]) => (
                <li key={key} className="flex items-center justify-between border rounded px-3 py-2">
                  <span className="font-mono text-xs">{key}</span>
                  <StatusBadge ok={val?.ok !== false} />
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-lg border p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Food Production observability</h2>
              {data.fpObservability?.hotpath && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-xs">
                    hotpath p95 {data.fpObservability.hotpath.p95Ms}ms
                    {' / '}
                    {data.fpObservability.hotpath.thresholdMs}ms
                    {' · n='}
                    {data.fpObservability.hotpath.sampleCount}
                  </span>
                  <StatusBadge ok={data.fpObservability.hotpath.ok !== false} />
                </div>
              )}
            </div>
            <div className="overflow-x-auto rounded border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="text-left p-2">Metric</th>
                    <th className="text-right p-2">n</th>
                    <th className="text-right p-2">p50</th>
                    <th className="text-right p-2">p95</th>
                    <th className="text-right p-2">slow</th>
                    <th className="text-right p-2">5xx</th>
                    <th className="text-left p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.fpObservability?.latency || []).length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-3 text-muted-foreground">
                        Belum ada sample FP — traffic akan mengisi bucket.
                      </td>
                    </tr>
                  )}
                  {(data.fpObservability?.latency || []).map((row) => (
                    <tr key={row.metric} className="border-t">
                      <td className="p-2 font-mono text-xs">{row.metric}</td>
                      <td className="p-2 text-right">{row.sampleCount}</td>
                      <td className="p-2 text-right">{row.p50Ms}</td>
                      <td className="p-2 text-right">{row.p95Ms}</td>
                      <td className="p-2 text-right">{row.slowCount}</td>
                      <td className="p-2 text-right">{row.count5xx}</td>
                      <td className="p-2"><StatusBadge ok={row.ok} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded border overflow-hidden">
              <h3 className="text-sm font-medium p-2 border-b bg-muted/30">Recent FP failures</h3>
              <ul className="divide-y max-h-48 overflow-auto text-sm">
                {(data.fpObservability?.recentFailures || []).length === 0 && (
                  <li className="p-3 text-muted-foreground">Tidak ada kegagalan FP di memori proses.</li>
                )}
                {(data.fpObservability?.recentFailures || []).map((f, i) => (
                  <li key={`${f.at}-${i}`} className="p-2">
                    <div className="font-mono text-xs">
                      {f.method} {f.route} · {f.status}
                      {f.durationMs != null ? ` · ${f.durationMs}ms` : ''}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{f.error || f.metric || ''}</div>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border overflow-hidden">
              <h2 className="font-medium p-3 border-b bg-muted/30">Webhook inbox gagal (24j)</h2>
              <ul className="divide-y max-h-64 overflow-auto text-sm">
                {(data.failedWebhooks || []).length === 0 && (
                  <li className="p-3 text-muted-foreground">Tidak ada kegagalan.</li>
                )}
                {(data.failedWebhooks || []).map((w) => (
                  <li key={String(w.id)} className="p-3">
                    <div className="font-mono text-xs">{String(w.event)} · {String(w.tenantId)}</div>
                    <div className="text-xs text-muted-foreground truncate">{String(w.lastError || '')}</div>
                    <div className="text-xs">{formatDateTime(w.createdAt as string)}</div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border overflow-hidden">
              <h2 className="font-medium p-3 border-b bg-muted/30">Bg jobs</h2>
              <ul className="divide-y max-h-64 overflow-auto text-sm">
                {[...(data.pendingJobs || []), ...(data.deadLetterJobs || [])].length === 0 && (
                  <li className="p-3 text-muted-foreground">Antrian kosong.</li>
                )}
                {(data.pendingJobs || []).map((j) => (
                  <li key={String(j.id)} className="p-3">
                    <span className="font-mono text-xs">{String(j.type)}</span>
                    <span className="ml-2 text-xs text-amber-700">PENDING</span>
                  </li>
                ))}
                {(data.deadLetterJobs || []).map((j) => (
                  <li key={String(j.id)} className="p-3">
                    <span className="font-mono text-xs">{String(j.type)}</span>
                    <span className="ml-2 text-xs text-destructive">DEAD LETTER</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
