'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject } from '@/types/json';
import { useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import VendorInvoiceDetail from '@/components/VendorInvoiceDetail';
import VirtualTableBody from '@/components/VirtualTableBody';
import { TableSkeleton } from '@/components/TableSkeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Banknote, CircleCheck, Eye, RefreshCw } from 'lucide-react';
import { formatIDR, formatDate } from '@/lib/format';
import { useConfirm } from '@/components/ConfirmProvider';
import { debounce } from '@/lib/debounce';
import {
  useVendorHutangList,
  useHutangPendingCount,
  useInvalidateHutang,
} from '@/lib/hooks/use-vendor-hutang';

const TABS = [
  { key: '', label: 'Semua' },
  { key: 'PENDING_REVIEW', label: 'Menunggu review' },
  { key: 'APPROVED', label: 'Disetujui' },
  { key: 'PAID_EXTERNAL', label: 'Lunas (luar)' },
];

const APPROVAL_LABELS = {
  PENDING_REVIEW: 'Menunggu review',
  APPROVED: 'Disetujui',
  REJECTED: 'Ditolak',
  PAID_EXTERNAL: 'Lunas (luar sistem)',
  OUTSTANDING: 'Outstanding',
  LUNAS: 'Lunas',
  PARTIAL: 'Sebagian',
};

const APPROVAL_BADGE = {
  PENDING_REVIEW: 'bg-blue-100 text-blue-800',
  APPROVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  PAID_EXTERNAL: 'bg-slate-100 text-slate-700',
};

const CAN_MARK_PAID = new Set(['APPROVED', 'OUTSTANDING', 'PARTIAL']);

export default function HutangVendorPage() {
  const confirm = useConfirm();
  const invalidateHutang = useInvalidateHutang();
  const [tab, setTab] = useState('PENDING_REVIEW');
  const { data: list = [], isLoading, refetch } = useVendorHutangList(tab);
  const { data: pendingCount = 0 } = useHutangPendingCount();
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [loadingDetail, setLoadingDetail] = useState('');
  const [acting, setActing] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [overrideMatch, setOverrideMatch] = useState(false);

  const debouncedRefresh = useMemo(
    () => debounce(() => invalidateHutang(), 300),
    [invalidateHutang],
  );

  useEffect(() => {
    const onChange = () => debouncedRefresh();
    window.addEventListener('erp-hutang-change', onChange);
    return () => window.removeEventListener('erp-hutang-change', onChange);
  }, [debouncedRefresh]);

  const openDetail = async (id: string) => {
    setLoadingDetail(id);
    try {
      const res = await fetch(`/api/hutang/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat');
      setDetail(data);
      setOverrideMatch(false);
      setRejectReason('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setLoadingDetail('');
  };

  const doApprove = async () => {
    if (!detail) return;
    setActing('approve');
    try {
      const res = await fetch(`/api/hutang/${str(detail.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrideMatch, note: overrideMatch ? 'Disetujui dengan override match' : '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyetujui');
      toast.success('Tagihan disetujui');
      setDetail(null);
      invalidateHutang();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setActing('');
  };

  const doReject = async () => {
    if (!detail) return;
    setActing('reject');
    try {
      const res = await fetch(`/api/hutang/${str(detail.id)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason || 'Ditolak admin' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menolak');
      toast.success('Tagihan ditolak');
      setShowReject(false);
      setDetail(null);
      invalidateHutang();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setActing('');
  };

  const markPaidById = async (id: string, noInvoice?: unknown) => {
    const ok = await confirm({
      title: 'Tandai lunas?',
      description: `Invoice ${noInvoice || id} akan ditandai lunas (pembayaran di luar sistem).`,
      confirmText: 'Tandai lunas',
      variant: 'info',
    });
    if (!ok) return;

    setActing(`paid-${id}`);
    try {
      const res = await fetch(`/api/hutang/${id}/mark-paid-external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Pembayaran dilakukan di luar sistem' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');
      toast.success('Ditandai lunas (bayar luar sistem)');
      if (detail?.id === id) setDetail(null);
      invalidateHutang();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setActing('');
  };

  const doMarkPaid = async () => {
    if (!detail) return;
    await markPaidById(str(detail.id), detail.noInvoice);
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/hutang/sync-pending', { method: 'POST' });
      const data = await res.json();
      if (!res.ok && !data.skipped) throw new Error(data.error || 'Gagal sync');
      if (data.skipped) toast.info(data.error || 'Endpoint sync belum tersedia di sales.app');
      else if ((data.reconcile?.replayed || 0) > 0 && (data.reconcile?.created || 0) > 0) {
        toast.success(`${data.reconcile.created} faktur dibuat ulang di sales.app`);
      } else if ((data.refreshed || 0) > 0 || (data.reconcile?.fixed || 0) > 0) {
        const n = (data.refreshed || 0) + (data.reconcile?.fixed || 0);
        toast.success(`${n} tagihan dipulihkan — cek tab Menunggu review`);
      } else if ((data.pendingAfter || 0) > 0) {
        toast.success(`${data.pendingAfter} tagihan menunggu review admin`);
      } else if (data.reconcile?.salesErrors?.length) {
        toast.warning(`Gagal buat faktur di sales: ${data.reconcile.salesErrors[0]?.error || 'cek pelanggan B2B'}`);
      } else if ((data.created || 0) > 0) {
        toast.success(`Sync: ${data.created} tagihan baru, ${data.existing || 0} sudah ada`);
      } else if ((data.reconcile?.localCreated || 0) > 0 || (data.reconcile?.created || 0) > 0) {
        const n = (data.reconcile?.localCreated || 0) + (data.reconcile?.created || 0);
        toast.success(`${n} tagihan dibuat dari GRN yang sudah diposting`);
      } else if (data.errors?.length) {
        toast.warning(`Sync: ${data.errors.length} gagal — ${data.errors[0]?.error || 'cek GRN/invoice'}`);
      } else if (data.total === 0) {
        toast.info(data.hint || 'Tidak ada invoice POSTED di sales.app untuk tenant ini');
      } else {
        toast.success(`Sync: ${data.existing || 0} sudah ada, tidak ada yang baru`);
      }
      invalidateHutang();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setSyncing(false);
  };

  const allList = Array.isArray(list) ? list : [];

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Banknote className="w-6 h-6" /> Tagihan Vendor</h1>
            <p className="text-sm text-slate-500">
              Review invoice dari sales.app · Menunggu review: {pendingCount}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={syncNow} disabled={syncing}>
            <RefreshCw className={`w-4 h-4 mr-1 ${syncing ? 'animate-spin' : ''}`} />
            Sync invoice
          </Button>
        </div>
        <OperationalScopeBar />

        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-full text-sm border ${
                tab === t.key ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-slate-600 border-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Invoice</th>
                <th className="px-3 py-2 text-left">Vendor</th>
                <th className="px-3 py-2 text-left">No. PO</th>
                <th className="px-3 py-2 text-left">No. DO</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-center">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton rows={8} cols={8} />}
              {!isLoading && !allList.length && (
                <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada tagihan</td></tr>
              )}
              {!isLoading && allList.length > 0 && (
                <VirtualTableBody
                  rows={allList}
                  renderRow={(h: JsonObject) => {
                    const a = str(h.approvalStatus || h.status);
                    const snap = asObject(h.vendorBillingSnapshot);
                    return (
                      <tr key={str(h.id)} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => openDetail(str(h.id))}>
                        <td className="px-3 py-2 font-mono text-xs text-orange-700">{str(h.noInvoice)}</td>
                        <td className="px-3 py-2 text-xs max-w-[160px] truncate" title={str(h.supplierName)}>
                          {str(h.supplierName) || str(snap.companyName) || '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{str(h.noPO) || '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{str(h.noDO) || '—'}</td>
                        <td className="px-3 py-2 text-xs">{formatDate(str(h.tanggal))}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{formatIDR(num(h.total))}</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs ${APPROVAL_BADGE[a as keyof typeof APPROVAL_BADGE] || 'bg-slate-100'}`}>
                            {APPROVAL_LABELS[a as keyof typeof APPROVAL_LABELS] || a}
                          </span>
                          {h.matchStatus === 'EXCEPTION' && (
                            <span
                              className="ml-1 px-1.5 py-0.5 rounded text-xs bg-amber-100 text-amber-800 cursor-help"
                              title={str(h.matchError, '3-way match exception — buka detail untuk override')}
                            >
                              !
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex items-center justify-center gap-0.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={loadingDetail === str(h.id)}
                              title="Lihat faktur"
                              onClick={() => openDetail(str(h.id))}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                            {CAN_MARK_PAID.has(a) && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-green-700 hover:text-green-800 hover:bg-green-50"
                                disabled={acting === `paid-${str(h.id)}`}
                                title="Tandai lunas (bayar luar sistem)"
                                onClick={() => markPaidById(str(h.id), h.noInvoice)}
                              >
                                <CircleCheck className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  }}
                />
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-4xl max-h-[94vh] overflow-y-auto p-0 gap-0">
          <DialogHeader className="sr-only">
            <DialogTitle>
              {detail ? `Faktur tagihan ${str(detail.noInvoice)}` : 'Detail tagihan vendor'}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <VendorInvoiceDetail
              detail={detail}
              acting={acting}
              overrideMatch={overrideMatch}
              onOverrideMatchChange={setOverrideMatch}
              onApprove={doApprove}
              onReject={() => setShowReject(true)}
              onMarkPaid={doMarkPaid}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showReject} onOpenChange={setShowReject}>
        <DialogContent>
          <DialogHeader><DialogTitle>Tolak tagihan</DialogTitle></DialogHeader>
          <Input placeholder="Alasan penolakan" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <Button variant="destructive" onClick={doReject} disabled={acting === 'reject'} className="w-full">
            {acting === 'reject' ? '...' : 'Tolak tagihan'}
          </Button>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
