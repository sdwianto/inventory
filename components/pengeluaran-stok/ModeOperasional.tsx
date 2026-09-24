'use client';

import { str, num, asArray, asObject, type JsonObject } from '@/types/json';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';

import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { useSessionUser } from '@/lib/hooks/use-session-user';
import { fetchJson } from '@/lib/fetch-json';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { WAREHOUSES, warehouseName } from '@/lib/warehouses-client';
import { runListExport, type ListExportFormat } from '@/lib/run-list-export';
import { ArrowUpFromLine, BookOpen, Plus, CheckCircle2, XCircle, Send, Pencil, Trash2, Link2 } from 'lucide-react';
import { UnlinkedReleasesDialog } from '@/components/pengeluaran-stok/UnlinkedReleasesDialog';
import { useConfirm } from '@/components/ConfirmProvider';
import LineUomSelect from '@/components/uom/LineUomSelect';
import { fetchDefaultProductUom } from '@/lib/hooks/use-product-uoms';
import { usePrimeLineItemUoms } from '@/lib/hooks/use-prime-line-uoms';
import type { ProductUom } from '@/lib/uom/types';
import {
  appendReleaseFormItem,
  backfillReleaseItemLabels,
  buildReleaseFormItem,
  canUserEditRelease,
  catalogFromSaldoRows,
  EMPTY_RELEASE_FORM,
  mergePrefillIntoReleaseItems,
  patchReleaseFormItemUom,
  qtyAtLokasi,
  releaseDocToFormState,
  resolveReleaseItemDisplay,
  type ReleaseFormItem,
  type ReleaseFormState,
} from '@/lib/pengeluaran-stok/release-form-items';
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import { looksLikeProductionKeperluan } from '@/lib/food-production/production-keperluan';
import type { ReleasePrefill, ReleasePrefillSkipReason } from '@/lib/food-production/release-prefill';
import { getClientFeatureFlags } from '@/lib/feature-flags-client';

type OverIssuePreviewLine = {
  productNama?: string;
  productKode?: string;
  satuan?: string;
  sumber: string;
  lineIndexes: number[];
  acuanQty: number;
  consumedBefore: number;
  qtyAfter: number;
  limitQty: number;
  missingReason: boolean;
};
type OverIssuePreview = {
  enabled: boolean;
  tolerancePct?: number;
  overCount: number;
  missingReasonCount: number;
  lines: OverIssuePreviewLine[];
};

function describeOverLine(l: OverIssuePreviewLine): string {
  const sat = l.satuan ? ` ${l.satuan}` : '';
  if (l.sumber === 'DI_LUAR_ACUAN') return 'Di luar acuan rencana — wajib alasan';
  return `Total ${formatNumber(l.qtyAfter)}${sat} melebihi batas ${formatNumber(l.limitQty)}${sat}`
    + ` (acuan ${l.sumber} ${formatNumber(l.acuanQty)}, sudah keluar ${formatNumber(l.consumedBefore)})`;
}

const PREFILL_SKIP_LABEL: Record<ReleasePrefillSkipReason, string> = {
  BELUM_DITERIMA: 'PO belum diterima',
  SELESAI: 'sudah keluar semua',
  MENUNGGU_RL: 'menunggu RL lain disetujui',
  GUDANG_LAIN: 'gudang lain',
  STOK_KOSONG: 'stok kosong',
};

const ListExportMenu = dynamic(() => import('@/components/ListExportMenu'), { ssr: false });

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  PENDING_APPROVAL: 'bg-amber-100 text-amber-800',
  POSTED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  CANCELLED: 'bg-slate-100 text-slate-500',
};

const CAN_CREATE = ['GUDANG', 'ADMIN', 'MASTER'];
const CAN_APPROVE = ['SUPERVISOR', 'ADMIN', 'MASTER'];

const INVOICE_STATUS_STYLE: Record<string, string> = {
  SUDAH: 'bg-green-100 text-green-800',
  BELUM: 'bg-amber-100 text-amber-800',
  'N/A': 'bg-slate-100 text-slate-600',
};

const PANDUAN_WH_ALL = 'ALL';

