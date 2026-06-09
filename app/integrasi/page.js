'use client';

import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Settings, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { getUser } from '@/lib/auth-client';

export default function IntegrasiPage() {
  const [status, setStatus] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat status');
      setStatus(data);
    } catch (e) {
      setStatus(null);
      toast.error(e.message);
    }
  }, []);

  useEffect(() => {
    getUser();
    loadStatus();
  }, [loadStatus]);

  const syncCatalog = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/integrations/sync-catalog', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync gagal');
      toast.success(`Sync selesai — ${data.created} baru, ${data.updated} diperbarui dari ${data.vendorTenantCount || '?'} vendor tenant`);
      loadStatus();
    } catch (e) {
      toast.error(e.message);
    }
    setSyncing(false);
  };

  const checklist = [
    { ok: status?.source === 'database' || status?.source === 'env', label: 'Terhubung ke sales.app', hint: 'Jalankan Setup dari sales.app /integrasi' },
    { ok: status?.catalogReachable, label: `Katalog sales.app (${status?.catalogCount ?? 0} produk, ${status?.vendorTenantCount ?? 0} tenant)`, hint: 'Sync semua tenant vendor sekaligus' },
    { ok: (status?.localProductCount || 0) > 0, label: `Produk lokal (${status?.localProductCount ?? 0})`, hint: 'Klik Sync Katalog' },
    { ok: !!status?.webhookSecret, label: 'Webhook secret', hint: 'Otomatis saat pairing' },
  ];

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-6 max-w-2xl">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="w-6 h-6" /> Integrasi Sales.app
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Konfigurasi otomatis dari sales.app — tidak perlu salin manual ke .env.local.
          </p>
        </div>

        <section className="bg-white border rounded-lg p-5 space-y-4">
          <h2 className="font-semibold text-sm">Cara setup (sekali saja)</h2>
          <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
            <li>Buka <strong>sales.app → Pengaturan → Integrasi API</strong></li>
            <li>Isi Customer Tenant ID = <code className="bg-slate-100 px-1 rounded">{status?.tenantId || 'sppg'}</code> — semua produk dari semua tenant sales.app akan di-sync</li>
            <li>Klik <strong>Setup &amp; Hubungkan Inventory</strong></li>
          </ol>
        </section>

        {status && (
          <section className="bg-white border rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-sm">Status — tenant {status.tenantId}</h2>
              <Button variant="ghost" size="sm" onClick={loadStatus}>
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
            {status.vendorName && (
              <p className="text-xs text-slate-600">Vendor: {status.vendorName} ({status.vendorTenantId})</p>
            )}
            {status.pairedAt && (
              <p className="text-xs text-slate-500">Paired: {new Date(status.pairedAt).toLocaleString('id-ID')}</p>
            )}
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
