'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { ArrowLeft, CheckCircle2, RefreshCw, XCircle, MinusCircle } from 'lucide-react';
import {
  QC_STATUS_LABELS,
  QC_UI_STATUS_NEXT,
  QC_UI_STATUS_NEXT_LABEL,
  isQcEditable,
  type QcResultStatus,
  type QcItemResult,
} from '@/lib/food-production/qc';

const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
const OPS_WRITE = new Set(['GUDANG', 'ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface QcRow {
  id: string;
  noDokumen: string;
  templateNama?: string;
  productionPlanNo?: string;
  tanggal: string;
  status: QcResultStatus;
  items: Array<{ key: string; label: string; result: QcItemResult; note?: string }>;
  summary?: { passCount: number; failCount: number; naCount: number };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function MobileQcPage() {
  const role = useMemo(() => String((getUser() as { role?: string } | null)?.role || ''), []);
  const canManage = MANAGE.has(role);
  const canLog = OPS_WRITE.has(role);
  const [rows, setRows] = useState<QcRow[]>([]);
  const [active, setActive] = useState<QcRow | null>(null);
  const [items, setItems] = useState<QcRow['items']>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tanggal, setTanggal] = useState(todayIso);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (tanggal) qs.set('tanggal', tanggal);
      const res = await fetch(`/api/qc-results?${qs}`, { headers: { ...actingTenantHeaders() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat');
      const list = (Array.isArray(data) ? data : []) as QcRow[];
      setRows(list.filter((r) => r.status !== 'CANCELLED' && r.status !== 'COMPLETED'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [tanggal]);

  useEffect(() => { void load(); }, [load]);

  async function openRow(row: QcRow) {
    const res = await fetch(`/api/qc-results/${row.id}`, { headers: { ...actingTenantHeaders() } });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    setActive(data as QcRow);
    setItems(data.items || []);
  }

  async function saveItems() {
    if (!active) return;
    if (!canLog) {
      toast.error('Peran Anda hanya bisa melihat');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/qc-results/${active.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Checklist tersimpan');
      setActive(data as QcRow);
      setItems(data.items || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function nextStatus() {
    if (!active) return;
    const next = QC_UI_STATUS_NEXT[active.status];
    if (!next) return;
    const allowed = next === 'SUBMITTED' ? canLog : canManage;
    if (!allowed) {
      toast.error(next === 'SUBMITTED'
        ? 'Peran Anda hanya bisa melihat'
        : 'Setujui/selesai butuh SUPERVISOR / ADMIN / OWNER');
      return;
    }
    try {
      const res = await fetch(`/api/qc-results/${active.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal status');
      toast.success(`→ ${QC_STATUS_LABELS[next]}`);
      if (next === 'COMPLETED') {
        setActive(null);
        await load();
        return;
      }
      setActive(data as QcRow);
      setItems(data.items || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  function setResult(idx: number, result: QcItemResult) {
    setItems((prev) => prev.map((x, i) => (i === idx ? { ...x, result } : x)));
  }

  if (active) {
    const editable = canLog && isQcEditable(active.status);
    const next = QC_UI_STATUS_NEXT[active.status];
    const canAdvance = next === 'SUBMITTED' ? canLog : canManage;
    return (
      <div className="mx-auto max-w-lg space-y-4 p-4 pb-24">
        <button type="button" className="flex items-center gap-1 text-sm text-muted-foreground" onClick={() => setActive(null)}>
          <ArrowLeft className="h-4 w-4" /> Kembali
        </button>
        {!canLog && (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
            Mode lihat saja.
          </div>
        )}
        {canLog && !canManage && active.status !== 'DRAFT' && active.status !== 'SUBMITTED' && (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
            Menunggu persetujuan SUPERVISOR+.
          </div>
        )}
        <div>
          <div className="font-mono text-sm text-muted-foreground">{active.noDokumen}</div>
          <h1 className="text-xl font-semibold">{active.templateNama || 'QC'}</h1>
          <div className="text-sm">{QC_STATUS_LABELS[active.status]} · {active.productionPlanNo || active.tanggal}</div>
        </div>
        <div className="space-y-3">
          {items.map((it, idx) => (
            <div key={it.key} className="rounded-xl border p-3">
              <div className="mb-2 font-medium">{it.label}</div>
              {editable ? (
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    type="button"
                    variant={it.result === 'PASS' ? 'default' : 'outline'}
                    className="h-14 flex-col gap-0.5"
                    onClick={() => setResult(idx, 'PASS')}
                  >
                    <CheckCircle2 className="h-5 w-5" />
                    PASS
                  </Button>
                  <Button
                    type="button"
                    variant={it.result === 'FAIL' ? 'destructive' : 'outline'}
                    className="h-14 flex-col gap-0.5"
                    onClick={() => setResult(idx, 'FAIL')}
                  >
                    <XCircle className="h-5 w-5" />
                    FAIL
                  </Button>
                  <Button
                    type="button"
                    variant={it.result === 'NA' ? 'secondary' : 'outline'}
                    className="h-14 flex-col gap-0.5"
                    onClick={() => setResult(idx, 'NA')}
                  >
                    <MinusCircle className="h-5 w-5" />
                    N/A
                  </Button>
                </div>
              ) : (
                <div className="text-lg font-semibold">{it.result}</div>
              )}
            </div>
          ))}
        </div>
        <div className="fixed inset-x-0 bottom-0 border-t bg-background p-3">
          <div className="mx-auto flex max-w-lg gap-2">
            {editable && (
              <Button className="h-12 flex-1 text-base" variant="outline" disabled={saving} onClick={() => void saveItems()}>
                Simpan
              </Button>
            )}
            {canAdvance && next && (
              <Button className="h-12 flex-1 text-base" onClick={() => void nextStatus()}>
                {QC_UI_STATUS_NEXT_LABEL[active.status]}
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4 pb-10">
      <Link href="/food-production/mobile" className="flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="h-4 w-4" /> Mode Dapur
      </Link>
      <OperationalScopeBar />
      {!canLog && (
        <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
          Mode lihat saja.
        </div>
      )}
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">QC Cepat</h1>
          <p className="text-sm text-muted-foreground">Checklist terbuka hari ini</p>
        </div>
        <Button variant="outline" size="sm" aria-label="Muat ulang" title="Muat ulang" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <Input type="date" className="h-12" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
      {loading && <p className="text-center text-muted-foreground py-8">Memuat…</p>}
      {!loading && rows.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
          Tidak ada QC terbuka. Buat di{' '}
          <Link href="/food-production/qc" className="underline">halaman penuh</Link>.
        </p>
      )}
      <div className="space-y-2">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => void openRow(row)}
            className="flex w-full min-h-[4.5rem] flex-col items-start rounded-xl border px-4 py-3 text-left active:bg-muted/40"
          >
            <div className="font-mono text-xs text-muted-foreground">{row.noDokumen}</div>
            <div className="text-base font-semibold">{row.templateNama || 'QC'}</div>
            <div className="text-sm text-muted-foreground">
              {QC_STATUS_LABELS[row.status]} · P{row.summary?.passCount ?? 0}/F{row.summary?.failCount ?? 0}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
