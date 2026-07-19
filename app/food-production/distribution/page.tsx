'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { Truck, Plus, RefreshCw, Eye, Trash2 } from 'lucide-react';
import {
  DIST_STATUS_LABELS,
  DIST_UI_STATUS_NEXT,
  DIST_UI_STATUS_NEXT_LABEL,
  type DistributionStatus,
} from '@/lib/food-production/distribution';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface ResultOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  productionPlanId?: string;
  productionPlanNo?: string;
  kitchenNama?: string;
  status: string;
  summary?: { actualPorsiTotal?: number };
}

interface SpOpt {
  id: string;
  kode?: string;
  nama: string;
  kapasitasPorsi?: number;
}

interface DistLine {
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  kapasitasPorsi?: number;
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  qtyPorsi: number;
  qtyDikirim?: number;
  qtyDiterima?: number;
  qtyDikembalikan?: number;
  notes?: string;
}

interface DistHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  userName?: string;
  note?: string;
  movementQtyPorsi?: number;
  movementLineCount?: number;
  photoUrls?: string[];
  lineActuals?: Array<{
    servicePointId: string;
    servicePointNama?: string;
    qty?: number;
    qtyDiterima?: number;
    qtyDikembalikan?: number;
    notes?: string;
  }>;
}

interface DistRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  sourceType: 'PLAN' | 'RESULT';
  productionPlanId?: string;
  productionPlanNo?: string;
  productionResultId?: string;
  productionResultNo?: string;
  kitchenNama?: string;
  status: DistributionStatus;
  lines?: DistLine[];
  history?: DistHistoryEntry[];
  catatan?: string;
  summary?: {
    lineCount: number;
    qtyPorsiTotal: number;
    qtyDikirimTotal?: number;
    qtyDiterimaTotal?: number;
    qtyDikembalikanTotal?: number;
    servicePointCount: number;
  };
}

interface StatusLineQty {
  key: string;
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  menuId?: string;
  finishedGoodProductId?: string;
  menuLabel: string;
  kapasitasPorsi?: number;
  qtyAlokasi: number;
  qtyDikirim: number;
  /** For Dikirim step: qty to ship. For Selesai: ignored in favor of diterima/kembali. */
  qty: number;
  qtyDiterima: number;
  qtyDikembalikan: number;
  note: string;
}

