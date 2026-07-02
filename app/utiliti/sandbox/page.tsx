'use client';

import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from 'sonner';
import { AlertTriangle, Eraser, Eye, Loader2, ShieldAlert } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import type { SessionUser } from '@/types/auth';
import { isSandboxResetMenuVisible } from '@/lib/sandbox-client';

type CountInfo =
  | { skipped: true; before: 0; deleted: 0 }
  | { dryRun: true; before: number }
  | { before: number; deleted: number };

type StockResetPreview = { dryRun: true; stok_lokasi_rows: number | null; note: string };
type StockResetDone = { stok_lokasi: number; products: number };

type DbPreview = {
  label: string;
  dbName: string;
  summary: { documents: number; collections: number };
  counts: Record<string, CountInfo | StockResetPreview | StockResetDone>;
};

type PreviewResponse = {
  tenantId: string | null;
  scope: 'tenant' | 'all';
  includeSales: boolean;
  inventory: DbPreview;
  sales: DbPreview | null;
};

type StatusResponse = {
  enabled: boolean;
  blockReason: string | null;
  confirmPhrase: string;
  inventoryDbName: string;
  salesDbName: string;
  keepHint: string[];
};

function isStockResetPreview(info: unknown): info is StockResetPreview {
  return !!info && typeof info === 'object' && 'dryRun' in info && 'stok_lokasi_rows' in info;
}

function isStockResetDone(info: unknown): info is StockResetDone {
  return !!info && typeof info === 'object' && 'stok_lokasi' in info && 'products' in info;
}

function renderCountRows(counts: DbPreview['counts']) {
  return Object.entries(counts)
    .filter(([name, info]) => {
      if (name === '_stock_reset') return true;
      if ('skipped' in info && info.skipped) return false;
      if ('dryRun' in info && 'before' in info) return info.before > 0;
      if ('before' in info) return info.before > 0;
      return false;
    })
    .map(([name, info]) => {
      if (name === '_stock_reset') {
        if (isStockResetPreview(info)) {
          return (
            <tr key={name} className="border-t">
              <td className="px-3 py-1.5 font-mono text-xs text-amber-700">[stok reset]</td>
              <td className="px-3 py-1.5 text-right text-xs text-slate-600">
                {info.stok_lokasi_rows ?? 0} baris stok_lokasi → qty 0; products.stok → 0
              </td>
            </tr>
          );
        }
        if (isStockResetDone(info)) {
          return (
            <tr key={name} className="border-t">
              <td className="px-3 py-1.5 font-mono text-xs text-amber-700">[stok reset]</td>
              <td className="px-3 py-1.5 text-right text-xs text-slate-600">
                stok_lokasi={info.stok_lokasi}, products={info.products}
              </td>
            </tr>
          );
        }
        return null;
      }
      const before = 'before' in info ? info.before : 0;
      const deleted = 'deleted' in info ? info.deleted : undefined;
      return (
        <tr key={name} className="border-t">
          <td className="px-3 py-1.5 font-mono text-xs">{name}</td>
          <td className="px-3 py-1.5 text-right text-xs">
            {deleted !== undefined ? `${deleted} / ${before}` : before}
          </td>
        </tr>
      );
    });
}

