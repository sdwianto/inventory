'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asArray, asObject } from '@/types/json';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { TableSkeleton } from '@/components/TableSkeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Undo2, Eye, Plus, RefreshCw, Loader2, Trash2 } from 'lucide-react';
import { formatIDR, formatDateTime, formatNumber } from '@/lib/format';
import { useCursorQuery } from '@/lib/hooks/use-cursor-query';
import { queryKeys } from '@/lib/query-keys';
import { useQueryClient } from '@/lib/hooks/useApiQuery';
import { fetchJson } from '@/lib/fetch-json';
import { WAREHOUSES, warehouseName } from '@/lib/warehouses-client';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { invalidateHutangCaches } from '@/lib/hooks/invalidate-operational';
import { useSessionUser } from '@/lib/hooks/use-session-user';

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-blue-100 text-blue-800',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  POSTING: 'bg-orange-100 text-orange-800',
  POSTED: 'bg-green-100 text-green-800',
};

const RTV_APPROVE_ROLES = ['SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER'];

const CN_STYLE: Record<string, string> = {
  NONE: 'text-slate-500',
  SYNCING: 'text-blue-600',
  DONE: 'text-green-700',
  FAILED: 'text-red-700',
  SKIPPED: 'text-slate-500',
};

function isOverdue(row: JsonObject): boolean {
  const decision = str(row.vendorDecision);
  if (!['PENDING', 'PARTIAL'].includes(decision)) return false;
  const due = str(row.vendorDecisionDueAt);
  if (!due) return false;
  return new Date(due).getTime() < Date.now();
}

function cnLabel(row: JsonObject) {
  // ADR-006 — keputusan vendor per baris didahulukan, fallback ke status sinkron CN mentah.
  const decision = str(row.vendorDecision);
  if (decision === 'PENDING') {
    return <span className="text-xs text-amber-700">Menunggu vendor</span>;
  }
  if (decision === 'PARTIAL') {
    return <span className="text-xs text-amber-700">Sebagian ditolak</span>;
  }
  if (decision === 'REJECTED') {
    return <span className="text-xs text-red-700">Ditolak vendor</span>;
  }

  const st = str(row.cnSyncStatus) || 'NONE';
  if (st === 'SYNCING') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-600">
        <Loader2 className="w-3 h-3 animate-spin" /> Menyinkronkan CN…
      </span>
    );
  }
  if (st === 'FAILED') {
    return <span className="text-xs text-red-700">CN gagal</span>;
  }
  if (st === 'DONE') return <span className="text-xs text-green-700">{str(row.noCN) || 'CN OK'}</span>;
  if (st === 'SKIPPED') return <span className="text-xs text-slate-500">Tanpa Sales</span>;
  return <span className="text-xs text-slate-400">—</span>;
}

