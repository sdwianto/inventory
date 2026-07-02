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

export default function IntegrasiPage() {
  const [status, setStatus] = useState<JsonObject | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const { data: jobData } = useCatalogSyncJob(activeJobId);

  const loadStatus = useCallback(async (probe = false) => {
    setLoading(true);
    try {
      const qs = probe ? '?probe=1' : '';
      const res = await fetch(`/api/integrations/status${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat status');
      setStatus(data);
    } catch (e) {
      setStatus(null);
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    getUser();
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!jobData || !activeJobId) return;
    const jobStatus = String(jobData.status || '');
    if (jobStatus === 'DONE') {
      const result = (jobData.result || {}) as JsonObject;
      toast.success(`Sync selesai — ${num(result.created)} baru, ${num(result.updated)} diperbarui`);
      window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: result }));
      setActiveJobId(null);
      setSyncing(false);
      loadStatus(true);
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
      loadStatus(true);
      setSyncing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setSyncing(false);
    }
  };

  const checklist = [
    { ok: status?.source === 'database' || status?.source === 'env', label: 'Terhubung ke sales.app', hint: 'Jalankan Setup dari sales.app /integrasi' },
    { ok: status?.catalogProbed ? status?.catalogReachable : (num(status?.syncedProductCount) || 0) > 0, label: status?.catalogProbed ? `Katalog sales.app (${num(status?.catalogCount)} produk, ${num(status?.vendorTenantCount)} tenant)` : `Produk tersinkron (${num(status?.syncedProductCount)})`, hint: 'Klik Sync Katalog atau refresh (ikon) untuk cek koneksi' },
    { ok: (num(status?.localProductCount) || 0) > 0, label: `Produk lokal (${num(status?.localProductCount)})`, hint: 'Klik Sync Katalog' },
    { ok: !!status?.webhookSecret, label: 'Webhook secret', hint: 'Otomatis saat pairing' },
  ];
  const vendorLinks = Array.isArray(status?.vendorLinks)
    ? (status.vendorLinks as Array<{ vendorTenantId?: string; vendorName?: string }>)
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

        <section className="bg-white border rounded-lg p-5 space-y-4">
          <h2 className="font-semibold text-sm">Cara setup (sekali saja)</h2>
          <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
            <li>Buka <strong>sales.app → Pengaturan → Integrasi API</strong></li>
            <li>Isi Customer Tenant ID = <code className="bg-slate-100 px-1 rounded">{str(status?.tenantId, 'sppg')}</code> — semua produk dari semua tenant sales.app akan di-sync</li>
            <li>Klik <strong>Setup &amp; Hubungkan Inventory</strong> — ulangi untuk setiap vendor baru</li>
          </ol>
        </section>

        {loading && !status && (
          <section className="bg-white border rounded-lg p-5 animate-pulse space-y-3">
            <div className="h-4 bg-slate-200 rounded w-1/3" />
            <div className="h-3 bg-slate-100 rounded w-full" />
            <div className="h-3 bg-slate-100 rounded w-2/3" />
          </section>
        )}

        {status && (
          <section className="bg-white border rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">Status — tenant {str(status.tenantId)}</h2>
              <Button variant="ghost" size="sm" onClick={() => loadStatus(true)}>
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
            <ul className="space-y-2">
              {checklist.map((c) => (
                <li key={c.label} className="flex items-start gap-2 text-sm">
                  {c.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <span>{c.label}</span>
                    {!c.ok && <p className="text-[11px] text-slate-500">{c.hint}</p>}
                  </div>
                </li>
              ))}
            </ul>
            {vendorLinks.length > 0 && (
              <ul className="text-xs text-slate-600 space-y-1">
                {vendorLinks.map((v) => (
                  <li key={v.vendorTenantId}>
                    Vendor: <strong>{v.vendorName || v.vendorTenantId}</strong> ({v.vendorTenantId})
                  </li>
                ))}
              </ul>
            )}
            {status.vendorName && vendorLinks.length === 0 ? (
              <p className="text-xs text-slate-600">Vendor: {str(status.vendorName)} ({str(status.vendorTenantId)})</p>
            ) : null}
            {status.tierHargaDefault ? (
              <p className="text-xs text-slate-600">
                Tier harga referensi PO: <strong>{str(status.tierHargaDefault)}</strong> (dari profil pelanggan di sales.app)
              </p>
            ) : null}
            {status.lastCatalogSyncAt ? (
              <p className="text-xs text-slate-500">
                Sync terakhir: {new Date(str(status.lastCatalogSyncAt)).toLocaleString('id-ID')}
              </p>
            ) : null}
            {status.pairedAt ? (
              <p className="text-xs text-slate-500">Paired: {new Date(str(status.pairedAt)).toLocaleString('id-ID')}</p>
            ) : null}
            <p className="text-[11px] text-slate-500">
              Sync katalog manual dari halaman ini atau jadwalkan via worker/cron server.
            </p>
            <Button
              onClick={syncCatalog}
              disabled={syncing || !status.salesApiKey}
              className="bg-orange-500 hover:bg-orange-600"
            >
              {syncing ? 'Menyinkronkan…' : 'Sync Katalog dari Sales.app'}
            </Button>
          </section>
        )}
      </div>
    </AppShell>
  );
}
