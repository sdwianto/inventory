'use client';

import type { JsonObject } from '@/types/json';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Settings, CheckCircle2, AlertCircle, RefreshCw, Link2 } from 'lucide-react';
import { str, num } from '@/types/json';
import { getUser, syncSessionUser } from '@/lib/auth-client';
import type { SessionUser } from '@/types/auth';
import { useCatalogSyncJob } from '@/lib/hooks/use-catalog-sync-job';
import { useOnceTerminalEffect } from '@/lib/hooks/use-once-terminal-effect';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';

export default function IntegrasiPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const { data: jobData, progressMessage } = useCatalogSyncJob(activeJobId);

  const { data: status, isLoading: loading, refetch: refetchStatus } = useApiQuery<JsonObject>(
    queryKeys.integrations.status(false),
    '/api/integrations/status',
    { enabled: Boolean(getUser()) },
  );

  const { data: probeStatus, refetch: refetchProbe } = useApiQuery<JsonObject>(
    queryKeys.integrations.status(true),
    '/api/integrations/status?probe=1',
    { enabled: false },
  );

  const isMaster = user?.role === 'MASTER';

  const { data: reconcileLatest } = useApiQuery<JsonObject>(
    ['integrations', 'reconcile-latest'],
    isMaster ? '/api/integrations/reconcile/latest' : null,
    { enabled: Boolean(isMaster), staleTime: 60_000 },
  );

  const reconcileSummary = reconcileLatest?.summary as JsonObject | undefined;
  const reconcileMismatch = num(reconcileSummary?.totalMismatch);

  useEffect(() => {
    void syncSessionUser().then(setUser);
  }, []);

  const displayStatus = probeStatus || status;

  const connectMutation = useApiMutation([queryKeys.integrations.all, queryKeys.products.all]);
  const syncCatalogMutation = useApiMutation([queryKeys.integrations.all, queryKeys.products.all]);

  const loadStatus = useCallback(async (probe = false) => {
    if (probe) {
      await refetchProbe();
      return;
    }
    await refetchStatus();
  }, [refetchProbe, refetchStatus]);

  // Probe berjalan di background di server — poll sampai hasil terbaru tersedia.
  useEffect(() => {
    if (probeStatus?.catalogProbeRunning !== true) return;
    const timer = setTimeout(() => { void refetchProbe(); }, 4000);
    return () => clearTimeout(timer);
  }, [probeStatus, refetchProbe]);

  const catalogJobStatus = jobData && activeJobId ? String(jobData.status || '') : null;
  useOnceTerminalEffect(activeJobId, jobData, catalogJobStatus, ['DONE', 'FAILED'], (status) => {
    if (status === 'DONE') {
      const result = (jobData?.result || {}) as JsonObject;
      toast.success(`Sync selesai — ${num(result.created)} baru, ${num(result.updated)} diperbarui`);
      window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: result }));
      void loadStatus(true);
    } else {
      const errMsg = String(jobData?.lastError || (jobData?.result as JsonObject)?.error || 'Sync gagal');
      toast.error(errMsg);
    }
    setActiveJobId(null);
    setSyncing(false);
    setConnecting(false);
  });

  const startCatalogJob = async (data: JsonObject) => {
    if (data.jobId) {
      toast.info('Sync katalog berjalan di background…');
      setActiveJobId(String(data.jobId));
      return;
    }
    toast.success(`Sync selesai — ${num(data.created)} baru, ${num(data.updated)} diperbarui dari ${num(data.vendorTenantCount) || '?'} vendor`);
    window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: data }));
    void loadStatus(true);
    setSyncing(false);
    setConnecting(false);
  };

  const connectToSales = async () => {
    setConnecting(true);
    try {
      const data = await connectMutation.mutateAsync({
        url: '/api/integrations/connect-sales',
        offlineLabel: 'Hubungkan ke sales.app',
      }) as JsonObject;
      toast.success(str(data.message) || 'Terhubung ke sales.app');
      await startCatalogJob(data);
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
      setConnecting(false);
    }
  };

  const syncCatalog = async () => {
    setSyncing(true);
    try {
      const data = await syncCatalogMutation.mutateAsync({
        url: '/api/integrations/sync-catalog',
        offlineLabel: 'Sync katalog dari sales.app',
      }) as JsonObject;
      await startCatalogJob(data);
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
      setSyncing(false);
    }
  };

  const vendorLinks = Array.isArray(displayStatus?.vendorLinks)
    ? (displayStatus.vendorLinks as Array<{ vendorTenantId?: string; vendorName?: string }>)
    : [];
  const vendorCount = Math.max(num(displayStatus?.vendorTenantCount), vendorLinks.length);
  const isConnected = vendorLinks.length > 0 || displayStatus?.source === 'database' || displayStatus?.source === 'env';

  const checklist = [
    {
      ok: isConnected,
      label: vendorLinks.length
        ? `Terhubung ke sales.app (${vendorLinks.length} vendor)`
        : 'Terhubung ke sales.app',
      hint: 'Jalankan Hubungkan Platform dari sales.app (MASTER)',
    },
    {
      ok: displayStatus?.catalogProbed
        ? displayStatus?.catalogReachable
        : (num(displayStatus?.syncedProductCount) || 0) > 0,
      label: displayStatus?.catalogProbed
        ? `Katalog sales.app (${num(displayStatus?.catalogCount)} produk, ${vendorCount} tenant)`
        : `Produk tersinkron (${num(displayStatus?.syncedProductCount)})`,
      hint: 'Klik Hubungkan ke Sales atau Sync Katalog',
    },
    {
      ok: (num(displayStatus?.localProductCount) || 0) > 0,
      label: `Produk lokal (${num(displayStatus?.localProductCount)})`,
      hint: 'Sync katalog dari sales.app',
    },
    {
      ok: !!displayStatus?.webhookSecret,
      label: 'Webhook secret',
      hint: 'Otomatis saat platform connect dari sales.app',
    },
  ];

  const busy = connecting || syncing || Boolean(activeJobId);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Settings className="w-6 h-6" /> Integrasi Sales.app
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Customer tenant ini menerima katalog & transaksi dari semua vendor di sales.app.
        </p>
      </div>

      {isMaster && reconcileMismatch > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">
              {reconcileMismatch} ketidaksesuaian integrasi terdeteksi
            </p>
            <p className="text-xs mt-1 opacity-80">
              CPO tanpa SO: {num(reconcileSummary?.cpoWithoutSo)}
              {' · '}
              GRN stale: {num(reconcileSummary?.grnStale)}
              {' · '}
              GRN tanpa DO: {num(reconcileSummary?.grnWithoutDo)}
              {' · '}
              Hutang orphan: {num(reconcileSummary?.hutangOrphan)}
            </p>
          </div>
        </div>
      )}

      <section className="bg-gradient-to-br from-blue-50 to-white border border-blue-200 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Link2 className="w-5 h-5 text-blue-600" />
          <h2 className="font-semibold text-slate-900">Hubungkan ke Sales</h2>
        </div>
        <p className="text-sm text-slate-600">
          Pastikan <strong>Hubungkan Platform</strong> sudah dijalankan dari sales.app (MASTER), lalu klik tombol di bawah untuk sync katalog semua supplier.
        </p>
        <Button
          onClick={connectToSales}
          disabled={busy}
          className="w-full bg-blue-600 hover:bg-blue-700 h-11"
        >
          <Link2 className="w-4 h-4 mr-2" />
          {connecting || activeJobId ? (progressMessage || 'Menghubungkan & sync…') : 'Hubungkan ke Sales'}
        </Button>
      </section>

      <div className="rounded-lg border bg-white p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Status Integrasi</h2>
          <Button variant="outline" size="sm" onClick={() => loadStatus(true)} disabled={loading || busy}>
            <RefreshCw className={`w-4 h-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
        {loading && !displayStatus ? (
          <p className="text-sm text-slate-500">Memuat status…</p>
        ) : (
          <ul className="space-y-2">
            {checklist.map((item) => (
              <li key={item.label} className="flex items-start gap-2 text-sm">
                {item.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                )}
                <div>
                  <div className={item.ok ? 'text-slate-800' : 'text-slate-600'}>{item.label}</div>
                  {!item.ok && <div className="text-xs text-slate-400">{item.hint}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {vendorLinks.length > 0 && (
        <div className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold mb-2">Vendor Terhubung ({vendorLinks.length})</h2>
          <ul className="text-sm space-y-1 max-h-48 overflow-y-auto">
            {vendorLinks.map((v) => (
              <li key={v.vendorTenantId}>{str(v.vendorName) || str(v.vendorTenantId)}</li>
            ))}
          </ul>
        </div>
      )}

      <Button onClick={syncCatalog} disabled={busy} variant="outline" className="w-full sm:w-auto">
        {syncing && !connecting ? (progressMessage || 'Sync berjalan…') : 'Sync Katalog dari Sales.app'}
      </Button>
    </div>
  );
}