export default function SandboxResetPage() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [tenants, setTenants] = useState<{ tenantId: string; companyName?: string }[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [includeSales, setIncludeSales] = useState(true);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [resetting, setResetting] = useState(false);

  const menuVisible = isSandboxResetMenuVisible();

  useEffect(() => {
    setUser(getUser());
    void loadStatus();
    void loadTenants();
  }, []);

  const loadStatus = async () => {
    try {
      const res = await fetch('/api/sandbox/status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat status');
      setStatus(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const loadTenants = async () => {
    try {
      const res = await fetch('/api/tenants');
      const data = await res.json();
      if (!res.ok) return;
      const list = Array.isArray(data) ? data : [];
      setTenants(
        list.map((t: Record<string, unknown>) => ({
          tenantId: String(t.tenantId || ''),
          companyName: t.companyName ? String(t.companyName) : undefined,
        })),
      );
    } catch {
      /* ignore */
    }
  };

  const runPreview = async () => {
    setLoadingPreview(true);
    try {
      const qs = new URLSearchParams();
      if (tenantId.trim()) qs.set('tenantId', tenantId.trim());
      if (!includeSales) qs.set('includeSales', '0');
      const res = await fetch(`/api/sandbox/preview?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preview gagal');
      setPreview(data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setLoadingPreview(false);
  };

  const runReset = async () => {
    if (!acknowledge) {
      toast.error('Centang konfirmasi risiko terlebih dahulu');
      return;
    }
    setResetting(true);
    try {
      const res = await fetch('/api/sandbox/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmPhrase,
          tenantId: tenantId.trim() || undefined,
          includeSales,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reset gagal');
      setPreview(data);
      setConfirmPhrase('');
      setAcknowledge(false);
      toast.success('Reset sandbox selesai — transaksi dihapus, master data tetap');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setResetting(false);
  };

  const confirmOk = useMemo(
    () => confirmPhrase.trim() === (status?.confirmPhrase || 'RESET SANDBOX'),
    [confirmPhrase, status?.confirmPhrase],
  );

  if (user && user.role !== 'MASTER') {
    return (
      <AppShell>
        <div className="p-6">
          <Card>
            <CardContent className="p-6 text-center">
              <ShieldAlert className="w-12 h-12 mx-auto text-slate-400 mb-2" />
              <div className="font-semibold">Akses Terbatas</div>
              <div className="text-sm text-slate-500">Hanya role MASTER yang bisa reset sandbox.</div>
            </CardContent>
          </Card>
        </div>
      </AppShell>
    );
  }

  if (!menuVisible || (status && !status.enabled)) {
    return (
      <AppShell>
        <div className="p-6 max-w-2xl">
          <Card>
            <CardContent className="p-6">
              <div className="font-semibold mb-2">Reset Sandbox tidak aktif</div>
              <p className="text-sm text-slate-600">
                Fitur ini disembunyikan secara default. Untuk uji sandbox, set di environment:
              </p>
              <ul className="text-sm text-slate-600 mt-2 list-disc pl-5 space-y-1">
                <li><code className="text-xs bg-slate-100 px-1 rounded">ENABLE_SANDBOX_RESET_UI=1</code></li>
                <li><code className="text-xs bg-slate-100 px-1 rounded">NEXT_PUBLIC_ENABLE_SANDBOX_RESET_UI=1</code></li>
                <li>Production: <code className="text-xs bg-slate-100 px-1 rounded">ALLOW_SANDBOX_RESET=1</code></li>
              </ul>
              {status?.blockReason && (
                <p className="text-sm text-amber-700 mt-3">{status.blockReason}</p>
              )}
            </CardContent>
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="p-4 md:p-6 max-w-4xl space-y-4">
        <div className="flex items-start gap-3">
          <Eraser className="w-8 h-8 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h1 className="text-xl font-bold">Reset Sandbox</h1>
            <p className="text-sm text-slate-600 mt-1">
              Hapus semua data transaksi di inventory + sales, tanpa menghapus user, tenant, produk, integrasi, atau setup.
              Gunakan setelah simulasi di Vercel sandbox — sembunyikan fitur ini setelah go-live.
            </p>
          </div>
        </div>

        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="p-4 flex gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="text-sm text-amber-900 space-y-1">
              <div className="font-semibold">Operasi tidak bisa dibatalkan</div>
              <div>
                Inventory DB: <b>{status?.inventoryDbName || '…'}</b>
                {includeSales && (
                  <> · Sales DB: <b>{status?.salesDbName || '…'}</b></>
                )}
              </div>
              <div className="text-xs text-amber-800">
                Tetap dipertahankan: {status?.keepHint?.slice(0, 8).join(', ')}…
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <Label>Scope tenant</Label>
                <select
                  value={tenantId}
                  onChange={(e) => setTenantId(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mt-1"
                >
                  <option value="">Semua tenant</option>
                  {tenants.map((t) => (
                    <option key={t.tenantId} value={t.tenantId}>
                      {t.tenantId}{t.companyName ? ` — ${t.companyName}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeSales}
                    onChange={(e) => setIncludeSales(e.target.checked)}
                    className="rounded"
                  />
                  Sertakan database sales ({status?.salesDbName || 'kasir_db'})
                </label>
              </div>
            </div>

            <Button variant="outline" onClick={runPreview} disabled={loadingPreview}>
              {loadingPreview ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Eye className="w-4 h-4 mr-2" />}
              Preview (dry-run)
            </Button>

            {preview && (
              <div className="space-y-3">
                {[preview.inventory, preview.sales].filter(Boolean).map((db) => (
                  <div key={db!.label} className="border rounded-lg overflow-hidden">
                    <div className="bg-slate-50 px-3 py-2 text-sm font-semibold flex justify-between">
                      <span>{db!.label} ({db!.dbName})</span>
                      <span className="text-slate-500 font-normal">
                        {db!.summary.documents} dokumen · {db!.summary.collections} koleksi
                      </span>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-slate-500">
                          <th className="px-3 py-1.5">Koleksi</th>
                          <th className="px-3 py-1.5 text-right">Jumlah / dihapus</th>
                        </tr>
                      </thead>
                      <tbody>{renderCountRows(db!.counts)}</tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}

            <div className="border-t pt-4 space-y-3">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                  className="mt-1 rounded"
                />
                <span>
                  Saya paham ini akan menghapus transaksi
                  {tenantId ? ` untuk tenant "${tenantId}"` : ' untuk semua tenant'}
                  {includeSales ? ' di inventory dan sales' : ' di inventory'}.
                </span>
              </label>
              <div>
                <Label>Ketik frasa konfirmasi: <span className="font-mono">{status?.confirmPhrase}</span></Label>
                <Input
                  value={confirmPhrase}
                  onChange={(e) => setConfirmPhrase(e.target.value)}
                  placeholder={status?.confirmPhrase}
                  className="mt-1 font-mono"
                  autoComplete="off"
                />
              </div>
              <Button
                variant="destructive"
                onClick={runReset}
                disabled={resetting || !acknowledge || !confirmOk}
              >
                {resetting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Eraser className="w-4 h-4 mr-2" />}
                Reset sandbox sekarang
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