function DistributionPageContent() {
  const searchParams = useSearchParams();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<DistRow[]>([]);
  const [results, setResults] = useState<ResultOpt[]>([]);
  const [points, setPoints] = useState<SpOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DistRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusTarget, setStatusTarget] = useState<{ row: DistRow; next: DistributionStatus } | null>(null);
  const [statusPhotos, setStatusPhotos] = useState<string[]>([]);
  const [statusLineQtys, setStatusLineQtys] = useState<StatusLineQty[]>([]);
  const [statusSaving, setStatusSaving] = useState(false);
  const [resultId, setResultId] = useState('');
  const [selectedPoints, setSelectedPoints] = useState<string[]>([]);
  const [createNote, setCreateNote] = useState('');
  const [saving, setSaving] = useState(false);
  const deepLinkHandled = useRef<string | null>(null);

  /**
   * HSL tidak muncul di packing baru bila:
   * - pernah Diterima (COMPLETED / ada di history), atau
   * - masih punya DST aktif (bukan Dikembalikan).
   */
  const blockedResultIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of rows) {
      if (!d.productionResultId) continue;
      if (d.status !== 'CANCELLED') {
        ids.add(d.productionResultId);
        continue;
      }
      // Di cabang ini status sudah CANCELLED — cek jejak pernah selesai/diterima di history.
      const everReceived = (d.history || []).some((h) => h.toStatus === 'COMPLETED');
      if (everReceived) ids.add(d.productionResultId);
    }
    return ids;
  }, [rows]);

  const availableResults = useMemo(
    () => results.filter((r) => !blockedResultIds.has(r.id)),
    [results, blockedResultIds],
  );

  function defaultQtyForStatus(line: DistLine, next: DistributionStatus): number {
    if (next === 'PROCESSING') return Number(line.qtyDikirim ?? line.qtyPorsi) || 0;
    if (next === 'COMPLETED') return Number(line.qtyDiterima ?? line.qtyDikirim ?? line.qtyPorsi) || 0;
    return Number(line.qtyDikembalikan ?? line.qtyDiterima ?? line.qtyDikirim ?? line.qtyPorsi) || 0;
  }

  function buildStatusLineQtys(row: DistRow, next: DistributionStatus): StatusLineQty[] {
    return (row.lines || []).map((line, idx) => {
      const qtyDikirim = Number(line.qtyDikirim ?? line.qtyPorsi) || 0;
      const qtyDiterima = next === 'COMPLETED'
        ? (line.qtyDiterima != null ? Number(line.qtyDiterima) : qtyDikirim)
        : Number(line.qtyDiterima) || 0;
      const qtyDikembalikan = next === 'COMPLETED'
        ? (line.qtyDikembalikan != null ? Number(line.qtyDikembalikan) : 0)
        : Number(line.qtyDikembalikan) || 0;
      return {
        key: `${line.servicePointId}|${line.menuId || ''}|${line.finishedGoodProductId || ''}|${idx}`,
        servicePointId: line.servicePointId,
        servicePointKode: line.servicePointKode,
        servicePointNama: line.servicePointNama,
        menuId: line.menuId,
        finishedGoodProductId: line.finishedGoodProductId,
        menuLabel: line.finishedGoodNama || line.menuNama || line.finishedGoodKode || line.menuKode || '—',
        kapasitasPorsi: line.kapasitasPorsi,
        qtyAlokasi: Number(line.qtyPorsi) || 0,
        qtyDikirim,
        qty: defaultQtyForStatus(line, next),
        qtyDiterima,
        qtyDikembalikan,
        note: line.notes || '',
      };
    });
  }

  async function openStatusDialog(row: DistRow, next: DistributionStatus) {
    setStatusPhotos([]);
    let full = row;
    if (!row.lines?.length) {
      try {
        const res = await fetch(`/api/distribution-orders/${row.id}`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        });
        const data = await res.json();
        if (res.ok) full = data as DistRow;
      } catch {
        /* use row as-is */
      }
    }
    setStatusTarget({ row: full, next });
    setStatusLineQtys(buildStatusLineQtys(full, next));
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [dRes, rRes, sRes] = await Promise.all([
        fetch('/api/distribution-orders', { headers: hdr }),
        fetch('/api/production-results?status=COMPLETED', { headers: hdr }),
        fetch('/api/service-points?aktif=1', { headers: hdr }),
      ]);
      const dData = await dRes.json();
      const rData = await rRes.json();
      const sData = await sRes.json();
      if (!dRes.ok) throw new Error(dData?.error || 'Gagal memuat');
      setRows(Array.isArray(dData) ? dData : []);
      setResults(Array.isArray(rData) ? rData : []);
      setPoints(Array.isArray(sData) ? sData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  useEffect(() => {
    const fromPlan = searchParams.get('productionPlanId');
    const fromResult = searchParams.get('productionResultId');
    const key = fromResult ? `R:${fromResult}` : fromPlan ? `P:${fromPlan}` : null;
    if (!key) return;
    if (deepLinkHandled.current === key) return;
    if (loading) return;

    if (fromResult) {
      deepLinkHandled.current = key;
      if (blockedResultIds.has(fromResult)) {
        toast.message('HSL ini sudah / sedang diproses distribusi — tidak perlu packing ulang');
        return;
      }
      setResultId(fromResult);
      setOpen(true);
      return;
    }
    if (!fromPlan) return;

    const hsl = results.find(
      (r) => r.productionPlanId === fromPlan && r.status === 'COMPLETED' && !blockedResultIds.has(r.id),
    );
    deepLinkHandled.current = key;
    if (hsl) {
      setResultId(hsl.id);
      setOpen(true);
      toast.message(`Distribusi dari HSL ${hsl.noDokumen}`);
    } else {
      toast.message('Belum ada HSL siap packing untuk rencana ini — selesaikan Hasil Produksi dulu');
    }
  }, [searchParams, results, loading, blockedResultIds]);

  // Clear selected HSL if it becomes unavailable.
  useEffect(() => {
    if (resultId && blockedResultIds.has(resultId)) {
      setResultId('');
    }
  }, [resultId, blockedResultIds]);

  function togglePoint(id: string) {
    setSelectedPoints((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function create() {
    if (!resultId) {
      toast.error('Pilih hasil produksi');
      return;
    }
    if (!selectedPoints.length) {
      toast.error('Pilih minimal satu titik layanan');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/distribution-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          sourceType: 'RESULT',
          productionResultId: resultId,
          servicePointIds: selectedPoints,
          catatan: createNote.trim() || undefined,
          allocate: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      toast.success(`DST ${data.noDokumen} · ${data.summary?.qtyPorsiTotal || 0} porsi`);
      setOpen(false);
      setResultId('');
      setSelectedPoints([]);
      setCreateNote('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(row: DistRow) {
    setDetailLoading(true);
    setDetail(row);
    try {
      const res = await fetch(`/api/distribution-orders/${row.id}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat detail');
      setDetail(data as DistRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat detail');
    } finally {
      setDetailLoading(false);
    }
  }

  async function submitStatus() {
    if (!statusTarget) return;
    const { row, next } = statusTarget;
    if (next === 'COMPLETED') {
      for (const line of statusLineQtys) {
        if (!Number.isFinite(line.qtyDiterima) || line.qtyDiterima < 0) {
          toast.error('Qty diterima harus ≥ 0');
          return;
        }
        if (!Number.isFinite(line.qtyDikembalikan) || line.qtyDikembalikan < 0) {
          toast.error('Qty dikembalikan harus ≥ 0');
          return;
        }
        const sum = Number(line.qtyDiterima) + Number(line.qtyDikembalikan);
        if (Math.abs(sum - Number(line.qtyDikirim)) > 0.0001) {
          toast.error(
            `${line.servicePointNama || 'Titik'}: diterima + dikembalikan harus = dikirim (${line.qtyDikirim})`,
          );
          return;
        }
      }
    } else {
      for (const line of statusLineQtys) {
        if (!Number.isFinite(line.qty) || line.qty < 0) {
          toast.error('Qty per titik harus ≥ 0');
          return;
        }
      }
    }
    setStatusSaving(true);
    try {
      const res = await fetch(`/api/distribution-orders/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          status: next,
          photos: statusPhotos.length ? statusPhotos : undefined,
          lineActuals: statusLineQtys.map((l) => (
            next === 'COMPLETED'
              ? {
                servicePointId: l.servicePointId,
                menuId: l.menuId,
                finishedGoodProductId: l.finishedGoodProductId,
                qtyDiterima: l.qtyDiterima,
                qtyDikembalikan: l.qtyDikembalikan,
                notes: l.note,
              }
              : {
                servicePointId: l.servicePointId,
                menuId: l.menuId,
                finishedGoodProductId: l.finishedGoodProductId,
                qty: l.qty,
                notes: l.note,
              }
          )),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      const moved = next === 'COMPLETED'
        ? statusLineQtys.reduce((s, l) => s + Number(l.qtyDiterima) + Number(l.qtyDikembalikan), 0)
        : statusLineQtys.reduce((s, l) => s + (Number(l.qty) || 0), 0);
      toast.success(`Status → ${DIST_STATUS_LABELS[next]} · ${moved} porsi`);
      setStatusTarget(null);
      setStatusPhotos([]);
      setStatusLineQtys([]);
      await load();
      if (detail?.id === row.id) setDetail(data as DistRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setStatusSaving(false);
    }
  }

  async function cancelDraft(row: DistRow) {
    if (row.status !== 'DRAFT' && row.status !== 'SUBMITTED' && row.status !== 'APPROVED') {
      toast.error('Hanya packing Disiapkan yang bisa dibatalkan');
      return;
    }
    const okConfirm = window.confirm(`Batalkan packing ${row.noDokumen}?`);
    if (!okConfirm) return;
    try {
      const res = await fetch(`/api/distribution-orders/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      toast.success('Packing dibatalkan');
      if (detail?.id === row.id) setDetail(null);
      await load();
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
            <Truck className="h-5 w-5" />
            Distribusi / Packing
          </h1>
          <p className="text-sm text-muted-foreground">
            Packing list dari HSL — disiapkan → dikirim → selesai per titik (diterima / dikembalikan)
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Packing baru
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No DST</th>
              <th className="text-left p-3">Sumber</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Tanggal</th>
              <th className="text-right p-3">Porsi</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Belum ada distribusi</td></tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-t hover:bg-muted/40 cursor-pointer"
                onClick={() => void openDetail(row)}
              >
                <td className="p-3 font-mono text-xs text-primary hover:underline">{row.noDokumen}</td>
                <td className="p-3 text-xs">
                  {row.sourceType === 'RESULT' ? 'HSL' : 'RPN'}{' '}
                  {row.productionResultNo || row.productionPlanNo}
                  {row.summary?.servicePointCount != null && (
                    <span className="text-muted-foreground"> · {row.summary.servicePointCount} titik</span>
                  )}
                </td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3">{row.tanggal}</td>
                <td className="p-3 text-right">
                  {row.summary?.qtyDiterimaTotal
                    ? `${row.summary.qtyDiterimaTotal} diterima`
                    : row.summary?.qtyDikirimTotal
                      ? `${row.summary.qtyDikirimTotal} dikirim`
                      : (row.summary?.qtyPorsiTotal ?? '—')}
                </td>
                <td className="p-3">{DIST_STATUS_LABELS[row.status]}</td>
                <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap gap-1 justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      title="Detail"
                      onClick={() => void openDetail(row)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {canManage && DIST_UI_STATUS_NEXT[row.status] && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void openStatusDialog(row, DIST_UI_STATUS_NEXT[row.status] as DistributionStatus)}
                      >
                        {DIST_UI_STATUS_NEXT_LABEL[row.status] || 'Lanjut'}
                      </Button>
                    )}
                    {canManage && (row.status === 'DRAFT' || row.status === 'SUBMITTED' || row.status === 'APPROVED') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Batalkan packing"
                        onClick={() => void cancelDraft(row)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail ? DIST_STATUS_LABELS[detail.status] : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                Sumber {detail.sourceType === 'RESULT' ? 'HSL' : 'RPN'}{' '}
                <span className="font-mono text-foreground">
                  {detail.productionResultNo || detail.productionPlanNo || '—'}
                </span>
                {' · '}{detail.tanggal} · {detail.kitchenNama || '—'}
                {detail.summary && (
                  <>
                    {' · '}{detail.summary.qtyPorsiTotal} porsi
                    {' · '}{detail.summary.servicePointCount} titik
                  </>
                )}
              </div>
              {detail.catatan && (
                <p className="text-xs text-muted-foreground border rounded-md p-2">{detail.catatan}</p>
              )}
              {detailLoading ? (
                <p className="text-muted-foreground py-4 text-center">Memuat detail…</p>
              ) : (
                <div className="rounded-md border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="text-left p-2">Titik layanan</th>
                        <th className="text-left p-2">Menu</th>
                        <th className="text-right p-2">Kapasitas</th>
                        <th className="text-right p-2">Alokasi</th>
                        <th className="text-right p-2">Dikirim</th>
                        <th className="text-right p-2">Diterima</th>
                        <th className="text-right p-2">Kembali</th>
                        <th className="text-left p-2">Komentar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail.lines || []).length === 0 && (
                        <tr>
                          <td colSpan={8} className="p-4 text-center text-muted-foreground">
                            Tidak ada baris alokasi
                          </td>
                        </tr>
                      )}
                      {(detail.lines || []).map((line, idx) => (
                        <tr key={`${line.servicePointId}-${idx}`} className="border-t">
                          <td className="p-2">
                            <div className="font-medium">
                              {line.servicePointNama || line.servicePointId}
                            </div>
                            {line.servicePointKode && (
                              <div className="text-xs font-mono text-muted-foreground">
                                {line.servicePointKode}
                              </div>
                            )}
                          </td>
                          <td className="p-2">
                            {line.finishedGoodNama || line.menuNama || '—'}
                            {(line.finishedGoodKode || line.menuKode) && (
                              <div className="text-xs font-mono text-muted-foreground">
                                {line.finishedGoodKode || line.menuKode}
                              </div>
                            )}
                          </td>
                          <td className="p-2 text-right text-muted-foreground">
                            {line.kapasitasPorsi ?? '—'}
                          </td>
                          <td className="p-2 text-right font-medium">{line.qtyPorsi}</td>
                          <td className="p-2 text-right">{line.qtyDikirim ?? '—'}</td>
                          <td className="p-2 text-right">{line.qtyDiterima ?? '—'}</td>
                          <td className="p-2 text-right">{line.qtyDikembalikan ?? '—'}</td>
                          <td className="p-2 text-muted-foreground max-w-[12rem] truncate" title={line.notes || ''}>
                            {line.notes || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {(detail.history || []).length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Riwayat</p>
                  <ul className="text-xs space-y-2 max-h-48 overflow-y-auto border rounded-md p-2">
                    {(detail.history || []).map((h, i) => (
                      <li key={i} className="space-y-1">
                        <div className="flex gap-2">
                          <span className="text-muted-foreground shrink-0">
                            {h.at ? new Date(h.at).toLocaleString('id-ID') : '—'}
                          </span>
                          <span>
                            {h.fromStatus
                              ? `${DIST_STATUS_LABELS[h.fromStatus as DistributionStatus] || h.fromStatus} → `
                              : ''}
                            {DIST_STATUS_LABELS[h.toStatus as DistributionStatus] || h.toStatus || '—'}
                            {h.userName ? ` · ${h.userName}` : ''}
                            {h.movementQtyPorsi != null ? ` · ${h.movementQtyPorsi} porsi` : ''}
                            {h.note ? ` — ${h.note}` : ''}
                          </span>
                        </div>
                        {!!h.lineActuals?.length && (
                          <div className="pl-1 text-[11px] text-muted-foreground space-y-0.5">
                            {h.lineActuals.map((la, li) => (
                              <div key={`${i}-la-${li}`}>
                                {la.servicePointNama || la.servicePointId}:{' '}
                                {la.qtyDiterima != null || la.qtyDikembalikan != null
                                  ? `terima ${la.qtyDiterima ?? 0} / kembali ${la.qtyDikembalikan ?? 0}`
                                  : `${la.qty ?? 0} porsi`}
                                {la.notes ? ` — ${la.notes}` : ''}
                              </div>
                            ))}
                          </div>
                        )}
                        {!!h.photoUrls?.length && (
                          <div className="flex flex-wrap gap-1 pl-1">
                            {h.photoUrls.map((src, pi) => (
                              <a
                                key={`${i}-${pi}`}
                                href={src}
                                target="_blank"
                                rel="noreferrer"
                                className="block w-14 h-14 rounded border overflow-hidden bg-muted"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={src} alt={`Foto ${pi + 1}`} className="w-full h-full object-cover" />
                              </a>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-0">
                {canManage && DIST_UI_STATUS_NEXT[detail.status] && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openStatusDialog(detail, DIST_UI_STATUS_NEXT[detail.status] as DistributionStatus)}
                  >
                    {DIST_UI_STATUS_NEXT_LABEL[detail.status] || 'Lanjut'}
                  </Button>
                )}
                {canManage && (detail.status === 'DRAFT' || detail.status === 'SUBMITTED' || detail.status === 'APPROVED') && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void cancelDraft(detail)}
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Batalkan
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => setDetail(null)}>
                  Tutup
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!statusTarget}
        onOpenChange={(o) => {
          if (!o) {
            setStatusTarget(null);
            setStatusPhotos([]);
            setStatusLineQtys([]);
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {statusTarget ? `Ubah status ke ${DIST_STATUS_LABELS[statusTarget.next]}` : 'Ubah status'}
            </DialogTitle>
          </DialogHeader>
          {statusTarget && (
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">No DST</span>
                  <span className="font-mono">{statusTarget.row.noDokumen}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    {statusTarget.next === 'COMPLETED' ? 'Total selesai' : 'Total dikirim'}
                  </span>
                  <span className="font-medium">
                    {statusTarget.next === 'COMPLETED'
                      ? statusLineQtys.reduce(
                        (s, l) => s + Number(l.qtyDiterima || 0) + Number(l.qtyDikembalikan || 0),
                        0,
                      )
                      : statusLineQtys.reduce((s, l) => s + (Number(l.qty) || 0), 0)
                    }{' '}
                    porsi
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Status</span>
                  <span>
                    {DIST_STATUS_LABELS[statusTarget.row.status]} → {DIST_STATUS_LABELS[statusTarget.next]}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>
                  {statusTarget.next === 'COMPLETED'
                    ? 'Selesaikan per titik: diterima + dikembalikan (= dikirim)'
                    : 'Qty dikirim & komentar per titik'}
                </Label>
                <div className="rounded-md border overflow-x-auto">
                  {statusTarget.next === 'COMPLETED' ? (
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2 min-w-[9rem]">Titik</th>
                          <th className="text-right p-2">Dikirim</th>
                          <th className="text-right p-2">Diterima</th>
                          <th className="text-right p-2">Dikembalikan</th>
                          <th className="text-left p-2 min-w-[12rem]">Komentar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusLineQtys.map((line) => {
                          const sum = Number(line.qtyDiterima || 0) + Number(line.qtyDikembalikan || 0);
                          const ok = Math.abs(sum - Number(line.qtyDikirim)) < 0.0001;
                          return (
                            <tr key={line.key} className="border-t align-top">
                              <td className="p-2">
                                <div className="font-medium">
                                  {line.servicePointNama || line.servicePointId}
                                </div>
                                <div className="text-muted-foreground">
                                  {line.servicePointKode ? `${line.servicePointKode} · ` : ''}
                                  {line.menuLabel}
                                </div>
                                {!ok && (
                                  <div className="text-[10px] text-destructive mt-0.5">
                                    Jumlah {sum} ≠ dikirim {line.qtyDikirim}
                                  </div>
                                )}
                              </td>
                              <td className="p-2 text-right font-medium">{line.qtyDikirim}</td>
                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  className="w-20 h-8 border rounded-md px-2 text-right"
                                  value={line.qtyDiterima}
                                  disabled={statusSaving}
                                  onChange={(e) => {
                                    const raw = Number(e.target.value);
                                    const qtyDiterima = Number.isFinite(raw)
                                      ? Math.max(0, Math.min(raw, line.qtyDikirim))
                                      : 0;
                                    setStatusLineQtys((prev) =>
                                      prev.map((p) =>
                                        p.key === line.key
                                          ? {
                                            ...p,
                                            qtyDiterima,
                                            qtyDikembalikan: Math.max(0, line.qtyDikirim - qtyDiterima),
                                          }
                                          : p,
                                      ),
                                    );
                                  }}
                                />
                              </td>
                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  className="w-20 h-8 border rounded-md px-2 text-right"
                                  value={line.qtyDikembalikan}
                                  disabled={statusSaving}
                                  onChange={(e) => {
                                    const raw = Number(e.target.value);
                                    const qtyDikembalikan = Number.isFinite(raw)
                                      ? Math.max(0, Math.min(raw, line.qtyDikirim))
                                      : 0;
                                    setStatusLineQtys((prev) =>
                                      prev.map((p) =>
                                        p.key === line.key
                                          ? {
                                            ...p,
                                            qtyDikembalikan,
                                            qtyDiterima: Math.max(0, line.qtyDikirim - qtyDikembalikan),
                                          }
                                          : p,
                                      ),
                                    );
                                  }}
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  className="w-full min-w-[10rem] h-8 border rounded-md px-2"
                                  value={line.note}
                                  disabled={statusSaving}
                                  placeholder="Catatan titik…"
                                  onChange={(e) => {
                                    const note = e.target.value;
                                    setStatusLineQtys((prev) =>
                                      prev.map((p) => (p.key === line.key ? { ...p, note } : p)),
                                    );
                                  }}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2 min-w-[9rem]">Titik</th>
                          <th className="text-right p-2">Kapasitas</th>
                          <th className="text-right p-2">Alokasi</th>
                          <th className="text-right p-2">Dikirim</th>
                          <th className="text-left p-2 min-w-[12rem]">Komentar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusLineQtys.map((line) => (
                          <tr key={line.key} className="border-t align-top">
                            <td className="p-2">
                              <div className="font-medium">
                                {line.servicePointNama || line.servicePointId}
                              </div>
                              <div className="text-muted-foreground">
                                {line.servicePointKode ? `${line.servicePointKode} · ` : ''}
                                {line.menuLabel}
                              </div>
                            </td>
                            <td className="p-2 text-right text-muted-foreground">
                              {line.kapasitasPorsi ?? '—'}
                            </td>
                            <td className="p-2 text-right">{line.qtyAlokasi}</td>
                            <td className="p-2 text-right">
                              <input
                                type="number"
                                min={0}
                                step={1}
                                className="w-20 h-8 border rounded-md px-2 text-right"
                                value={line.qty}
                                disabled={statusSaving}
                                onChange={(e) => {
                                  const qty = Number(e.target.value);
                                  setStatusLineQtys((prev) =>
                                    prev.map((p) =>
                                      p.key === line.key
                                        ? { ...p, qty: Number.isFinite(qty) ? qty : 0 }
                                        : p,
                                    ),
                                  );
                                }}
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                className="w-full min-w-[10rem] h-8 border rounded-md px-2"
                                value={line.note}
                                disabled={statusSaving}
                                placeholder="Catatan titik…"
                                onChange={(e) => {
                                  const note = e.target.value;
                                  setStatusLineQtys((prev) =>
                                    prev.map((p) => (p.key === line.key ? { ...p, note } : p)),
                                  );
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {statusTarget.next === 'COMPLETED'
                    ? 'Per titik: isi berapa yang diterima dan berapa yang dikembalikan. Jumlah keduanya harus sama dengan qty dikirim. Setelah semua titik selesai, status jadi Selesai.'
                    : 'Isi qty yang dikirim ke masing-masing titik. Retur hanya dicatat saat penyelesaian per titik.'}
                </p>
              </div>

              <PhotoUploadField
                label="Foto bukti"
                hint="Opsional. Maks. 3 foto, otomatis dikompres sebelum disimpan."
                photos={statusPhotos}
                onChange={setStatusPhotos}
                maxPhotos={3}
                disabled={statusSaving}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStatusTarget(null)}>
              Batal
            </Button>
            <Button
              type="button"
              onClick={() => void submitStatus()}
              disabled={statusSaving}
            >
              {statusSaving
                ? 'Menyimpan…'
                : statusTarget?.next === 'COMPLETED'
                  ? 'Selesaikan distribusi'
                  : statusTarget
                    ? DIST_STATUS_LABELS[statusTarget.next]
                    : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setResultId('');
            setSelectedPoints([]);
            setCreateNote('');
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Packing / Distribusi baru</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label>Hasil produksi (HSL)</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={resultId}
                onChange={(e) => setResultId(e.target.value)}
              >
                <option value="">— Pilih HSL —</option>
                {availableResults.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.noDokumen} · {r.tanggal} · {r.kitchenNama || ''}
                  </option>
                ))}
              </select>
                {availableResults.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Tidak ada HSL siap packing — HSL yang masih aktif / sudah diterima tidak ditampilkan.
                  </p>
                )}
            </div>
            <div className="space-y-2">
              <Label>Titik layanan (alokasi otomatis berbobot kapasitas)</Label>
              <div className="max-h-48 overflow-y-auto border rounded-md p-2 space-y-1">
                {points.length === 0 && (
                  <p className="text-xs text-muted-foreground">Belum ada titik aktif — buat di Titik Layanan.</p>
                )}
                {points.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={selectedPoints.includes(p.id)}
                      onChange={() => togglePoint(p.id)}
                    />
                    <span>
                      {p.kode ? `${p.kode} · ` : ''}{p.nama}
                      {p.kapasitasPorsi != null ? ` (${p.kapasitasPorsi} porsi)` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Komentar / Catatan disiapkan</Label>
              <Textarea
                value={createNote}
                onChange={(e) => setCreateNote(e.target.value)}
                rows={2}
                placeholder="Contoh: packing pagi, prioritas sekolah, instruksi driver, dll."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void create()} disabled={saving || !resultId || availableResults.length === 0}>
              {saving ? 'Menyimpan…' : 'Buat DST'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DistributionPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat distribusi…</div>}>
      <DistributionPageContent />
    </Suspense>
  );
}