export function ModeOperasional() {
  const user = useSessionUser();
  const confirm = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingReleaseId, setEditingReleaseId] = useState<string | null>(null);
  const [editingNoRelease, setEditingNoRelease] = useState('');
  const [editingRejectReason, setEditingRejectReason] = useState('');
  const [form, setForm] = useState<ReleaseFormState>(EMPTY_RELEASE_FORM);
  const searchParams = useSearchParams();
  const wrPrefillDone = useRef(false);
  const clientKeySeq = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [detail, setDetail] = useState<JsonObject | null>(null);
  const [showPanduan, setShowPanduan] = useState(false);
  /** Default: semua gudang — tidak mengikuti lokasi aktif header. */
  const [panduanWarehouseKode, setPanduanWarehouseKode] = useState(PANDUAN_WH_ALL);
  const [prefill, setPrefill] = useState<ReleasePrefill | null>(null);
  const [prefillLoading, setPrefillLoading] = useState(false);
  /** stokId → keterangan melebihi acuan dari preview server terakhir. */
  const [overFlags, setOverFlags] = useState<Record<string, string>>({});
  const [showUnlinked, setShowUnlinked] = useState(false);
  const rlFromPoReference = getClientFeatureFlags().rlFromPoReference;

  usePrimeLineItemUoms(showForm, form.items.map((it) => it.stokId));

  useEffect(() => {
    if (!form.lokasiKode || form.items.length === 0) return;
    queueMicrotask(() => {
      setForm((prev) => ({
        ...prev,
        items: prev.items.map((it) => ({
          ...it,
          stokAvail: qtyAtLokasi(it, prev.lokasiKode),
        })),
      }));
    });
  }, [form.lokasiKode, form.items.length]);

  const { data: listData = [] } = useApiQuery<JsonObject[]>(
    queryKeys.inventoryReleases.list,
    '/api/inventory-releases',
  );

  const { data: productionPlansData = [] } = useApiQuery<JsonObject[]>(
    ['food-production', 'production-plans', 'release-link'],
    '/api/production-plans',
    { enabled: showForm },
  );

  const productionPlans = useMemo(
    () => (Array.isArray(productionPlansData) ? productionPlansData : [])
      .filter((p) => ISSUE_ELIGIBLE_PLAN_STATUSES.has(str(p.status))),
    [productionPlansData],
  );

  const looksLikeProductionKeperluanForm = useMemo(
    () => looksLikeProductionKeperluan(form.keperluan),
    [form.keperluan],
  );

  const { data: saldoData } = useApiQuery<JsonObject>(
    queryKeys.stokSaldo.list,
    '/api/stok/saldo',
    { enabled: showForm || pickerOpen },
  );

  const panduanWhParam = panduanWarehouseKode === PANDUAN_WH_ALL ? '' : panduanWarehouseKode;
  const panduanUrl = panduanWhParam
    ? `/api/stok/panduan-release?warehouseKode=${encodeURIComponent(panduanWhParam)}`
    : '/api/stok/panduan-release';

  const {
    data: panduanData,
    isFetching: panduanLoading,
    refetch: refetchPanduan,
  } = useApiQuery<JsonObject>(
    queryKeys.panduanRelease.list({ warehouseKode: panduanWhParam || undefined }),
    panduanUrl,
    {
      enabled: showPanduan,
      staleTime: 0,
      refetchOnMount: 'always',
    },
  );

  const panduanRows = useMemo(
    () => asArray(asObject(panduanData).rows) as JsonObject[],
    [panduanData],
  );

  const list = useMemo(
    () => (Array.isArray(listData) ? listData : []).filter((r) => str(r.status) !== 'CANCELLED'),
    [listData],
  );
  const products = useMemo(
    () => asArray(asObject(saldoData).rows) as JsonObject[],
    [saldoData],
  );
  const productById = useMemo(() => catalogFromSaldoRows(products), [products]);

  /** Backfill nama/kode kosong dari katalog saldo — jaring pengaman terakhir. */
  const itemsNeedingLabel = form.items
    .filter((it) => !it.nama.trim() && productById.has(it.stokId))
    .map((it) => it.stokId)
    .join('|');

  useEffect(() => {
    if (!itemsNeedingLabel) return;
    queueMicrotask(() => {
      setForm((prev) => {
        const result = backfillReleaseItemLabels(prev.items, productById);
        return result.changed ? { ...prev, items: result.items } : prev;
      });
    });
  }, [itemsNeedingLabel, productById]);

  const saveMutation = useApiMutation<
    typeof form & { submit?: boolean },
    JsonObject
  >([queryKeys.inventoryReleases.all, queryKeys.stokSaldo.all, queryKeys.panduanRelease.all]);

  const actionMutation = useApiMutation<JsonObject, JsonObject>(
    [queryKeys.inventoryReleases.all, queryKeys.stokSaldo.all, queryKeys.panduanRelease.all],
  );

  useEffect(() => {
    const wrId = searchParams.get('wrId');
    if (!wrId || wrPrefillDone.current) return;
    wrPrefillDone.current = true;
    fetchJson<JsonObject>(`/api/maintenance-requests/${wrId}/resolve-prefill`)
      .then((data) => {
        if (!data.canResolveInternal) {
          toast.error('Permintaan tidak bisa release stok');
          return;
        }
        setForm((f) => ({
          ...f,
          keperluan: str(data.releaseKeperluan),
          keterangan: `[${str(data.noWR)}] ${str(data.judul)}`.trim(),
          maintenanceRequestId: str(data.id),
          assetId: str(data.assetId),
        }));
        setShowForm(true);
        toast.info(`Release stok untuk ${str(data.noWR)}`);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Gagal memuat WR'));
  }, [searchParams]);

  const canCreate = CAN_CREATE.includes(str(user?.role));
  const canApprove = CAN_APPROVE.includes(str(user?.role));
  const isAdminApprover = ['ADMIN', 'MASTER'].includes(str(user?.role));

  const closeReleaseForm = () => {
    setShowForm(false);
    setEditingReleaseId(null);
    setEditingNoRelease('');
    setEditingRejectReason('');
    setForm(EMPTY_RELEASE_FORM);
    setPrefill(null);
    setOverFlags({});
  };

  const fillFromPlan = async () => {
    if (!form.productionPlanId) return;
    setPrefillLoading(true);
    try {
      const qs = new URLSearchParams({ lokasiKode: form.lokasiKode });
      if (editingReleaseId) qs.set('excludeReleaseId', editingReleaseId);
      const data = await fetchJson<ReleasePrefill>(
        `/api/production-plans/${form.productionPlanId}/release-prefill?${qs.toString()}`,
      );
      setPrefill(data);
      setForm((prev) => ({
        ...prev,
        items: mergePrefillIntoReleaseItems(prev.items, data.lines, prev.lokasiKode),
      }));
      if (!data.lines.length) toast.message('Tidak ada bahan yang bisa diisi dari acuan rencana di gudang ini');
      else toast.success(`${data.lines.length} bahan diisi dari acuan rencana`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setPrefillLoading(false);
    }
  };

  const openCreateForm = () => {
    setPrefill(null);
    setOverFlags({});
    setEditingReleaseId(null);
    setEditingNoRelease('');
    setEditingRejectReason('');
    setForm(EMPTY_RELEASE_FORM);
    setShowForm(true);
  };

  const openEditForm = async (release: JsonObject) => {
    const id = str(release.id);
    if (!id) {
      toast.error('Release tidak valid');
      return;
    }
    try {
      const full = await fetchJson<JsonObject>(`/api/inventory-releases/${id}`);
      if (!canUserEditRelease(full, user)) {
        toast.error(
          str(full.status) === 'DRAFT' || str(full.status) === 'REJECTED'
            ? 'Anda tidak punya akses edit release ini'
            : 'Hanya draft atau release ditolak yang bisa diedit',
        );
        return;
      }
      setEditingReleaseId(id);
      setEditingNoRelease(str(full.noRelease));
      setEditingRejectReason(str(full.status) === 'REJECTED' ? str(full.rejectReason) : '');
      setForm(releaseDocToFormState(full));
      setPrefill(null);
      setOverFlags({});
      setShowForm(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat release');
    }
  };

  const panduanWarehouseLabel = panduanWhParam
    ? `${warehouseName(panduanWhParam)} (${panduanWhParam})`
    : 'Semua gudang';

  const exportPanduan = async (format: ListExportFormat) => {
    try {
      if (!panduanRows.length) throw new Error('Tidak ada data untuk diekspor');
      const stamp = new Date().toISOString().slice(0, 10);
      const whPart = panduanWhParam ? `-${panduanWhParam}` : '-semua';
      await runListExport(format, {
        baseName: `panduan-release${whPart}-${stamp}`,
        title: `Panduan Release — ${panduanWarehouseLabel}`,
        columns: [
          { key: 'productKode', label: 'Kode' },
          { key: 'productNama', label: 'Item' },
          {
            key: 'soh',
            label: 'SOH',
            value: (r: JsonObject) => `${formatNumber(num(r.soh))} ${str(r.satuan)}`.trim(),
          },
          { key: 'asal', label: 'Asal' },
          {
            key: 'tanggalTerima',
            label: 'Tgl Terima',
            value: (r: JsonObject) => formatDate(str(r.tanggalTerima)) || '—',
          },
          {
            key: 'invoiceStatus',
            label: 'Status Invoice',
            value: (r: JsonObject) => {
              const status = str(r.invoiceStatus) || 'BELUM';
              const inv = str(r.noInvoice);
              return inv ? `${status} (${inv})` : status;
            },
          },
          {
            key: 'warehouseNama',
            label: 'Gudang',
            value: (r: JsonObject) => str(r.warehouseNama) || str(r.warehouseKode) || '—',
          },
          { key: 'noGRN', label: 'No. GRN' },
          { key: 'noPenyesuaian', label: 'No. Penyesuaian' },
          { key: 'lotNo', label: 'Lot' },
        ],
        rows: panduanRows,
      });
      toast.success(`${panduanRows.length} baris diekspor`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const renderPendingActions = (r: JsonObject) => {
    if (str(r.status) !== 'PENDING_APPROVAL' || !canApprove) return null;

    const createdBy = asObject(r.createdBy);
    const isOwn = str(createdBy.userId) === str(user?.id);
    const userId = str(user?.id);
    const isMaker = !!userId && [r.createdBy, r.lastEditedBy, r.submittedBy]
      .some((u) => str(asObject(u).userId) === userId);
    const overCount = asArray(asObject(r.overIssue).lines).length;

    if (isMaker && overCount > 0) {
      return (
        <span className="text-xs text-red-700" title="Release melebihi acuan rencana wajib disetujui pengguna lain">
          Melebihi acuan — perlu penyetuju lain
        </span>
      );
    }

    if (isAdminApprover) {
      return (
        <>
          <Button
            size="sm"
            className="h-8 bg-green-600 hover:bg-green-700 whitespace-nowrap"
            onClick={() => action(str(r.id), 'approve')}
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
            {isOwn ? 'Admin Approve' : 'Approve'}
          </Button>
          {!isOwn && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 whitespace-nowrap text-red-700 border-red-200 hover:bg-red-50"
              onClick={() => action(str(r.id), 'reject', { reason: 'Dibatalkan admin' })}
            >
              <XCircle className="w-3.5 h-3.5 mr-1" />
              Batal
            </Button>
          )}
        </>
      );
    }

    if (isOwn) return null;

    return (
      <>
        <Button
          size="sm"
          className="h-8 bg-green-600 hover:bg-green-700 whitespace-nowrap"
          onClick={() => action(str(r.id), 'approve')}
        >
          <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
          Setujui
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-8 whitespace-nowrap text-red-700 border-red-200 hover:bg-red-50"
          onClick={() => action(str(r.id), 'reject', { reason: 'Ditolak supervisor' })}
        >
          <XCircle className="w-3.5 h-3.5 mr-1" />
          Tolak
        </Button>
      </>
    );
  };

  const addItem = async (p: JsonObject) => {
    // Optimistic: tulis nama/kode SEBELUM await UOM — detail langsung tampil,
    // tidak tergantung network / referensi row React Query setelah await.
    clientKeySeq.current += 1;
    const clientKey = `ck-${str(p.id)}-${clientKeySeq.current}`;
    const pending = buildReleaseFormItem({
      product: p,
      lokasiKode: form.lokasiKode,
      uomId: '',
      clientKey,
    });
    if (!pending) {
      toast.error('Produk tidak valid');
      return;
    }

    let duplicate = false;
    setForm((prev) => {
      const result = appendReleaseFormItem(prev.items, {
        ...pending,
        stokAvail: qtyAtLokasi(pending, prev.lokasiKode),
      });
      duplicate = result.duplicate;
      return result.duplicate ? prev : { ...prev, items: result.items };
    });
    if (duplicate) {
      toast.error('Produk sudah ada');
      return;
    }
    setPickerOpen(false);

    const defaultUom = await fetchDefaultProductUom(pending.stokId);
    let uomDuplicate = false;
    setForm((prev) => {
      const result = patchReleaseFormItemUom(prev.items, clientKey, {
        id: str(defaultUom?.id),
        satuan: str(defaultUom?.satuan) || pending.satuan,
      });
      uomDuplicate = result.duplicate;
      return { ...prev, items: result.items };
    });
    if (uomDuplicate) toast.error('Produk sudah ada');
  };

  const updateItemUom = (i: number, uom: ProductUom) => {
    setForm((prev) => ({
      ...prev,
      items: prev.items.map((it, idx) => (
        idx === i ? { ...it, uomId: uom.id, satuan: uom.satuan } : it
      )),
    }));
  };

  const save = async (submit = false) => {
    if (!form.keperluan.trim()) { toast.error('Keperluan wajib diisi'); return; }
    if (!form.items.length) { toast.error('Tambah minimal 1 item'); return; }
    if (looksLikeProductionKeperluanForm && !form.productionPlanId) {
      toast.error('Pilih Rencana Produksi — bahan menu/produksi wajib ditautkan ke RPN');
      return;
    }
    setSaving(true);
    try {
      const items = form.items.map(({ clientKey: _ck, ...rest }) => rest);
      const body = { ...form, items, submit };
      if (submit && rlFromPoReference && form.productionPlanId) {
        const preview = await fetchJson<OverIssuePreview>('/api/inventory-releases/over-issue-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const flags: Record<string, string> = {};
        for (const l of preview.lines || []) {
          for (const idx of l.lineIndexes) {
            const stokId = items[idx]?.stokId;
            if (stokId) flags[stokId] = describeOverLine(l);
          }
        }
        setOverFlags(flags);
        if (preview.missingReasonCount > 0) {
          toast.error(
            `${preview.missingReasonCount} produk melebihi acuan rencana`
            + ` (toleransi ${formatNumber(preview.tolerancePct ?? 0)}%) — isi alasan di baris bertanda merah`,
          );
          setSaving(false);
          return;
        }
      }
      if (editingReleaseId) {
        await saveMutation.mutateAsync({
          url: `/api/inventory-releases/${editingReleaseId}`,
          method: 'PATCH',
          body,
        });
        toast.success(
          submit
            ? (editingRejectReason
              ? `Release ${editingNoRelease || ''} diperbaiki dan diajukan ulang`.trim()
              : `Release ${editingNoRelease || ''} diajukan ke supervisor`.trim())
            : `Perubahan release ${editingNoRelease || ''} disimpan sebagai draft`.trim(),
        );
      } else {
        await saveMutation.mutateAsync({
          url: '/api/inventory-releases',
          body,
        });
        toast.success(submit ? 'Pengajuan release dikirim ke supervisor' : 'Draft release disimpan');
      }
      closeReleaseForm();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
    setSaving(false);
  };

  const action = async (id: string, type: 'submit' | 'approve' | 'reject', extra: JsonObject = {}) => {
    const paths = { submit: 'submit', approve: 'approve', reject: 'reject' } as const;
    const labels = { submit: 'Ajukan release', approve: 'Setujui release', reject: 'Tolak release' };
    try {
      await actionMutation.mutateAsync({
        url: `/api/inventory-releases/${id}/${paths[type]}`,
        body: extra,
        offlineLabel: `${labels[type]} ${id}`,
      });
      toast.success(type === 'approve' ? 'Release disetujui — stok dikurangi' : type === 'reject' ? 'Ditolak' : 'Diajukan');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteDraft = async (r: JsonObject) => {
    const id = str(r.id);
    const noRelease = str(r.noRelease);
    const okConfirm = await confirm({
      title: 'Hapus draft release?',
      description: noRelease
        ? `${noRelease} akan dihapus permanen. Aksi ini tidak bisa dibatalkan.`
        : 'Draft release akan dihapus permanen. Aksi ini tidak bisa dibatalkan.',
      confirmText: 'Hapus',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    try {
      await actionMutation.mutateAsync({
        url: `/api/inventory-releases/${id}`,
        method: 'DELETE',
        offlineLabel: `Hapus draft release ${noRelease || id}`,
      });
      if (str(detail?.id) === id) setDetail(null);
      toast.success(noRelease ? `Draft ${noRelease} dihapus` : 'Draft release dihapus');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const filteredProducts = products.filter((p) => {
    if (str(p.gudangKode, 'GKERING') !== form.lokasiKode) return false;
    if (qtyAtLokasi(p, form.lokasiKode) <= 0) return false;
    if (!pickerQ) return true;
    const q = pickerQ.toLowerCase();
    return str(p.nama).toLowerCase().includes(q) || str(p.kode).toLowerCase().includes(q);
  });

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ArrowUpFromLine className="w-5 h-5" /> Mode Operasional — Release Inventory
            </h2>
            <p className="text-sm text-slate-500">
              Staff gudang mengajukan pengeluaran barang operasional → Supervisor menyetujui & release stok.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowPanduan(true);
                void refetchPanduan();
              }}
            >
              <BookOpen className="w-4 h-4 mr-1" /> Panduan Release
            </Button>
            {rlFromPoReference && canApprove && (
              <Button variant="outline" onClick={() => setShowUnlinked(true)}>
                <Link2 className="w-4 h-4 mr-1" /> RL belum tertaut
              </Button>
            )}
            {canCreate && (
              <Button onClick={openCreateForm} className="bg-orange-500 hover:bg-orange-600">
                <Plus className="w-4 h-4 mr-1" /> Buat Release
              </Button>
            )}
          </div>
        </div>
        <OperationalScopeBar />

        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">No. Release</th>
                <th className="px-3 py-2 text-left">Tanggal</th>
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-left">Keperluan</th>
                <th className="px-3 py-2 text-center">Item</th>
                <th className="px-3 py-2 text-center">Status</th>
                <th className="px-3 py-2 text-left">Dibuat oleh</th>
                <th className="px-3 py-2 text-center min-w-[180px]">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {!list.length && (
                <tr><td colSpan={8} className="text-center py-10 text-slate-400">Belum ada release</td></tr>
              )}
              {list.map((r) => {
                const createdBy = asObject(r.createdBy);
                return (
                <tr
                  key={str(r.id)}
                  className="border-t cursor-pointer hover:bg-slate-50"
                  onClick={() => setDetail(r)}
                >
                  <td className="px-3 py-2 font-mono text-xs">{str(r.noRelease)}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(str(r.tanggal))}</td>
                  <td className="px-3 py-2 text-xs">{str(r.lokasiNama) || str(r.lokasiKode)}</td>
                  <td className="px-3 py-2 max-w-[200px] truncate" title={str(r.keperluan)}>{str(r.keperluan)}</td>
                  <td className="px-3 py-2 text-center">{asArray(r.items).length}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_STYLE[str(r.status)] || ''}`}>{str(r.status)}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{str(createdBy.userName) || '—'}</td>
                  <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-center gap-1.5 flex-nowrap">
                      {canUserEditRelease(r, user) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 whitespace-nowrap"
                          onClick={() => { void openEditForm(r); }}
                        >
                          <Pencil className="w-3.5 h-3.5 mr-1" />
                          Edit
                        </Button>
                      )}
                      {str(r.status) === 'DRAFT' && canCreate && str(createdBy.userId) === str(user?.id) && (
                        <Button size="sm" variant="outline" className="h-8 whitespace-nowrap" onClick={() => action(str(r.id), 'submit')}>
                          <Send className="w-3.5 h-3.5 mr-1" /> Ajukan
                        </Button>
                      )}
                      {str(r.status) === 'DRAFT' && canUserEditRelease(r, user) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-2"
                          title="Hapus draft"
                          aria-label={`Hapus draft ${str(r.noRelease)}`}
                          onClick={() => { void deleteDraft(r); }}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      )}
                      {renderPendingActions(r)}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={(open) => { if (!open) closeReleaseForm(); else setShowForm(true); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingReleaseId
                ? `${editingRejectReason ? 'Perbaiki Release' : 'Edit Draft'}${editingNoRelease ? ` — ${editingNoRelease}` : ''}`
                : 'Buat Release Inventory'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 py-2">
            {editingRejectReason && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <span className="font-medium">Alasan ditolak:</span> {editingRejectReason}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Gudang asal *</Label>
                <Select
                  value={form.lokasiKode}
                  onValueChange={(v) => {
                    setPrefill(null);
                    setOverFlags({});
                    setForm((prev) => ({
                      ...prev,
                      lokasiKode: v,
                      items: editingReleaseId ? prev.items : [],
                    }));
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {WAREHOUSES.map((w) => (
                      <SelectItem key={w.kode} value={w.kode}>{w.nama}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>
                  Rencana produksi
                  {looksLikeProductionKeperluanForm ? ' *' : ' (opsional)'}
                </Label>
                <select
                  className="w-full h-10 border rounded-md px-2 text-sm bg-white"
                  value={form.productionPlanId}
                  onChange={(e) => {
                    setPrefill(null);
                    setOverFlags({});
                    setForm((prev) => ({ ...prev, productionPlanId: e.target.value }));
                  }}
                >
                  <option value="">— Tidak terkait rencana —</option>
                  {productionPlans.map((p) => (
                    <option key={str(p.id)} value={str(p.id)}>
                      {str(p.noDokumen)} · {str(p.tanggal)} · {str(p.kitchenNama) || 'Dapur'}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Wajib jika bahan untuk produksi — agar PBL bisa sinkron otomatis.
                </p>
              </div>
            </div>
            {looksLikeProductionKeperluanForm && !form.productionPlanId && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Keperluan terlihat untuk produksi — <strong>wajib</strong> pilih Rencana Produksi
                agar stok tercatat ke RPN (PBL bisa sinkron otomatis).
              </div>
            )}
            <div>
              <Label>Keperluan operasional *</Label>
              <Input
                value={form.keperluan}
                onChange={(e) => setForm((prev) => ({ ...prev, keperluan: e.target.value }))}
                placeholder="Contoh: Maintenance AC, sampel QC, dll."
              />
            </div>
            <div>
              <Label>Catatan</Label>
              <Textarea
                rows={2}
                value={form.keterangan}
                onChange={(e) => setForm((prev) => ({ ...prev, keterangan: e.target.value }))}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label>Item barang</Label>
              <div className="flex items-center gap-2">
                {rlFromPoReference && form.productionPlanId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={prefillLoading}
                    onClick={() => { void fillFromPlan(); }}
                    title="Isi qty dari sisa acuan rencana (PO diterima, atau MRP bila tanpa PO), dibatasi stok gudang ini"
                  >
                    {prefillLoading ? 'Memuat…' : 'Isi dari PO rencana'}
                  </Button>
                )}
                <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                  <Plus className="w-3 h-3 mr-1" /> Tambah
                </Button>
              </div>
            </div>
            {prefill && prefill.skipped.length > 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 space-y-0.5">
                <div className="font-medium">Tidak diisi dari acuan:</div>
                {prefill.skipped.map((s) => (
                  <div key={s.productId}>
                    {s.nama || s.kode || s.productId} — {PREFILL_SKIP_LABEL[s.reason]}
                    {s.reason === 'GUDANG_LAIN' && s.warehouseKode ? ` (${warehouseName(s.warehouseKode)})` : ''}
                    {s.reason === 'MENUNGGU_RL' ? ` (${formatNumber(s.rlPending)} ${s.satuan || ''})` : ''}
                    {s.warnings?.map((w) => (
                      <div key={w} className="text-amber-700">{w}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {form.items.map((it, i) => {
                const display = resolveReleaseItemDisplay(it, productById, form.lokasiKode);
                const acuan = prefill?.lines.find((l) => l.stokId === it.stokId);
                const exceedsAcuan = !!acuan && it.uomId === acuan.uomId
                  && it.qty > Math.max(0, acuan.sisa - acuan.rlPending);
                const overFlag = overFlags[it.stokId];
                const showOverReason = rlFromPoReference && !!form.productionPlanId
                  && (!!overFlag || exceedsAcuan || !!it.overReason);
                return (
                  <div
                    key={it.clientKey || `${it.stokId}-${it.uomId}-${i}`}
                    className="flex flex-col gap-2 border rounded-md p-2.5 text-sm sm:flex-row sm:items-start"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-medium leading-snug break-words" title={display.nama}>
                        {display.nama}
                      </div>
                      <div className="text-xs text-slate-500 break-words">
                        {display.kode ? `${display.kode} · ` : ''}
                        tersedia: {formatNumber(display.stokAvail)} base
                      </div>
                      {acuan && (
                        <div className="text-xs text-slate-600">
                          Acuan {acuan.sumber} {formatNumber(acuan.acuanQty)} · sudah RL {formatNumber(acuan.rlPosted)}
                          {acuan.rlPending > 0 ? ` · menunggu ${formatNumber(acuan.rlPending)}` : ''}
                          {' '}· sisa {formatNumber(acuan.sisa)} {acuan.satuan || ''}
                          {acuan.display ? ` (≈ ${formatNumber(acuan.display.qty)} ${acuan.display.satuan})` : ''}
                          {acuan.cappedByStock && (
                            <span className="text-amber-700"> · dibatasi stok</span>
                          )}
                        </div>
                      )}
                      {acuan && exceedsAcuan && (
                        <div className="text-xs text-amber-700">
                          Melebihi sisa acuan ({formatNumber(Math.max(0, acuan.sisa - acuan.rlPending))} {acuan.satuan || ''})
                        </div>
                      )}
                      {acuan?.warnings?.map((w) => (
                        <div key={w} className="text-xs text-amber-700">{w}</div>
                      ))}
                      {overFlag && <div className="text-xs text-red-700">{overFlag}</div>}
                      {showOverReason && (
                        <Input
                          className={`h-8 text-xs ${overFlag && !it.overReason?.trim() ? 'border-red-400' : ''}`}
                          maxLength={300}
                          placeholder="Alasan melebihi acuan (wajib bila melebihi)"
                          value={it.overReason || ''}
                          onChange={(e) => {
                            const overReason = e.target.value;
                            setForm((prev) => ({
                              ...prev,
                              items: prev.items.map((x, idx) => (idx === i ? { ...x, overReason } : x)),
                            }));
                          }}
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Input
                        type="number"
                        min={0}
                        max={display.stokAvail}
                        className="w-24 shrink-0"
                        value={it.qty}
                        onChange={(e) => {
                          const qty = parseFloat(e.target.value) || 0;
                          setForm((prev) => ({
                            ...prev,
                            items: prev.items.map((x, idx) => (idx === i ? { ...x, qty } : x)),
                          }));
                        }}
                      />
                      <div className="w-28 shrink-0">
                        <LineUomSelect
                          stokId={it.stokId}
                          uomId={it.uomId}
                          className="w-full"
                          onChange={(uom) => updateItemUom(i, uom)}
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0"
                        onClick={() => setForm((prev) => ({
                          ...prev,
                          items: prev.items.filter((_, idx) => idx !== i),
                        }))}
                      >
                        Hapus
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!form.items.length && (
                <p className="text-sm text-slate-400 text-center py-4">Belum ada item</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeReleaseForm}>Batal</Button>
            <Button variant="outline" disabled={saving} onClick={() => save(false)}>
              {editingRejectReason ? 'Simpan Perbaikan' : 'Simpan Draft'}
            </Button>
            <Button disabled={saving} className="bg-orange-500 hover:bg-orange-600" onClick={() => save(true)}>
              {editingRejectReason ? 'Ajukan Ulang ke Supervisor' : 'Ajukan ke Supervisor'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader><DialogTitle>Pilih Produk — {WAREHOUSES.find((w) => w.kode === form.lokasiKode)?.nama}</DialogTitle></DialogHeader>
          <Input placeholder="Cari..." value={pickerQ} onChange={(e) => setPickerQ(e.target.value)} />
          <div className="overflow-y-auto flex-1 space-y-1">
            {filteredProducts.map((p) => {
              const avail = qtyAtLokasi(p, form.lokasiKode);
              const label = str(p.nama).trim() || str(p.kode).trim() || 'Produk';
              return (
                <button
                  key={str(p.id)}
                  type="button"
                  disabled={avail <= 0}
                  className="w-full text-left border rounded p-2 text-sm hover:bg-slate-50 disabled:opacity-40"
                  onClick={() => addItem(p)}
                >
                  <div className="font-medium break-words">{label}</div>
                  <div className="text-xs text-slate-500">
                    {str(p.kode) ? <span className="font-mono">{str(p.kode)}</span> : null}
                    {str(p.kode) ? ' · ' : ''}
                    stok: {formatNumber(avail)} {str(p.satuan)}
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {str(detail?.noRelease)}{' '}
              <span className={`ml-1 px-2 py-0.5 rounded text-xs align-middle ${STATUS_STYLE[str(detail?.status)] || ''}`}>
                {str(detail?.status)}
              </span>
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
                <div>Tanggal: <span className="text-slate-900">{formatDateTime(str(detail.tanggal))}</span></div>
                <div>Gudang: <span className="text-slate-900">{str(detail.lokasiNama) || str(detail.lokasiKode)}</span></div>
                <div className="col-span-2">Keperluan: <span className="text-slate-900">{str(detail.keperluan)}</span></div>
                {str(detail.productionPlanNo) && (
                  <div className="col-span-2">
                    Rencana produksi:{' '}
                    <span className="font-mono text-slate-900">{str(detail.productionPlanNo)}</span>
                  </div>
                )}
                {!!str(detail.keterangan) && (
                  <div className="col-span-2">Catatan: <span className="text-slate-900">{str(detail.keterangan)}</span></div>
                )}
                <div>Dibuat oleh: <span className="text-slate-900">{str(asObject(detail.createdBy).userName) || '—'}</span></div>
                {str(detail.status) === 'POSTED' && (
                  <div>Disetujui oleh: <span className="text-slate-900">{str(asObject(detail.approvedBy).userName) || '—'}</span></div>
                )}
                {str(detail.status) === 'REJECTED' && (
                  <>
                    <div>Ditolak oleh: <span className="text-slate-900">{str(asObject(detail.rejectedBy).userName) || '—'}</span></div>
                    <div className="col-span-2">Alasan: <span className="text-slate-900">{str(detail.rejectReason) || '—'}</span></div>
                  </>
                )}
                {str(asObject(detail.planLink).source) === 'MANUAL' && (
                  <div className="col-span-2">
                    Ditautkan manual oleh {str(asObject(asObject(detail.planLink).linkedBy).userName) || '—'}
                    {' '}({formatDateTime(str(asObject(detail.planLink).linkedAt))}):{' '}
                    <span className="text-slate-900">{str(asObject(detail.planLink).reason)}</span>
                  </div>
                )}
                {!!str(detail.planLinkDismissReason) && (
                  <div className="col-span-2">
                    Ditandai bukan produksi oleh {str(asObject(detail.planLinkDismissedBy).userName) || '—'}:{' '}
                    <span className="text-slate-900">{str(detail.planLinkDismissReason)}</span>
                  </div>
                )}
              </div>
              {asArray(asObject(detail.overIssue).lines).length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 space-y-1">
                  <div className="font-medium">
                    Melebihi acuan rencana (toleransi {formatNumber(num(asObject(detail.overIssue).tolerancePct))}%)
                    {' '}— wajib disetujui selain pembuat
                  </div>
                  {asArray(asObject(detail.overIssue).lines).map((raw, idx) => {
                    const l = asObject(raw);
                    return (
                      <div key={idx}>
                        <span className="font-medium">{str(l.productNama) || str(l.productKode)}</span>:{' '}
                        {describeOverLine({
                          sumber: str(l.sumber),
                          satuan: str(l.satuan),
                          lineIndexes: [],
                          acuanQty: num(l.acuanQty),
                          consumedBefore: num(l.consumedBefore),
                          qtyAfter: num(l.qtyAfter),
                          limitQty: num(l.limitQty),
                          missingReason: false,
                        })}
                        {asArray(l.reasons).length > 0 && (
                          <div className="text-red-900">Alasan: {asArray(l.reasons).map((x) => str(x)).join('; ')}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="rounded-md border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                    <tr>
                      <th className="text-left px-3 py-2">Kode</th>
                      <th className="text-left px-3 py-2">Nama</th>
                      <th className="text-right px-3 py-2">Qty</th>
                      <th className="text-left px-3 py-2">Satuan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {asArray(detail.items).map((it, i) => {
                      const line = asObject(it);
                      return (
                        <tr key={i} className="border-t">
                          <td className="px-3 py-2 font-mono text-xs">{str(line.kode) || '—'}</td>
                          <td className="px-3 py-2">
                            {str(line.nama).trim() || str(line.kode) || '—'}
                            {!!str(line.overReason) && (
                              <div className="text-[11px] text-red-700">Alasan lebih: {str(line.overReason)}</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNumber(num(line.qty))}</td>
                          <td className="px-3 py-2">{str(line.satuan)}</td>
                        </tr>
                      );
                    })}
                    {!asArray(detail.items).length && (
                      <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-400">Tidak ada item</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {detail && canUserEditRelease(detail, user) ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    void openEditForm(detail);
                    setDetail(null);
                  }}
                >
                  <Pencil className="w-4 h-4 mr-1" />
                  {str(detail.status) === 'REJECTED' ? 'Perbaiki Release' : 'Edit Draft'}
                </Button>
              ) : null}
              {detail && str(detail.status) === 'DRAFT' && canUserEditRelease(detail, user) ? (
                <Button
                  variant="outline"
                  className="text-destructive border-destructive/40 hover:bg-destructive/5"
                  onClick={() => { void deleteDraft(detail); }}
                >
                  <Trash2 className="w-4 h-4 mr-1" />
                  Hapus Draft
                </Button>
              ) : null}
            </div>
            <Button variant="outline" onClick={() => setDetail(null)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPanduan} onOpenChange={setShowPanduan}>
        <DialogContent className="max-w-5xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Panduan Release</DialogTitle>
            <p className="text-sm text-slate-500">
              SOH per lot (asal PO/RPN / penyesuaian) dan sisa stok tanpa lot — filter gudang di bawah.
            </p>
          </DialogHeader>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5 min-w-[220px]">
              <Label>Gudang</Label>
              <Select value={panduanWarehouseKode} onValueChange={setPanduanWarehouseKode}>
                <SelectTrigger>
                  <SelectValue placeholder="Pilih gudang" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PANDUAN_WH_ALL}>Semua gudang</SelectItem>
                  {WAREHOUSES.map((w) => (
                    <SelectItem key={w.kode} value={w.kode}>
                      {w.nama} ({w.kode})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-slate-500 pb-2">
              Menampilkan: <span className="font-medium text-slate-700">{panduanWarehouseLabel}</span>
            </p>
          </div>
          <div className="overflow-y-auto flex-1 border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600 sticky top-0">
                <tr>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-right">SOH</th>
                  <th className="px-3 py-2 text-left">Asal</th>
                  <th className="px-3 py-2 text-left">Tgl Terima</th>
                  <th className="px-3 py-2 text-center">Status Invoice</th>
                  <th className="px-3 py-2 text-left">Gudang</th>
                </tr>
              </thead>
              <tbody>
                {panduanLoading && !panduanRows.length && (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-slate-400">Memuat…</td>
                  </tr>
                )}
                {!panduanLoading && !panduanRows.length && (
                  <tr>
                    <td colSpan={6} className="text-center py-10 text-slate-400">
                      Tidak ada SOH untuk filter gudang ini
                    </td>
                  </tr>
                )}
                {panduanRows.map((r, idx) => {
                  const invStatus = str(r.invoiceStatus) || 'BELUM';
                  const rowKey = str(r.lotId) || `untracked-${str(r.productId)}-${str(r.warehouseKode)}-${idx}`;
                  return (
                    <tr key={rowKey} className="border-t align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{str(r.productNama) || '—'}</div>
                        <div className="text-[11px] font-mono text-slate-500">{str(r.productKode)}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {formatNumber(num(r.soh))}
                        {str(r.satuan) ? (
                          <span className="text-slate-500 text-xs ml-1">{str(r.satuan)}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[240px]">
                        <div>{str(r.asal) || '—'}</div>
                        {str(r.noGRN) ? (
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5">{str(r.noGRN)}</div>
                        ) : str(r.noPenyesuaian) ? (
                          <div className="text-[11px] text-slate-400 font-mono mt-0.5">{str(r.noPenyesuaian)}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {formatDate(str(r.tanggalTerima)) || '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`px-2 py-0.5 rounded text-xs ${INVOICE_STATUS_STYLE[invStatus] || ''}`}>
                          {invStatus}
                        </span>
                        {str(r.noInvoice) ? (
                          <div className="text-[11px] font-mono text-slate-500 mt-0.5">{str(r.noInvoice)}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {str(r.warehouseNama) || str(r.warehouseKode) || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <ListExportMenu onExport={exportPanduan} disabled={panduanLoading || panduanRows.length === 0} />
            <Button variant="outline" onClick={() => setShowPanduan(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {rlFromPoReference && canApprove && (
        <UnlinkedReleasesDialog open={showUnlinked} onOpenChange={setShowUnlinked} />
      )}
    </>
  );
}
