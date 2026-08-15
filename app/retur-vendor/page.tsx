'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asArray, asObject } from '@/types/json';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-blue-100 text-blue-800',
  POSTING: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
};

const CN_STYLE: Record<string, string> = {
  NONE: 'text-slate-500',
  SYNCING: 'text-blue-600',
  DONE: 'text-green-700',
  FAILED: 'text-red-700',
  SKIPPED: 'text-slate-500',
};

function cnLabel(row: JsonObject) {
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
  const qc = useQueryClient();
  const hutangIdParam = searchParams.get('hutangId') || '';
  const [statusFilter, setStatusFilter] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [eligibleOpen, setEligibleOpen] = useState(false);
  const [eligible, setEligible] = useState<JsonObject[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [acting, setActing] = useState('');
  const [creatingFromHutang, setCreatingFromHutang] = useState(false);
  const hutangCreateRef = useRef('');

  const listUrl = useMemo(() => {
    const p = new URLSearchParams();
    if (statusFilter) p.set('status', statusFilter);
    if (q) p.set('q', q);
    const qs = p.toString();
    return `/api/vendor-returns${qs ? `?${qs}` : ''}`;
  }, [statusFilter, q]);

  const {
    items: rows,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    refetch,
  } = useCursorQuery<JsonObject>(
    queryKeys.vendorReturns.list({ status: statusFilter, q }),
    listUrl,
    { limit: 80 },
  );

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.vendorReturns.all });
    invalidateHutangCaches(qc);
    void refetch();
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
      setEligible(Array.isArray(data) ? data : asArray(data.items));
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

  const postReturn = async () => {
    if (!detail?.id) return;
    if (!str(detail.reason).trim()) {
      toast.error('Alasan retur wajib sebelum post');
      return;
    }
    setActing('post');
    try {
      const data = await fetchJson<JsonObject>(`/api/vendor-returns/${str(detail.id)}/post`, {
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
      } else {
        toast.success(`RTV ${str(data.noReturn)} diposting`);
      }
      invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal post');
      if (detail.id) await loadDetail(str(detail.id)).catch(() => {});
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

  const isDraft = str(detail?.status) === 'DRAFT';
  const postedFailed = str(detail?.status) === 'POSTED' && str(detail?.cnSyncStatus) === 'FAILED';

  return (
    <div className="p-4 md:p-6 space-y-4">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Undo2 className="w-6 h-6 text-orange-600" /> Retur Vendor
          </h1>
          <p className="text-sm text-slate-500">
            Barang keluar gudang → credit note vendor → hutang turun. Satu aksi Post menyelesaikan stok dan CN.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Muat ulang
          </Button>
          <Button size="sm" className="bg-orange-500 hover:bg-orange-600" onClick={() => void openEligible()}>
            <Plus className="w-4 h-4 mr-1" /> Buat Retur
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {['', 'DRAFT', 'POSTED'].map((st) => (
          <Button
            key={st || 'all'}
            size="sm"
            variant={statusFilter === st ? 'default' : 'outline'}
            onClick={() => setStatusFilter(st)}
          >
            {st || 'Semua'}
          </Button>
        ))}
        <Input
          placeholder="Cari no RTV / invoice / GRN"
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
              <th className="px-3 py-2 text-left">Invoice</th>
              <th className="px-3 py-2 text-left">GRN</th>
              <th className="px-3 py-2 text-center">Status</th>
              <th className="px-3 py-2 text-left">CN</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-center">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {loading && <TableSkeleton rows={8} cols={8} />}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada retur vendor</td></tr>
            )}
            {rows.map((row) => (
              <tr key={str(row.id)} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs text-orange-700">{str(row.noReturn)}</td>
                <td className="px-3 py-2 text-xs">{formatDateTime(row.createdAt || row.postedAt)}</td>
                <td className="px-3 py-2 font-mono text-xs">{str(row.noInvoice)}</td>
                <td className="px-3 py-2 font-mono text-xs">{str(row.noGRN) || str(row.noDO) || '—'}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_STYLE[str(row.status)] || 'bg-slate-100'}`}>
                    {str(row.status)}
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
              {postedFailed && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  Stok sudah keluar — faktur kredit belum terbentuk.
                  {str(detail.cnSyncError) ? ` ${str(detail.cnSyncError)}` : ''}
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                <div><span className="text-slate-500">Status</span><p className="font-semibold">{str(detail.status)}</p></div>
                <div><span className="text-slate-500">GRN / DO</span><p className="font-mono">{str(detail.noGRN) || str(detail.noDO) || '—'}</p></div>
                <div><span className="text-slate-500">PO / SO</span><p className="font-mono">{str(detail.noPO) || '—'} / {str(detail.noSO) || '—'}</p></div>
                <div><span className="text-slate-500">CN</span><p>{str(detail.noCN) || str(detail.cnSyncStatus)}</p></div>
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
                      <th className="px-2 py-1.5 text-center">Sat</th>
                      <th className="px-2 py-1.5 text-right">Max</th>
                      <th className="px-2 py-1.5 text-right">Qty</th>
                      <th className="px-2 py-1.5 text-left">Gudang</th>
                      <th className="px-2 py-1.5 text-right">Harga</th>
                      <th className="px-2 py-1.5 text-right">Jumlah</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asArray(detail.items).map((raw, idx) => {
                      const it = raw as JsonObject;
                      return (
                      <tr key={`${str(it.lineId)}-${idx}`} className="border-t">
                        <td className="px-2 py-1.5 font-mono text-xs">{str(it.localKode)}</td>
                        <td className="px-2 py-1.5 text-xs">{str(it.localNama)}</td>
                        <td className="px-2 py-1.5 text-center text-xs">{str(it.satuan)}</td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatNumber(num(it.maxQty || it.qty))}</td>
                        <td className="px-2 py-1.5 text-right">
                          {isDraft ? (
                            <Input
                              type="number"
                              min={0}
                              max={num(it.maxQty || it.qty)}
                              step="any"
                              className="h-8 w-24 ml-auto text-right"
                              value={num(it.qty)}
                              onChange={(e) => patchItem(idx, { qty: parseFloat(e.target.value) || 0 })}
                            />
                          ) : formatNumber(num(it.qty))}
                        </td>
                        <td className="px-2 py-1.5">
                          {isDraft ? (
                            <select
                              className="h-8 border rounded px-1 text-xs"
                              value={str(it.gudangKode) || 'GKERING'}
                              onChange={(e) => patchItem(idx, { gudangKode: e.target.value })}
                            >
                              {WAREHOUSES.map((w) => (
                                <option key={w.kode} value={w.kode}>{w.short}</option>
                              ))}
                            </select>
                          ) : warehouseName(str(it.gudangKode))}
                        </td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatIDR(num(it.harga))}</td>
                        <td className="px-2 py-1.5 text-right text-xs">{formatIDR(num(it.jumlah))}</td>
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
                <Button className="bg-orange-500 hover:bg-orange-600" onClick={() => void postReturn()} disabled={!!acting}>
                  {acting === 'post' ? 'Memposting…' : 'Post Retur'}
                </Button>
              </>
            )}
            {postedFailed && (
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
