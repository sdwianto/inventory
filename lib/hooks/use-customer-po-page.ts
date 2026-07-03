'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { startOfMonth } from 'date-fns';
import { toast } from 'sonner';
import { fetchJson } from '@/lib/fetch-json';
import { getUser } from '@/lib/auth-client';
import { poEstimasiFromProduct, parseEstimasiHargaInput } from '@/lib/po-estimasi-harga';
import {
  dateKey, formatArrivalLabel, getPoArrivalDate,
} from '@/lib/po-calendar';
import { formatDate } from '@/lib/format';
import {
  PO_CAN_APPROVE,
  PO_CAN_CREATE,
  PO_CAN_DIRECT_SUBMIT,
  PO_CAN_REQUEST,
} from '@/lib/pembelian-po/constants';
import {
  toDateInputValue,
  mergeFormLinesFromPo,
  emptyPoLine,
  formatPoVendorSoDisplay,
} from '@/lib/pembelian-po/helpers';
import { useCustomerPoList, useCustomerPoProducts } from '@/hooks/useCustomerPoData';
import { useBgJob } from '@/lib/hooks/use-bg-job';
import { usePoMutations } from '@/lib/hooks/use-po-mutations';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { useQueryClient } from '@/lib/hooks/useApiQuery';
import { invalidateOperationalCaches } from '@/lib/hooks/invalidate-operational';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';

