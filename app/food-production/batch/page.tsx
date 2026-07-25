'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { PackageOpen, RefreshCw, Download, ShieldCheck } from 'lucide-react';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface BatchRow {
  id: string;
  batchNo: string;
  productionResultNo?: string;
  kitchenNama?: string;
  finishedGoodNama?: string;
  qty: number;
  qtyRemaining?: number;
  satuan?: string;
  producedAt: string;
  expiryDate: string;
  status: string;
  expired?: boolean;
  daysUntilExpiry?: number | null;
}

export default function ProductionBatchPage() {
  const router = useRouter();
  const canExport = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expiringWithin, setExpiringWithin] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (expiringWithin) qs.set('expiringWithinDays', expiringWithin);
      const res = await fetch(`/api/production-batches?${qs}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat batch');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [expiringWithin]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  async function exportTrail(row: BatchRow, format: 'csv' | 'json') {
    try {
      const res = await fetch(
        `/api/production-batches/${row.id}/audit-trail?export=${format}`,
        { headers: { ...actingTenantHeaders() } },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string })?.error || 'Gagal export');
      }
      if (format === 'csv') {
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `batch-trail-${row.batchNo}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast.success('CSV trail diunduh');
      } else {
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `batch-trail-${row.batchNo}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast.success('JSON trail diunduh');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <PackageOpen className="h-5 w-5" />
            Batch &amp; Expiry
          </h1>
          <p className="text-sm text-muted-foreground">
            Batch di-stamp saat HSL selesai — FEFO consume on Release · pantau qtyRemaining
          </p>
        </div>
        <div className="flex gap-2 items-end">
          <div className="space-y-1">
            <Label className="text-xs">Expiring ≤ hari</Label>
            <select
              className="h-9 border rounded-md px-2 text-sm bg-white"
              value={expiringWithin}
              onChange={(e) => setExpiringWithin(e.target.value)}
            >
              <option value="">Semua</option>
              <option value="0">Sudah expired / hari ini</option>
              <option value="3">≤ 3 hari</option>
              <option value="7">≤ 7 hari</option>
            </select>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Batch</th>
              <th className="text-left p-3">FG / HSL</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-right p-3">Qty / Sisa</th>
              <th className="text-left p-3">Produksi</th>
              <th className="text-left p-3">Expiry</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Belum ada batch — selesaikan HSL dulu</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className={`border-t ${row.expired || (row.daysUntilExpiry != null && row.daysUntilExpiry <= 0) ? 'bg-red-50' : ''}`}>
                <td className="p-3 font-mono text-xs">{row.batchNo}</td>
                <td className="p-3">
                  <div>{row.finishedGoodNama || '—'}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">{row.productionResultNo}</div>
                </td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3 text-right">
                  <div>{row.qty} {row.satuan || ''}</div>
                  {row.qtyRemaining != null && (
                    <div className="text-[11px] text-muted-foreground">sisa {row.qtyRemaining}</div>
                  )}
                </td>
                <td className="p-3">{row.producedAt}</td>
                <td className="p-3">
                  {row.expiryDate}
                  {row.daysUntilExpiry != null && (
                    <div className="text-[11px] text-muted-foreground">{row.daysUntilExpiry} hari</div>
                  )}
                </td>
                <td className="p-3">{row.status}</td>
                <td className="p-3 text-right space-x-1 whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    title="HACCP"
                    onClick={() => router.push('/food-production/haccp')}
                  >
                    <ShieldCheck className="h-4 w-4" />
                  </Button>
                  {canExport && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Export CSV trail"
                        onClick={() => void exportTrail(row, 'csv')}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Export JSON trail"
                        onClick={() => void exportTrail(row, 'json')}
                      >
                        JSON
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
