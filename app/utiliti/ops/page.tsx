'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle, CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { toast } from 'sonner';

type InvoiceReconcile = {
  reportId?: string;
  createdAt?: string;
  totalMismatch?: number;
  grnStale?: number;
  grnWithoutDo?: number;
  hutangOrphan?: number;
  cpoMismatch?: number;
  autoFixEnqueued?: number;
  grnInvoiceNotDoneSample?: Array<Record<string, unknown>>;
};

type FefoReconcile = {
  reportId?: string;
  createdAt?: string;
  totalMismatch?: number;
  expiredWithQty?: number;
  activePastExpiry?: number;
  batchVsStok?: number;
  mismatchSample?: Array<Record<string, unknown>>;
};

type IngredientLotReconcile = {
  reportId?: string;
  createdAt?: string;
  totalMismatch?: number;
  activePastExpiry?: number;
  expiredWithQty?: number;
  lotVsStok?: number;
  mismatchSample?: Array<Record<string, unknown>>;
};

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
  invoiceReconcile?: InvoiceReconcile | null;
  fefoReconcile?: FefoReconcile | null;
  ingredientLotReconcile?: IngredientLotReconcile | null;
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

  const runReconcile = useApiMutation([queryKeys.ops.dashboard]);

  const slo = (data?.health?.checks?.slo || {}) as Record<string, { ok?: boolean }>;
  const worker = (data?.health?.checks?.worker || {}) as Record<string, unknown>;
  const reconcile = (data?.health?.checks?.integrationReconcile || {}) as Record<string, unknown>;
  const invoiceRec = data?.invoiceReconcile;
  const fefoRec = data?.fefoReconcile;
  const ingredientLotRec = data?.ingredientLotReconcile;

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
            <h1 className="text-xl font-semibold">Ops · Invoice Reconciliation</h1>
            <p className="text-sm text-muted-foreground">
              Health, Detect→Compare→Repair (W1-5), webhook, bg_jobs — Inventory (MASTER)
            </p>
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
              <div>
                <h2 className="font-medium">Invoice Reconciliation (W1-5)</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Detect → Compare (Sales pull by noDO) → Repair (hutang / GRN_INVOICE_SYNC)
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        url: '/api/ops/invoice-reconcile/run',
                        method: 'POST',
                        offlineLabel: 'Enqueue invoice reconcile',
                      }) as { jobId?: string; reused?: boolean };
                      toast.success(
                        res.reused
                          ? `Reconcile job reused (${res.jobId || '—'})`
                          : `Detect enqueued (${res.jobId || '—'})`,
                      );
                      void refetch();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Gagal enqueue reconcile');
                    }
                  }}
                >
                  Run Detect
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        url: '/api/ops/repair',
                        method: 'POST',
                        body: {},
                        offlineLabel: 'Ops repair',
                      }) as { grnReconcileEnqueued?: number; grnStale?: number };
                      toast.success(
                        `Repair OK · stale GRN ${res.grnStale ?? 0} · enqueued ${res.grnReconcileEnqueued ?? 0}`,
                      );
                      void refetch();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Repair gagal');
                    }
                  }}
                >
                  Repair
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        url: '/api/ops/sweep',
                        method: 'POST',
                        offlineLabel: 'Ops sweep',
                      }) as { grnReverted?: number; scanned?: number };
                      toast.success(`Sweep: reverted ${res.grnReverted ?? 0} / scanned ${res.scanned ?? 0}`);
                      void refetch();
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Sweep gagal');
                    }
                  }}
                >
                  Sweep GRN
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        url: '/api/ops/ping',
                        method: 'POST',
                        offlineLabel: 'Ops ping',
                      }) as { ok?: boolean; url?: string };
                      if (res.ok) toast.success(`Ping Sales OK · ${res.url}`);
                      else toast.error(`Ping Sales gagal · ${res.url}`);
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Ping gagal');
                    }
                  }}
                >
                  Ping Sales
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">totalMismatch</div>
                <div className="font-semibold">
                  {invoiceRec ? String(invoiceRec.totalMismatch ?? 0) : String(reconcile.totalMismatch ?? '—')}
                </div>
                <StatusBadge
                  ok={
                    invoiceRec
                      ? Number(invoiceRec.totalMismatch || 0) === 0
                      : Number(reconcile.totalMismatch || 0) === 0 && !reconcile.neverRun
                  }
                />
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">GRN invoice stale</div>
                <div className="font-semibold">{String(invoiceRec?.grnStale ?? '—')}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">autoFix enqueued</div>
                <div className="font-semibold">{String(invoiceRec?.autoFixEnqueued ?? '—')}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">Last report</div>
                <div className="text-xs font-mono">
                  {invoiceRec?.createdAt ? formatDateTime(invoiceRec.createdAt) : 'belum ada'}
                </div>
              </div>
            </div>
            <div className="rounded border overflow-hidden">
              <h3 className="text-sm font-medium p-2 border-b bg-muted/30">
                Sample GRN invoice not done
              </h3>
              <ul className="divide-y max-h-40 overflow-auto text-sm">
                {(invoiceRec?.grnInvoiceNotDoneSample || []).length === 0 && (
                  <li className="p-3 text-muted-foreground">Tidak ada sample / belum ada report.</li>
                )}
                {(invoiceRec?.grnInvoiceNotDoneSample || []).map((g) => (
                  <li key={String(g.id)} className="p-2 font-mono text-xs">
                    {String(g.noGRN || g.id)} · DO {String(g.noDO || '—')} · {String(g.invoiceSyncStatus || '—')}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Detail report: <Link href="/integrasi" className="text-primary underline">Integrasi</Link>
              {' · '}full Replay/Repair toolkit = W1-6
            </p>
          </section>

          <section className="rounded-lg border p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-medium">W2-1/W2-4 · FEFO Detect & Repair</h2>
                <p className="text-xs text-muted-foreground">
                  Detect drift · Repair past-expiry + batch-vs-stok excess · Cycle count = /stok/penyesuaian
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        path: '/api/ops/fefo-reconcile/run',
                        method: 'POST',
                        body: {},
                        offlineLabel: 'FEFO Detect',
                      }) as { summary?: { totalMismatch?: number }; reportId?: string };
                      toast.success(
                        `FEFO Detect OK · mismatch ${res.summary?.totalMismatch ?? 0} · ${res.reportId || ''}`,
                      );
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'FEFO Detect gagal');
                    }
                  }}
                >
                  Run FEFO Detect
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        path: '/api/ops/fefo-reconcile/repair',
                        method: 'POST',
                        body: {},
                        offlineLabel: 'FEFO Repair',
                      }) as { repaired?: number; afterSummary?: { totalMismatch?: number } };
                      toast.success(
                        `FEFO Repair OK · repaired ${res.repaired ?? 0} · mismatch now ${res.afterSummary?.totalMismatch ?? '—'}`,
                      );
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'FEFO Repair gagal');
                    }
                  }}
                >
                  Run FEFO Repair
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">totalMismatch</div>
                <div className="font-semibold">{String(fefoRec?.totalMismatch ?? '—')}</div>
                <StatusBadge ok={!fefoRec || Number(fefoRec.totalMismatch || 0) === 0} />
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">expiredWithQty</div>
                <div className="font-semibold">{String(fefoRec?.expiredWithQty ?? '—')}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">batchVsStok</div>
                <div className="font-semibold">{String(fefoRec?.batchVsStok ?? '—')}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">Last report</div>
                <div className="text-xs font-mono">
                  {fefoRec?.createdAt ? formatDateTime(fefoRec.createdAt) : 'belum ada'}
                </div>
              </div>
            </div>
            <div className="rounded border overflow-hidden">
              <h3 className="text-sm font-medium p-2 border-b bg-muted/30">Mismatch sample</h3>
              <ul className="divide-y max-h-40 overflow-auto text-sm">
                {(fefoRec?.mismatchSample || []).length === 0 && (
                  <li className="p-3 text-muted-foreground">Tidak ada sample / belum ada report.</li>
                )}
                {(fefoRec?.mismatchSample || []).map((m, i) => (
                  <li key={`${String(m.batchId || m.stokId || i)}-${i}`} className="p-2 font-mono text-xs">
                    {String(m.kind || '—')} · {String(m.batchNo || m.stokId || '—')} · {String(m.detail || '')}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Batch UI: <Link href="/food-production/batch" className="text-primary underline">Production Batch</Link>
            </p>
          </section>

          <section className="rounded-lg border p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-medium">W2-5/W2-7 · Ingredient Lot Detect & Repair</h2>
                <p className="text-xs text-muted-foreground">
                  GRN lots · past-expiry → EXPIRED · lot-vs-stok excess → FEFO consume
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        path: '/api/ops/ingredient-lot-reconcile/run',
                        method: 'POST',
                        body: {},
                        offlineLabel: 'Ingredient Lot Detect',
                      }) as { summary?: { totalMismatch?: number }; reportId?: string };
                      toast.success(
                        `Lot Detect OK · mismatch ${res.summary?.totalMismatch ?? 0}`,
                      );
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Lot Detect gagal');
                    }
                  }}
                >
                  Run Lot Detect
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={runReconcile.isPending}
                  onClick={async () => {
                    try {
                      const res = await runReconcile.mutateAsync({
                        path: '/api/ops/ingredient-lot-reconcile/repair',
                        method: 'POST',
                        body: {},
                        offlineLabel: 'Ingredient Lot Repair',
                      }) as { repaired?: number; afterSummary?: { totalMismatch?: number } };
                      toast.success(
                        `Lot Repair OK · repaired ${res.repaired ?? 0} · mismatch now ${res.afterSummary?.totalMismatch ?? '—'}`,
                      );
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : 'Lot Repair gagal');
                    }
                  }}
                >
                  Run Lot Repair
                </Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">totalMismatch</div>
                <div className="font-semibold">{String(ingredientLotRec?.totalMismatch ?? '—')}</div>
                <StatusBadge ok={!ingredientLotRec || Number(ingredientLotRec.totalMismatch || 0) === 0} />
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">activePastExpiry</div>
                <div className="font-semibold">{String(ingredientLotRec?.activePastExpiry ?? '—')}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">lotVsStok</div>
                <div className="font-semibold">{String(ingredientLotRec?.lotVsStok ?? '—')}</div>
              </div>
              <div className="rounded border p-3">
                <div className="text-xs text-muted-foreground">Last report</div>
                <div className="text-xs font-mono">
                  {ingredientLotRec?.createdAt ? formatDateTime(ingredientLotRec.createdAt) : 'belum ada'}
                </div>
              </div>
            </div>
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