export function useCustomerPoPage() {
  const queryClient = useQueryClient();
  const [user] = useState<JsonObject | null>(() => getUser() as JsonObject | null);
  const { list, reload: reloadList, setList, hasMore, loadMore, loadingMore } = useCustomerPoList();
  const poMutations = usePoMutations(setList, async () => { await reloadList(); });
  const syncPendingMutation = useApiMutation([queryKeys.customerPurchaseOrders.all]);
  const { products, reloadProducts } = useCustomerPoProducts();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPo, setEditingPo] = useState<JsonObject | null>(null);
  const [createDate, setCreateDate] = useState<Date | null>(null);
  const [lines, setLines] = useState<JsonObject[]>([emptyPoLine()]);
  const [catatan, setCatatan] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const autoSyncBusy = useRef(false);
  const [vendorSyncJobId, setVendorSyncJobId] = useState<string | null>(null);
  const { data: vendorSyncJob } = useBgJob(vendorSyncJobId);
  const [vendorTierMap, setVendorTierMap] = useState<JsonObject>({});
  const [vendorNameMap, setVendorNameMap] = useState<Record<string, string>>({});
  const [defaultTier, setDefaultTier] = useState('ECER');
  const searchParams = useSearchParams();
  const [wrMeta, setWrMeta] = useState<JsonObject | null>(null);
  const wrPrefillDone = useRef(false);

  const loadVendorTiers = useCallback(() => {
    fetchJson('/api/integrations/vendor-tiers')
      .then((data) => {
        const row = data as JsonObject;
        setVendorTierMap((row.tierMap || {}) as JsonObject);
        setDefaultTier(String(row.tierHargaDefault || 'ECER'));
        const nameMap: Record<string, string> = {};
        for (const v of asArray(row.vendors) as JsonObject[]) {
          const id = str(v.vendorTenantId);
          if (id) nameMap[id] = str(v.vendorTenantName) || id;
        }
        setVendorNameMap(nameMap);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Gagal memuat tier vendor'));
  }, []);

  useEffect(() => {
    void reloadList();
    void reloadProducts();
    loadVendorTiers();
    const onCatalogSynced = () => {
      void reloadProducts();
      loadVendorTiers();
    };
    window.addEventListener('vendor-catalog-synced', onCatalogSynced);
    return () => window.removeEventListener('vendor-catalog-synced', onCatalogSynced);
  }, [reloadList, reloadProducts, loadVendorTiers]);

  useEffect(() => {
    const wrId = searchParams.get('wrId');
    if (!wrId || wrPrefillDone.current) return;
    wrPrefillDone.current = true;
    fetchJson<JsonObject>(`/api/maintenance-requests/${wrId}/resolve-prefill`)
      .then((data) => {
        if (!data.canResolvePo) {
          toast.error('Permintaan tidak bisa dibuatkan PO');
          return;
        }
        setWrMeta(data);
        setCatatan(str(data.poCatatan));
        setCreateDate(new Date());
        setLines([emptyPoLine()]);
        setCreateOpen(true);
        toast.info(`PO untuk maintenance ${str(data.noWR)}`);
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Gagal memuat WR'));
  }, [searchParams]);

  const canCreate = (PO_CAN_CREATE as readonly string[]).includes(String(user?.role || ''));
  const canRequest = (PO_CAN_REQUEST as readonly string[]).includes(String(user?.role || ''));
  const canDirectSubmit = (PO_CAN_DIRECT_SUBMIT as readonly string[]).includes(String(user?.role || ''));
  const canApprove = (PO_CAN_APPROVE as readonly string[]).includes(String(user?.role || ''));

  const synced = products.filter((p) => p.syncSource === 'sales.app');

  const vendorNameById = useMemo(() => {
    const map = { ...vendorNameMap };
    for (const p of products) {
      const id = str(p.vendorTenantId);
      const name = str(p.vendorTenantName);
      if (id && name && name !== id && !map[id]) map[id] = name;
    }
    return map;
  }, [vendorNameMap, products]);

  const pendingVendorSyncCount = useMemo(
    () => (Array.isArray(list) ? list : []).filter((p) => p.status === 'APPROVED' && p.vendorSyncPending !== false).length,
    [list],
  );

  useEffect(() => {
    if (!vendorSyncJob || !vendorSyncJobId) return undefined;
    const status = String(vendorSyncJob.status || '');
    if (status !== 'DONE' && status !== 'FAILED') return undefined;

    // Defer supaya setState tidak sinkron di dalam effect (react-hooks/set-state-in-effect).
    const t = setTimeout(() => {
      if (status === 'DONE') {
        const result = asObject(vendorSyncJob.result);
        const syncedRows = asArray(result.synced) as JsonObject[];
        if (syncedRows.length > 0) {
          void reloadList();
          invalidateOperationalCaches(queryClient);
          const labels = syncedRows.map((s) => str(s.noPO)).filter(Boolean).join(', ');
          toast.success(`${syncedRows.length} PO terkirim otomatis ke vendor`, { description: labels });
        }
        setVendorSyncJobId(null);
        autoSyncBusy.current = false;
      } else {
        toast.warning(String(vendorSyncJob.lastError || asObject(vendorSyncJob.result).error || 'Sync PO vendor gagal'));
        setVendorSyncJobId(null);
        autoSyncBusy.current = false;
      }
    }, 0);
    return () => clearTimeout(t);
  }, [vendorSyncJob, vendorSyncJobId, reloadList, queryClient]);

  const runAutoVendorSync = useCallback(async () => {
    if (autoSyncBusy.current) return;
    autoSyncBusy.current = true;
    let startedAsyncJob = false;
    try {
      const data = await syncPendingMutation.mutateAsync({
        url: '/api/customer-purchase-orders/sync-pending',
        offlineLabel: 'Sync PO pending ke vendor',
      }) as JsonObject;
      if (data.jobId) {
        toast.info('PO antrian dikirim ke background');
        setVendorSyncJobId(String(data.jobId));
        startedAsyncJob = true;
        return;
      }
      const syncedRows = asArray(data.synced) as JsonObject[];
      if (syncedRows.length > 0) {
        await reloadList();
        invalidateOperationalCaches(queryClient);
        const labels = syncedRows.map((s) => str(s.noPO)).filter(Boolean).join(', ');
        toast.success(`${syncedRows.length} PO terkirim otomatis ke vendor`, {
          description: labels,
        });
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
    } finally {
      if (!startedAsyncJob) autoSyncBusy.current = false;
    }
  }, [reloadList, queryClient, syncPendingMutation]);

  useEffect(() => {
    if (!user || pendingVendorSyncCount === 0) return undefined;
    const t = setTimeout(() => {
      void runAutoVendorSync();
    }, 0);
    return () => clearTimeout(t);
  }, [user, pendingVendorSyncCount, runAutoVendorSync]);

  const filteredList = useMemo(() => {
    const rows = Array.isArray(list) ? list : [];
    if (showAll || !selectedDate) return rows;
    const key = dateKey(selectedDate);
    return rows.filter((po) => dateKey(getPoArrivalDate(po)) === key);
  }, [list, selectedDate, showAll]);

  const openCreate = (date?: Date | string | null) => {
    const d = date ? new Date(date) : selectedDate ? new Date(selectedDate) : new Date();
    setEditingPo(null);
    setCreateDate(d);
    setLines([emptyPoLine()]);
    setCatatan('');
    setCreateOpen(true);
  };

  const openEdit = (po: JsonObject) => {
    setEditingPo(po);
    setCreateDate(getPoArrivalDate(po) || new Date());
    setLines(mergeFormLinesFromPo(asArray(po.items) as JsonObject[], emptyPoLine));
    setCatatan(str(po.catatan));
    setCreateOpen(true);
  };

  const canEditPo = (po: JsonObject) => {
    const status = str(po.status);
    if (!po || !['DRAFT', 'PENDING_APPROVAL'].includes(status)) return false;
    if (canApprove) return true;
    if (status === 'DRAFT' && user?.role === 'SUPERVISOR') return true;
    const createdBy = asObject(po.createdBy);
    if (status === 'DRAFT' && user?.role === 'GUDANG') {
      return str(createdBy.userId) === str(user?.id);
    }
    return false;
  };

  const buildItemsPayload = () => {
    const map = new Map();
    for (const l of lines) {
      const p = products.find((x) => x.id === l.localStokId);
      if (!p || !l.qty) continue;
      if (!p.vendorStokId && p.syncSource !== 'sales.app') continue;
      const qty = num(l.qty);
      const estimasiHarga = parseEstimasiHargaInput(l.estimasiHarga as string | number | null | undefined);
      const prev = map.get(p.id);
      if (prev) {
        prev.qty += qty;
        if (l.estimasiManual && estimasiHarga) prev.estimasiHarga = estimasiHarga;
      } else {
        map.set(p.id, {
          localStokId: p.id,
          vendorStokId: p.vendorStokId,
          vendorTenantId: p.vendorTenantId,
          vendorKode: p.kode,
          kode: p.kode,
          nama: p.nama,
          satuan: p.satuan,
          qty,
          estimasiHarga,
          hargaBeliReferensi: parseInt(str(p.hargaBeli), 10),
        });
      }
    }
    return [...map.values()];
  };

  const handleSelectDate = (date: Date) => {
    setSelectedDate(dateKey(date));
    setShowAll(false);
    setMonth(startOfMonth(date));
  };

  const addLine = () => setLines([...lines, emptyPoLine()]);

  const selectProduct = (i: number, id: string) => {
    if (!id) {
      updateLine(i, { localStokId: '', estimasiHarga: '', estimasiManual: false });
      return;
    }
    const existingIdx = lines.findIndex((l, idx) => idx !== i && l.localStokId === id);
    const p = synced.find((x) => x.id === id);
    if (existingIdx >= 0) {
      const addQty = num(lines[i].qty, 1);
      const mergedQty = num(lines[existingIdx].qty) + addQty;
      const next = lines
        .map((l, idx) => (idx === existingIdx ? { ...l, qty: mergedQty } : l))
        .filter((_, idx) => idx !== i);
      setLines(next.length ? next : [emptyPoLine()]);
      toast.info(`${p?.nama || 'Produk'} digabung — total qty ${mergedQty}`);
      return;
    }
    updateLine(i, {
      localStokId: id,
      estimasiHarga: poEstimasiFromProduct(p, vendorTierMap as Record<string, string>, defaultTier) || '',
      estimasiManual: false,
    });
  };
  const removeLine = (i: number) => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines);
  const updateLine = (i: number, patch: JsonObject) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineDetails = useMemo(() => lines.map((l): JsonObject & { product: JsonObject | null } => {
    const p = synced.find((x) => x.id === l.localStokId);
    return { ...l, product: p || null };
  }), [lines, synced]);

  const lineSummary = useMemo(() => {
    const filled = lineDetails.filter((l) => l.product && l.qty);
    const totalQty = filled.reduce((s, l) => s + num(l.qty), 0);
    const totalEstimasi = filled.reduce(
      (s, l) => s + num(l.qty) * parseEstimasiHargaInput(l.estimasiHarga as string | number | null | undefined),
      0,
    );
    return { rows: filled.length, totalQty, totalEstimasi };
  }, [lineDetails]);

  const createPo = async () => {
    const items = buildItemsPayload();
    if (!items.length) {
      toast.error('Pilih produk yang sudah di-sync dari sales.app');
      return;
    }
    if (!createDate) {
      toast.error('Tanggal kedatangan wajib');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        items,
        catatan,
        tanggalKedatangan: toDateInputValue(createDate),
        maintenanceRequestId: wrMeta?.id || null,
        assetId: wrMeta?.assetId || null,
      };
      const optimisticRow: JsonObject = {
        id: `temp-${Date.now()}`,
        noPO: '…',
        status: 'DRAFT',
        approvalStatus: 'DRAFT',
        tanggalKedatangan: toDateInputValue(createDate),
        catatan,
        totalQty: lineSummary.totalQty,
        totalEstimasi: lineSummary.totalEstimasi,
      };
      const data = await poMutations.createPO(payload, optimisticRow);
      toast.success(`PO ${data.noPO} dibuat untuk ${formatDate(createDate)}`);
      setCreateOpen(false);
      setEditingPo(null);
      setWrMeta(null);
      setSelectedDate(createDate ? toDateInputValue(createDate) : null);
      setShowAll(false);
      setExpandedId(String(data.id));
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        toast.info('PO disimpan offline — akan disinkron saat online');
        setCreateOpen(false);
        setEditingPo(null);
        setWrMeta(null);
      } else {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }
    setSaving(false);
  };

  const saveEditPo = async () => {
    if (!editingPo) return;
    const items = buildItemsPayload();
    if (!items.length) {
      toast.error('Pilih produk yang sudah di-sync dari sales.app');
      return;
    }
    if (!createDate) {
      toast.error('Tanggal kedatangan wajib');
      return;
    }
    setSaving(true);
    try {
      const poId = str(editingPo.id);
      const payload = {
        items,
        catatan,
        tanggalKedatangan: toDateInputValue(createDate),
      };
      const data = await poMutations.updatePO(poId, payload, {
        catatan,
        tanggalKedatangan: toDateInputValue(createDate),
        totalQty: lineSummary.totalQty,
        totalEstimasi: lineSummary.totalEstimasi,
      });
      toast.success(`PO ${data.noPO} diperbarui`);
      setCreateOpen(false);
      setEditingPo(null);
      setExpandedId(poId);
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        toast.info('Perubahan PO disimpan offline — akan disinkron saat online');
        setCreateOpen(false);
        setEditingPo(null);
      } else {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    }
    setSaving(false);
  };

  const requestApproval = async (id: string) => {
    setSubmitting(id);
    try {
      await poMutations.requestApproval(id);
      toast.success('PO diajukan — menunggu persetujuan Admin');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
    setSubmitting('');
  };

  const approvePo = async (id: string) => {
    setSubmitting(id);
    try {
      const data = await poMutations.approve(id);
      if (data.vendorSynced === false || data.status === 'APPROVED') {
        toast.success('PO disetujui', {
          description: data.vendorSyncError
            ? `Kirim ke vendor ditunda: ${data.vendorSyncError}`
            : 'Menunggu pengiriman ke sales.app',
        });
      } else if (data.vendorSubmissions?.length > 1) {
        toast.success(`Disetujui → ${data.vendorSubmissions.length} SO vendor: ${formatPoVendorSoDisplay(data, vendorNameById)}`);
      } else {
        toast.success(`Disetujui & dikirim → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : 'Gagal menyetujui — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const syncVendorPo = async (id: string) => {
    setSubmitting(id);
    try {
      const data = await poMutations.syncVendor(id);
      toast.success(`Dikirim ke vendor → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : 'Gagal kirim — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const syncVendorForVendorPo = async (id: string, vendorTenantId: string) => {
    const key = `${id}:${vendorTenantId}`;
    setSubmitting(key);
    try {
      const data = await poMutations.syncVendorForVendor(id, vendorTenantId);
      toast.success(`Vendor ${vendorNameById[vendorTenantId] || vendorTenantId} tersinkron`);
      if (!data.vendorSynced) {
        toast.warning('Masih ada vendor lain yang gagal — ulangi untuk vendor tersebut');
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : 'Gagal kirim vendor');
    }
    setSubmitting('');
  };

  const rejectPo = async (id: string) => {
    setSubmitting(id);
    try {
      await poMutations.reject(id);
      toast.success('PO ditolak');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
    setSubmitting('');
  };

  const submitPo = async (id: string) => {
    setSubmitting(id);
    try {
      const data = await poMutations.submit(id);
      if (data.vendorSynced === false || data.status === 'APPROVED') {
        toast.success('PO dikirim (disetujui)', {
          description: data.vendorSyncError
            ? `Sinkron vendor ditunda: ${data.vendorSyncError}`
            : 'Menunggu sales.app',
        });
      } else if (data.vendorSubmissions?.length > 1) {
        toast.success(`Dikirim → ${data.vendorSubmissions.length} SO vendor: ${formatPoVendorSoDisplay(data, vendorNameById)}`);
      } else {
        toast.success(`Dikirim → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : 'Gagal kirim — tidak dapat menghubungi server');
    }
    setSubmitting('');
  };

  const listTitle = showAll || !selectedDate
    ? 'Semua PO'
    : `PO kedatangan ${formatDate(selectedDate)}`;

  const closeFormDialog = () => {
    setCreateOpen(false);
    setEditingPo(null);
  };

  return {
    user,
    list,
    canCreate,
    canRequest,
    canDirectSubmit,
    canApprove,
    pendingVendorSyncCount,
    month,
    setMonth,
    selectedDate,
    showAll,
    setShowAll,
    handleSelectDate,
    listTitle,
    filteredList,
    expandedId,
    setExpandedId,
    hasMore,
    loadMore,
    loadingMore,
    createOpen,
    setCreateOpen,
    editingPo,
    createDate,
    setCreateDate,
    lines,
    lineDetails,
    lineSummary,
    catatan,
    setCatatan,
    saving,
    synced,
    vendorTierMap,
    defaultTier,
    openCreate,
    openEdit,
    canEditPo,
    addLine,
    removeLine,
    selectProduct,
    updateLine,
    createPo,
    saveEditPo,
    submitting,
    requestApproval,
    approvePo,
    syncVendorPo,
    syncVendorForVendorPo,
    rejectPo,
    submitPo,
    vendorNameById,
    closeFormDialog,
  };
}
