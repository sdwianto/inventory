'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react';
import {
  ISSUE_STATUS_LABELS,
  ISSUE_UI_STATUS_NEXT,
  ISSUE_UI_STATUS_NEXT_LABEL,
  isIssueEditable,
  type MaterialIssueStatus,
} from '@/lib/food-production/material-issue';

const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface IssueLine {
  productId: string;
  productKode?: string;
  productNama?: string;
  satuan?: string;
  qtyPlanned: number;
  qtyIssued: number;
}

interface IssueRow {
  id: string;
  noDokumen: string;
  productionPlanNo?: string;
  tanggal: string;
  kitchenNama?: string;
  status: MaterialIssueStatus;
  lines: IssueLine[];
  summary?: { lineCount: number; qtyIssuedTotal: number };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function ReadOnlyBanner() {
  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-100">
      Mode lihat saja — ubah qty/status butuh SUPERVISOR / ADMIN / OWNER.
    </div>
  );
}

export default function MobileIssuePage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => MANAGE.has(String((getUser() as { role?: string } | null)?.role || '')), []);
  const [rows, setRows] = useState<IssueRow[]>([]);
  const [active, setActive] = useState<IssueRow | null>(null);
  const [lines, setLines] = useState<IssueLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tanggal, setTanggal] = useState(todayIso);

  const hdr = () => ({ ...actingTenantHeaders(), ...actingKitchenHeaders() });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (tanggal) qs.set('tanggal', tanggal);
      const res = await fetch(`/api/material-issues?${qs}`, { headers: hdr() });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat');
      const list = (Array.isArray(data) ? data : []) as IssueRow[];
      setRows(list.filter((r) => r.status !== 'CANCELLED' && r.status !== 'COMPLETED'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [tanggal]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  async function openRow(row: IssueRow) {
    const res = await fetch(`/api/material-issues/${row.id}`, { headers: hdr() });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal detail');
      return;
    }
    setActive(data as IssueRow);
    setLines(Array.isArray(data.lines) ? data.lines : []);
  }

  async function saveLines() {
    if (!active) return;
    if (!canManage) {
      toast.error('Peran Anda hanya bisa melihat');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/material-issues/${active.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...hdr() },
        body: JSON.stringify({ lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Qty tersimpan');
      setActive(data as IssueRow);
      setLines(data.lines || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function nextStatus() {
    if (!active) return;
    if (!canManage) {
      toast.error('Peran Anda hanya bisa melihat');
      return;
    }
    const next = ISSUE_UI_STATUS_NEXT[active.status];
    if (!next) return;
    if (next === 'COMPLETED') {
      const ok = await confirm({
        title: 'Selesai & post stok keluar?',
        description: `${active.noDokumen} akan mengurangi stok gudang dapur. Tidak bisa dibatalkan.`,
        confirmText: 'Post Stok',
      });
      if (!ok) return;
    }
    try {
      const res = await fetch(`/api/material-issues/${active.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hdr() },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal status');
      toast.success(`→ ${ISSUE_STATUS_LABELS[next]}`);
      if (next === 'COMPLETED') {
        setActive(null);
        await load();
        return;
      }
      setActive(data as IssueRow);
      setLines(data.lines || []);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  if (active) {
    const editable = canManage && isIssueEditable(active.status);
    const next = ISSUE_UI_STATUS_NEXT[active.status];
    return (
      <div className="mx-auto max-w-lg space-y-4 p-4 pb-24">
        <button type="button" className="flex items-center gap-1 text-sm text-muted-foreground" onClick={() => setActive(null)}>
          <ArrowLeft className="h-4 w-4" /> Kembali
        </button>
        {!canManage && <ReadOnlyBanner />}
        <div>
          <div className="font-mono text-sm text-muted-foreground">{active.noDokumen}</div>
          <h1 className="text-xl font-semibold">{active.productionPlanNo || 'Pengambilan'}</h1>
          <div className="text-sm">{ISSUE_STATUS_LABELS[active.status]} · {active.tanggal}</div>
        </div>
        <div className="space-y-3">
          {lines.map((l, idx) => (
            <div key={`${l.productId}-${idx}`} className="rounded-xl border p-3">
              <div className="font-medium">{l.productNama || l.productId}</div>
              <div className="text-xs text-muted-foreground">Rencana {l.qtyPlanned} {l.satuan || ''}</div>
              {editable ? (
                <Input
                  type="number"
                  inputMode="decimal"
                  className="mt-2 h-12 text-lg"
                  value={l.qtyIssued}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setLines((prev) => prev.map((x, i) => (i === idx ? { ...x, qtyIssued: Number.isFinite(v) ? v : 0 } : x)));
                  }}
                />
              ) : (
                <div className="mt-2 text-2xl font-semibold">{l.qtyIssued}</div>
              )}
            </div>
          ))}
        </div>
        <div className="fixed inset-x-0 bottom-0 border-t bg-background p-3">
          <div className="mx-auto flex max-w-lg gap-2">
            {editable && (
              <Button className="h-12 flex-1 text-base" variant="outline" disabled={saving} onClick={() => void saveLines()}>
                Simpan Qty
              </Button>
            )}
            {canManage && next && (
              <Button className="h-12 flex-1 text-base" onClick={() => void nextStatus()}>
                <CheckCircle2 className="mr-1 h-5 w-5" />
                {ISSUE_UI_STATUS_NEXT_LABEL[active.status]}
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
      <KitchenScopeBar />
      {!canManage && <ReadOnlyBanner />}
      <div className="flex items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Ambil Bahan</h1>
          <p className="text-sm text-muted-foreground">Dokumen terbuka hari ini</p>
        </div>
        <Button variant="outline" size="sm" aria-label="Muat ulang" title="Muat ulang" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>
      <Input type="date" className="h-12" value={tanggal} onChange={(e) => setTanggal(e.target.value)} />
      {loading && <p className="text-center text-muted-foreground py-8">Memuat…</p>}
      {!loading && rows.length === 0 && (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
          Tidak ada PBL terbuka. Buat di{' '}
          <Link href="/food-production/issue" className="underline">halaman penuh</Link>.
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
            <div className="text-base font-semibold">{row.productionPlanNo || row.kitchenNama || '—'}</div>
            <div className="text-sm text-muted-foreground">
              {ISSUE_STATUS_LABELS[row.status]} · {row.summary?.lineCount ?? row.lines?.length ?? 0} baris
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