export default function ReturVendorPage() {
  const searchParams = useSearchParams();
  const user = useSessionUser();
  const qc = useQueryClient();
  const hutangIdParam = searchParams.get('hutangId') || '';
  const [statusFilter, setStatusFilter] = useState('');
  const [decisionFilter, setDecisionFilter] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [eligibleOpen, setEligibleOpen] = useState(false);
  const [eligible, setEligible] = useState<JsonObject[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [acting, setActing] = useState('');
  const [creatingFromHutang, setCreatingFromHutang] = useState(false);
  const hutangCreateRef = useRef('');

  const canApproveRole = !!user && (
    user.role === 'MASTER'
    || RTV_APPROVE_ROLES.includes(str(user.role))
  );

  const listUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter) p.set('status', statusFilter);
    if (decisionFilter) p.set('vendorDecision', decisionFilter);
    if (q) p.set('q', q);
    const qs = p.toString();
    return `/api/vendor-returns${qs ? `?${qs}` : ''}`;
  }, [statusFilter, decisionFilter, q]);

  const {
    items: rows,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    reload,
  } = useCursorQuery<JsonObject>(
    queryKeys.vendorReturns.list({ status: statusFilter, vendorDecision: decisionFilter, q }),
    listUrl,
    { limit: 80 },
  );

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.vendorReturns.all });
    invalidateHutangCaches(qc);
    void reload();
  };

  const loadDetail = async (id: string) => {
    const data = await fetchJson<JsonObject>(`/api/vendor-returns/${id}`);
    setDetail(data);
  };

  const createFromHutang = async (hutangId: string) => {
    setActing('create');
    try {
      const created = await fetchJson<JsonObject>('/api/vendor-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hutangId }),
      });
      toast.success(`Draft ${str(created.noReturn)} dibuat`);
      setEligibleOpen(false);
      invalidate();
      await loadDetail(str(created.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal buat retur');
    } finally {
      setActing('');
    }
  };

  useEffect(() => {
    if (!hutangIdParam || hutangCreateRef.current === hutangIdParam) return;
    hutangCreateRef.current = hutangIdParam;
    setCreatingFromHutang(true);
    void createFromHutang(hutangIdParam).finally(() => setCreatingFromHutang(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per hutangId
  }, [hutangIdParam]);

  const openEligible = async () => {
    setEligibleOpen(true);
    setEligibleLoading(true);
    try {
      const data = await fetchJson<JsonObject[] | { items?: JsonObject[] }>(
        '/api/vendor-returns/eligible-invoices',
      );
      setEligible((Array.isArray(data) ? data : asArray(data.items)) as JsonObject[]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat tagihan');
    } finally {
      setEligibleLoading(false);
    }
  };

  const saveDraft = async () => {
    if (!detail?.id) return;
    setActing('save');
    try {
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: detail.reason,
          photos: detail.photos || [],
          items: asArray(detail.items),
        }),
      });
      setDetail(data);
      toast.success('Draft disimpan');
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal simpan');
    } finally {
      setActing('');
    }
  };

  const submitReturn = async () => {
    if (!detail?.id) return;
    if (!str(detail.reason).trim()) {
      toast.error('Alasan retur wajib sebelum diajukan');
      return;
    }
    setActing('submit');
    try {
      await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: detail.reason,
          photos: detail.photos || [],
          items: asArray(detail.items),
        }),
      });
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: detail.reason }),
      });
      setDetail(data);
      toast.success(`RTV ${str(data.noReturn)} diajukan — menunggu approval`);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal ajukan');
    } finally {
      setActing('');
    }
  };

  const approveReturn = async () => {
    if (!detail?.id) return;
    setActing('approve');
    try {
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: detail.reason,
          photos: detail.photos || [],
          items: asArray(detail.items),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      setDetail(data);
      if (str(data.cnSyncStatus) === 'FAILED') {
        toast.error(str(data.cnSyncError) || 'Stok sudah keluar — faktur kredit belum terbentuk');
      } else if (str(data.cnSyncStatus) === 'SYNCING') {
        toast.message('Disetujui — stok keluar, credit note masih disinkronkan');
      } else {
        toast.success(`RTV ${str(data.noReturn)} disetujui & diposting`);
      }
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal approve');
      if (detail.id) await loadDetail(str(detail.id)).catch(() => {});
    } finally {
      setActing('');
    }
  };

  const returnToDraft = async () => {
    if (!detail?.id) return;
    setActing('withdraw');
    try {
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}/return-to-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setDetail(data);
      toast.success('Retur dikembalikan ke draft');
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal kembalikan ke draft');
    } finally {
      setActing('');
    }
  };

  const retryCn = async () => {
    if (!detail?.id) return;
    setActing('retry');
    try {
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}/retry-cn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(60_000),
      });
      setDetail(data);
      if (str(data.cnSyncStatus) === 'DONE') toast.success('Credit note tersinkron');
      else toast.error(str(data.cnSyncError) || 'Retry CN masih gagal');
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal retry CN');
    } finally {
      setActing('');
    }
  };

  // ADR-006 — follow-up aktif utk RTV yang "menunggu vendor": tanya langsung ke Sales
  // (Category B pull), bukan cuma menampilkan label tanpa jalan keluar sampai webhook
  // keputusan vendor (yang bisa gagal terkirim) sampai duluan.
  const checkDecision = async () => {
    if (!detail?.id) return;
    setActing('check-decision');
    try {
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}/check-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(30_000),
      });
      const checkResult = asObject(data.checkResult);
      const action = str(checkResult.action);
      const hutangHeal = asObject(checkResult.hutangHeal);
      const hutangAction = str(hutangHeal.action);
      setDetail(data);
      if (str(checkResult.error) && !action) {
        toast.error(str(checkResult.error));
        if (hutangAction === 'credit_applied') {
          toast.success('Hutang berhasil dikoreksi dari credit note Sales');
        }
      } else if (action === 'applied') {
        toast.success(`Vendor sudah memutuskan — ${str(checkResult.vendorDecision)}`);
        if (hutangAction === 'credit_applied') {
          toast.success('Hutang dikoreksi sesuai credit note');
        }
      } else if (action === 'still_pending') {
        toast('Vendor belum memutuskan retur ini.');
      } else if (action === 'already_resolved' || action === 'already_applied') {
        if (hutangAction === 'credit_applied') {
          toast.success('Keputusan sudah ada — hutang baru dikoreksi dari Sales');
        } else {
          toast('Keputusan vendor sudah tersinkron sebelumnya.');
        }
      } else if (str(checkResult.error)) {
        toast.error(str(checkResult.error));
      } else {
        toast.error('Gagal cek status ke Sales');
      }
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal cek status ke Sales');
    } finally {
      setActing('');
    }
  };

  const deleteDraft = async () => {
    if (!detail?.id) return;
    setActing('delete');
    try {
      await fetchJson(`/api/vendor-returns/${str(detail.id)}`, { method: 'DELETE' });
      toast.success('Draft dihapus');
      setDetail(null);
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal hapus');
    } finally {
      setActing('');
    }
  };

  const patchItem = (idx: number, patch: Record<string, unknown>) => {
    if (!detail) return;
    const items = asArray(detail.items).map((raw, i) => {
      const it = asObject(raw);
      if (i !== idx) return it;
      const next = { ...it, ...patch };
      const qty = num(next.qty);
      const harga = num(next.harga);
      next.jumlah = Math.round(qty * harga);
      return next;
    });
    const subTotal = items.reduce((s, it) => s + num(it.jumlah), 0);
    setDetail({ ...detail, items, subTotal, total: subTotal });
  };

  const removeItem = (idx: number) => {
    if (!detail) return;
    const items = asArray(detail.items).filter((_, i) => i !== idx);
    if (!items.length) return;
    const subTotal = items.reduce((s: number, it) => s + num(asObject(it).jumlah), 0);
    setDetail({ ...detail, items, subTotal, total: subTotal });
  };

  const isDraft = str(detail?.status) === 'DRAFT';
  const isPendingApproval = str(detail?.status) === 'PENDING_APPROVAL';
  const isCreator = !!(user?.id && str(asObject(detail?.createdBy).userId) === user.id);
  const canSelfApprove = !!user && ['ADMIN', 'MASTER', 'OWNER'].includes(str(user.role));
  const canApproveThis = isPendingApproval && canApproveRole && (canSelfApprove || !isCreator);
  const canWithdraw = isPendingApproval && (isCreator || canApproveRole);
  const isGrnReject = str(detail?.source) === 'grn-reject';
  const cnSync = str(detail?.cnSyncStatus);
  const vendorDecision = str(detail?.vendorDecision);
  const hasCn = !!(str(detail?.creditNoteId) || str(detail?.noCN) || cnSync === 'DONE');
  // Retry hanya untuk FAILED — SKIPPED = tanpa Sales (bukan error); SYNCING = in-flight.
  const postedNeedsRetry = !isGrnReject && str(detail?.status) === 'POSTED'
    && cnSync === 'FAILED'
    && !['REJECTED', 'PARTIAL'].includes(vendorDecision);
  const postedFailed = postedNeedsRetry;
  const cnSyncing = !isGrnReject && str(detail?.status) === 'POSTED' && cnSync === 'SYNCING';
  // Banner vendor PENDING hanya jika CN sudah ada / DONE — hindari ganda dengan SYNCING/FAILED.
  const showVendorPendingBanner = vendorDecision === 'PENDING'
    && !cnSyncing
    && !postedNeedsRetry
    && hasCn;
  const rejectedItems = (asArray(detail?.items) as JsonObject[]).filter(
    (it) => str(it.vendorDecision) === 'REJECTED',
  );
  const acceptedItems = (asArray(detail?.items) as JsonObject[]).filter(
    (it) => str(it.vendorDecision) === 'ACCEPTED',
  );
  const acceptedTotal = acceptedItems.reduce((s, it) => s + num(it.jumlah), 0);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Undo2 className="w-6 h-6 text-orange-600" /> Retur Vendor
          </h1>
          <p className="text-sm text-slate-500">
            Ajukan → approval (SoD) → stok keluar + credit note. Hutang turun setelah vendor menerima baris dan CN terbit.
            Salah harga tanpa barang keluar? Gunakan Koreksi harga di Tagihan (CN overcharge / DN undercharge) — bukan RTV (ADR-008).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Muat ulang
          </Button>
          <Button size="sm" className="bg-orange-500 hover:bg-orange-600" onClick={() => void openEligible()}>
            <Plus className="w-4 h-4 mr-1" /> Buat Retur
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {['', 'DRAFT', 'PENDING_APPROVAL', 'POSTING', 'POSTED'].map((st) => (
          <Button
            key={st || 'all'}
            size="sm"
            variant={statusFilter === st ? 'default' : 'outline'}
            onClick={() => setStatusFilter(st)}
          >
            {st === 'PENDING_APPROVAL' ? 'Menunggu approval'
              : st === 'POSTING' ? 'Posting'
                : st || 'Semua'}
          </Button>
        ))}
        <span className="w-px h-5 bg-slate-300 mx-1" />
        {[
          { value: '', label: 'Semua keputusan' },
          { value: 'PENDING', label: 'Menunggu vendor' },
          { value: 'PARTIAL', label: 'Sebagian ditolak' },
          { value: 'REJECTED', label: 'Ditolak' },
        ].map((opt) => (
          <Button
            key={opt.value || 'all-decision'}
            size="sm"
            variant={decisionFilter === opt.value ? 'default' : 'outline'}
            onClick={() => setDecisionFilter(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
        <Input
          placeholder="Cari no RTV / invoice / GRN / vendor"
          className="h-8 w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">No RTV</th>
              <th className="px-3 py-2 text-left">Tanggal</th>
              <th className="px-3 py-2 text-left">Vendor</th>
              <th className="px-3 py-2 text-left">Invoice</th>
              <th className="px-3 py-2 text-left">GRN</th>
              <th className="px-3 py-2 text-center">Status</th>
              <th className="px-3 py-2 text-left">CN</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-center">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={8} cols={9} />}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="text-center py-10 text-slate-400">Belum ada retur vendor</td></tr>
            )}
            {rows.map((row) => (
              <tr
                key={str(row.id)}
                className={`border-t hover:bg-slate-50 ${isOverdue(row) ? 'bg-amber-50/60' : ''}`}
                title={isOverdue(row) ? 'Lewat tenggat keputusan vendor' : undefined}
              >
                <td className="px-3 py-2 font-mono text-xs text-orange-700">{str(row.noReturn)}</td>
                <td className="px-3 py-2 text-xs">{formatDateTime(str(row.createdAt) || str(row.postedAt) || undefined)}</td>
                <td className="px-3 py-2 text-xs truncate max-w-[10rem]">{str(row.supplierName) || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">{str(row.noInvoice)}</td>
                <td className="px-3 py-2 font-mono text-xs">{str(row.noGRN) || str(row.noDO) || '—'}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_STYLE[str(row.status)] || 'bg-slate-100'}`}>
                    {str(row.status) === 'PENDING_APPROVAL' ? 'Menunggu approval' : str(row.status)}
                  </span>
                </td>
                <td className={`px-3 py-2 ${CN_STYLE[str(row.cnSyncStatus)] || ''}`}>{cnLabel(row)}</td>
                <td className="px-3 py-2 text-right">{formatIDR(num(row.total))}</td>
                <td className="px-3 py-2 text-center">
                  <Button size="sm" variant="outline" onClick={() => void loadDetail(str(row.id))}>
                    <Eye className="w-3.5 h-3.5 mr-1" /> Detail
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {hasMore && (
          <div className="border-t px-4 py-2 text-center">
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Memuat…' : 'Muat lebih banyak'}
            </Button>
          </div>
        )}
      </div>

      <Dialog open={eligibleOpen} onOpenChange={setEligibleOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Pilih tagihan untuk diretur</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {eligibleLoading && <p className="text-sm text-slate-500 p-4">Memuat tagihan…</p>}
            {!eligibleLoading && eligible.length === 0 && (
              <p className="text-sm text-slate-500 p-4">Tidak ada tagihan dengan sisa qty retur.</p>
            )}
            <div className="space-y-2">
              {eligible.map((h) => (
                <div key={str(h.hutangId)} className="flex items-center justify-between gap-3 border rounded px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold">{str(h.noInvoice)}</p>
                    <p className="text-xs text-slate-500 truncate">
                      {str(h.supplierName)} · {num(h.returableLines)} baris · sisa qty {formatNumber(num(h.maxQty))}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={acting === 'create'}
                    onClick={() => void createFromHutang(str(h.hutangId))}
                  >
                    Pilih
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {str(detail?.noReturn)} · {str(detail?.noInvoice)}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="flex-1 overflow-auto space-y-3">
              {isGrnReject && (
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  Retur dari item ditolak saat Terima Barang (GRN) — qty ini tidak pernah masuk stok/tertagih, jadi tanpa credit note vendor.
                </div>
              )}
              {isPendingApproval && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Menunggu approval internal (SoD).{' '}
                  {str(detail.stockAppliedAt)
                    ? 'Stok sudah keluar (post sebelumnya sempat gagal) — lanjutkan approve/post; tidak akan OUT dua kali.'
                    : 'Stok belum keluar.'}
                  {str(asObject(detail.submittedBy).userName) && (
                    <> Diajukan oleh {str(asObject(detail.submittedBy).userName)}.</>
                  )}
                  {isCreator && !canSelfApprove && canApproveRole && (
                    <> Anda pembuat dokumen — minta SUPERVISOR/ADMIN lain untuk menyetujui.</>
                  )}
                </div>
              )}
              {str(detail.approvalRejectReason) && isDraft && (
                <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  Dikembalikan ke draft: {str(detail.approvalRejectReason)}
                </div>
              )}
              {postedNeedsRetry && (
                <div className={`rounded border px-3 py-2 text-sm ${postedFailed ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
                  Stok sudah keluar — faktur kredit belum terbentuk.
                  {str(detail.cnSyncError) ? ` ${str(detail.cnSyncError)}` : ''}
                </div>
              )}
              {cnSyncing && (
                <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                  Stok sudah keluar — credit note sedang disinkron ke Sales.
                </div>
              )}
              {showVendorPendingBanner && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 space-y-2">
                  <p>
                    Menunggu keputusan vendor (Terima/Tolak per baris). Stok sudah keluar gudang saat Post;
                    hutang belum berkurang sampai credit note terbit setelah vendor menerima.
                    {str(detail.vendorDecisionDueAt) && ` Tenggat: ${new Date(str(detail.vendorDecisionDueAt)).toLocaleDateString('id-ID')}.`}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-400 text-amber-800 hover:bg-amber-100"
                    disabled={acting === 'check-decision'}
                    onClick={() => void checkDecision()}
                  >
                    {acting === 'check-decision' ? 'Mengecek ke Sales…' : 'Cek Keputusan ke Sales'}
                  </Button>
                </div>
              )}
              {['REJECTED', 'PARTIAL'].includes(vendorDecision) && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 space-y-2">
                  <p className="font-semibold">
                    Perlu tindak lanjut — vendor menolak {rejectedItems.length} dari {asArray(detail.items).length} baris retur ini.
                    Stok baris yang ditolak sudah dikembalikan ke gudang otomatis; hutang untuk baris itu tidak berkurang.
                  </p>
                  {rejectedItems.length > 0 && (
                    <ul className="list-disc list-inside text-xs">
                      {rejectedItems.map((it, i) => (
                        <li key={`${str(it.lineId)}-${i}`}>
                          {str(it.localKode)} — {str(it.localNama)}: {str(it.vendorDecisionReason) || 'Tanpa alasan'}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-xs text-red-700">
                    Qty baris ditolak sudah bebas untuk diajukan lagi. Ajukan retur baru untuk baris tersebut
                    kalau masih perlu dikembalikan ke vendor.
                  </p>
                  {str(detail.hutangId) && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-400 text-red-700 hover:bg-red-100"
                      disabled={acting === 'create'}
                      onClick={() => void createFromHutang(str(detail.hutangId))}
                    >
                      {acting === 'create' ? 'Membuat draft…' : 'Ajukan Retur Baru untuk Baris yang Ditolak'}
                    </Button>
                  )}
                </div>
              )}
              {acceptedItems.length > 0 && (
                <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900 space-y-2">
                  <p>
                    Vendor menerima {acceptedItems.length} baris ({formatIDR(acceptedTotal)}).
                    Stok baris ini tetap keluar gudang (sudah keluar saat Post).
                    Hutang berkurang lewat credit note setelah CN diposting
                    {str(detail.noCN) ? ` (${str(detail.noCN)})` : cnSync ? ` — status CN: ${cnSync}` : ''}.
                    {' '}Kalau perlu barang pengganti, ajukan PO baru untuk baris ini.
                  </p>
                  {str(detail.replacementCpoId) && (
                    <Link
                      href={`/pembelian-po?highlight=${str(detail.replacementCpoId)}`}
                      className="block text-sm font-medium underline text-green-800 hover:text-green-900"
                    >
                      PO pengganti: {str(detail.replacementCpoNo) || str(detail.replacementCpoId)}
                    </Link>
                  )}
                  <Link href={`/pembelian-po?vendorReturnId=${str(detail.id)}`}>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-green-400 text-green-800 hover:bg-green-100"
                    >
                      {str(detail.replacementCpoId) ? 'Buat PO Pengganti Lagi' : 'Buat PO Pengganti'}
                    </Button>
                  </Link>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div><span className="text-slate-500">Vendor</span><p className="font-semibold">{str(detail.supplierName) || '—'}</p></div>
                <div><span className="text-slate-500">Status</span><p className="font-semibold">{str(detail.status) === 'PENDING_APPROVAL' ? 'Menunggu approval' : str(detail.status)}</p></div>
                <div><span className="text-slate-500">GRN / DO</span><p className="font-mono">{str(detail.noGRN) || str(detail.noDO) || '—'}</p></div>
                <div><span className="text-slate-500">PO / SO</span><p className="font-mono">{str(detail.noPO) || '—'} / {str(detail.noSO) || '—'}</p></div>
                <div><span className="text-slate-500">CN</span><p>{str(detail.noCN) || str(detail.cnSyncStatus)}</p></div>
                {str(detail.transitAppliedAt) && (
                  <div>
                    <span className="text-slate-500">Transit GL</span>
                    <p className="font-semibold" title={str(detail.transitJournalId) || undefined}>
                      {formatIDR(num(detail.transitAmount))}
                      <span className="ml-1 font-normal text-slate-500">
                        ({vendorDecision === 'PENDING' ? 'terbuka' : 'clear via CN/reject'})
                      </span>
                    </p>
                  </div>
                )}
                {!isGrnReject && str(detail.status) === 'POSTED' && (
                  <div>
                    <span className="text-slate-500">Keputusan Vendor</span>
                    <p className={
                      vendorDecision === 'REJECTED' ? 'font-semibold text-red-700'
                        : vendorDecision === 'PARTIAL' ? 'font-semibold text-amber-700'
                        : vendorDecision === 'PENDING' ? 'text-amber-700'
                        : vendorDecision === 'ACCEPTED' ? 'text-green-700'
                        : ''
                    }>
                      {vendorDecision === 'PENDING' ? 'Menunggu vendor'
                        : vendorDecision === 'PARTIAL' ? 'Sebagian ditolak'
                        : vendorDecision === 'REJECTED' ? 'Ditolak vendor'
                        : vendorDecision === 'ACCEPTED' ? 'Diterima vendor'
                        : '—'}
                    </p>
                  </div>
                )}
                {str(detail.status) !== 'DRAFT' && (
                  <div>
                    <span className="text-slate-500">Kartu stok</span>
                    <p className="font-mono">{str(detail.noReturn)}</p>
                  </div>
                )}
              </div>
              <div>
                <Label>Alasan retur</Label>
                <Input
                  disabled={!isDraft}
                  value={str(detail.reason)}
                  onChange={(e) => setDetail({ ...detail, reason: e.target.value })}
                  placeholder="Rusak / salah kirim / kelebihan"
                />
              </div>
              <div className="border rounded overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Kode</th>
                      <th className="px-2 py-1.5 text-left">Nama</th>
                      <th className="px-2 py-1.5 text-left">Alasan baris</th>
                      <th className="px-2 py-1.5 text-center">Sat</th>
                      <th className="px-2 py-1.5 text-right">Max</th>
                      <th className="px-2 py-1.5 text-right">Qty</th>
                      <th className="px-2 py-1.5 text-left">Gudang</th>
                      <th className="px-2 py-1.5 text-left">Lot</th>
                      <th className="px-2 py-1.5 text-right">Harga</th>
                      <th className="px-2 py-1.5 text-right">Jumlah</th>
                      {!isDraft && !isGrnReject && str(detail.status) === 'POSTED' && (
                        <th className="px-2 py-1.5 text-center">Keputusan Vendor</th>
                      )}
                      {isDraft && !isGrnReject && <th className="px-2 py-1.5 w-10" />}
                    </tr>
                  </thead>
                  <tbody>
                    {asArray(detail.items).map((raw, idx) => {
                      const it = raw as JsonObject;
                      const ret = (asArray(detail.returable) as JsonObject[]).find(
                        (r) => str(r.invoiceLineId) === str(it.invoiceLineId),
                      );
                      const maxQty = num(ret?.maxQty ?? it.maxQty ?? it.qty);
                      const onlyOneLeft = asArray(detail.items).length <= 1;
                      const lineDecision = str(it.vendorDecision);
                      return (
                      <tr key={`${str(it.lineId)}-${idx}`} className="border-t">
                        <td className="px-2 py-1.5 font-mono text-xs">{str(it.localKode)}</td>
                        <td className="px-2 py-1.5 text-xs">{str(it.localNama)}</td>
                        <td className="px-2 py-1.5 text-xs">
                          {isDraft && !isGrnReject ? (
                            <Input
                              className="h-8 w-40 text-xs"
                              value={str(it.reason)}
                              onChange={(e) => patchItem(idx, { reason: e.target.value })}
                              placeholder="Kosong = pakai alasan retur"
                            />
                          ) : (str(it.reason) || str(detail.reason) || '—')}
                        </td>
                        <td className="px-2 py-1.5 text-center text-xs">{str(it.satuan)}</td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatNumber(maxQty)}</td>
                        <td className="px-2 py-1.5 text-right">
                          {isDraft && !isGrnReject ? (
                            <Input
                              type="number"
                              min={0}
                              max={maxQty}
                              step="any"
                              className="h-8 w-24 ml-auto text-right"
                              value={num(it.qty)}
                              onChange={(e) => patchItem(idx, { qty: parseFloat(e.target.value) || 0 })}
                            />
                          ) : formatNumber(num(it.qty))}
                        </td>
                        <td className="px-2 py-1.5">
                          {isDraft && !isGrnReject ? (
                            <select
                              className="h-8 border rounded px-1 text-xs"
                              value={str(it.gudangKode) || 'GKERING'}
                              onChange={(e) => patchItem(idx, { gudangKode: e.target.value, lotNo: null })}
                            >
                              {WAREHOUSES.map((w) => (
                                <option key={w.kode} value={w.kode}>{w.short}</option>
                              ))}
                            </select>
                          ) : warehouseName(str(it.gudangKode))}
                        </td>
                        <td className="px-2 py-1.5">
                          {isDraft && !isGrnReject ? (
                            <Input
                              className="h-8 w-28 text-xs font-mono"
                              value={str(it.lotNo)}
                              onChange={(e) => patchItem(idx, { lotNo: e.target.value || null })}
                              placeholder="FEFO"
                              title="Lot preferensi (kosong = FEFO otomatis saat post)"
                            />
                          ) : (str(it.lotNo) || '—')}
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatIDR(num(it.harga))}</td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatIDR(num(it.jumlah))}</td>
                        {!isDraft && !isGrnReject && str(detail.status) === 'POSTED' && (
                          <td className="px-2 py-1.5 text-center">
                            <span
                              title={
                                lineDecision === 'ACCEPTED'
                                  ? 'Stok tetap keluar; hutang turun lewat credit note'
                                  : lineDecision === 'REJECTED'
                                    ? (str(it.vendorDecisionReason)
                                      ? `Stok dikembalikan ke gudang — ${str(it.vendorDecisionReason)}`
                                      : 'Stok dikembalikan ke gudang otomatis')
                                    : 'Stok sudah keluar; menunggu keputusan vendor'
                              }
                              className={`inline-flex text-[11px] px-2 py-0.5 rounded ${
                                lineDecision === 'ACCEPTED' ? 'bg-green-100 text-green-800'
                                  : lineDecision === 'REJECTED' ? 'bg-red-100 text-red-800'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {lineDecision === 'ACCEPTED' ? 'Diterima'
                                : lineDecision === 'REJECTED' ? 'Ditolak'
                                : 'Menunggu'}
                            </span>
                          </td>
                        )}
                        {isDraft && !isGrnReject && (
                          <td className="px-2 py-1.5 text-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-red-600 hover:bg-red-50"
                              disabled={onlyOneLeft}
                              title={onlyOneLeft ? 'Minimal 1 baris retur' : 'Hapus baris ini dari retur'}
                              onClick={() => removeItem(idx)}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </td>
                        )}
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-right font-semibold">Total {formatIDR(num(detail.total))}</p>
              <PhotoUploadField
                label="Foto (opsional)"
                photos={asArray(detail.photos).map((p) => String(p))}
                onChange={(photos) => setDetail({ ...detail, photos })}
                disabled={!isDraft}
              />
            </div>
          )}
          <DialogFooter className="gap-2">
            {isDraft && (
              <>
                <Button variant="outline" onClick={() => void deleteDraft()} disabled={!!acting}>
                  <Trash2 className="w-4 h-4 mr-1" /> Hapus
                </Button>
                <Button variant="outline" onClick={() => void saveDraft()} disabled={!!acting}>
                  {acting === 'save' ? 'Menyimpan…' : 'Simpan draft'}
                </Button>
                <Button className="bg-orange-500 hover:bg-orange-600" onClick={() => void submitReturn()} disabled={!!acting}>
                  {acting === 'submit' ? 'Mengajukan…' : 'Ajukan Approval'}
                </Button>
              </>
            )}
            {isPendingApproval && (
              <>
                {canWithdraw && (
                  <Button variant="outline" onClick={() => void returnToDraft()} disabled={!!acting}>
                    {acting === 'withdraw' ? 'Mengembalikan…' : 'Kembali ke Draft'}
                  </Button>
                )}
                {canApproveThis && (
                  <Button className="bg-orange-500 hover:bg-orange-600" onClick={() => void approveReturn()} disabled={!!acting}>
                    {acting === 'approve' ? 'Menyetujui…' : 'Setujui & Post'}
                  </Button>
                )}
              </>
            )}
            {postedNeedsRetry && (
              <Button onClick={() => void retryCn()} disabled={!!acting}>
                {acting === 'retry' ? 'Mencoba…' : 'Retry sync CN'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
