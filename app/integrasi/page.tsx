'use client';

import type { JsonObject } from '@/types/json';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Settings, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { str, num } from '@/types/json';
import { getUser } from '@/lib/auth-client';
import { useCatalogSyncJob } from '@/lib/hooks/use-catalog-sync-job';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { queryKeys } from '@/lib/query-keys';

export default function IntegrasiPage() {
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

  const displayStatus = probeStatus || status;

  const loadStatus = useCallback(async (probe = false) => {
    if (probe) {
      await refetchProbe();
      return;
    }
    await refetchStatus();
  }, [refetchProbe, refetchStatus]);

  useEffect(() => {
    if (!jobData || !activeJobId) return;
    const jobStatus = String(jobData.status || '');
    if (jobStatus === 'DONE') {
      const result = (jobData.result || {}) as JsonObject;
      toast.success(`Sync selesai — ${num(result.created)} baru, ${num(result.updated)} diperbarui`);
      window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: result }));
      setActiveJobId(null);
      setSyncing(false);
      void loadStatus(true);
    } else if (jobStatus === 'FAILED') {
      const errMsg = String(jobData.lastError || (jobData.result as JsonObject)?.error || 'Sync gagal');
      toast.error(errMsg);
      setActiveJobId(null);
      setSyncing(false);
    }
  }, [jobData, activeJobId, loadStatus]);

  const syncCatalog = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/integrations/sync-catalog', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync gagal');
      if (res.status === 202 && data.jobId) {
        toast.info('Sync katalog berjalan di background…');
        setActiveJobId(String(data.jobId));
        return;
      }
      toast.success(`Sync selesai — ${data.created} baru, ${data.updated} diperbarui dari ${data.vendorTenantCount || '?'} vendor tenant`);
      window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: data }));
      void loadStatus(true);
      setSyncing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setSyncing(false);
    }
  };

  const checklist = [
    { ok: displayStatus?.source === 'database' || displayStatus?.source === 'env', label: 'Terhubung ke sales.app', hint: 'Jalankan Setup dari sales.app /integrasi' },
    { ok: displayStatus?.catalogProbed ? displayStatus?.catalogReachable : (num(displayStatus?.syncedProductCount) || 0) > 0, label: displayStatus?.catalogProbed ? `Katalog sales.app (${num(displayStatus?.catalogCount)} produk, ${num(displayStatus?.vendorTenantCount)} tenant)` : `Produk tersinkron (${num(displayStatus?.syncedProductCount)})`, hint: 'Klik Sync Katalog atau refresh (ikon) untuk cek koneksi' },
    { ok: (num(displayStatus?.localProductCount) || 0) > 0, label: `Produk lokal (${num(displayStatus?.localProductCount)})`, hint: 'Klik Sync Katalog' },
    { ok: !!displayStatus?.webhookSecret, label: 'Webhook secret', hint: 'Otomatis saat pairing' },
  ];
  const vendorLinks = Array.isArray(displayStatus?.vendorLinks)
    ? (displayStatus.vendorLinks as Array<{ vendorTenantId?: string; vendorName?: string }>)
    : [];

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="w-6 h-6" /> Integrasi Sales.app
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Registry multi-vendor — tiap vendor di sales.app ditambahkan tanpa menimpa vendor lain.
          </p>
        </div>

        <div className="rounded-lg border bg-white p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Status Integrasi</h2>
            <Button variant="outline" size="sm" onClick={() => loadStatus(true)} disabled={loading || syncing}>
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
            <h2 className="font-semibold mb-2">Vendor Terhubung</h2>
            <ul className="text-sm space-y-1">
              {vendorLinks.map((v) => (
                <li key={v.vendorTenantId}>{str(v.vendorName) || str(v.vendorTenantId)}</li>
              ))}
            </ul>
          </div>
        )}

        <Button onClick={syncCatalog} disabled={syncing || Boolean(activeJobId)} className="w-full sm:w-auto">
          {syncing || activeJobId ? (progressMessage || 'Sync berjalan…') : 'Sync Katalog dari Sales.app'}
        </Button>
      </div>
    </AppShell>
  );
}
