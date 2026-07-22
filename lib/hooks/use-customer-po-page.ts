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
  isPendingOptimisticPo,
} from '@/lib/pembelian-po/helpers';
import { canEditCustomerPo } from '@/lib/pembelian-po/permissions';
import { useCustomerPoList } from '@/hooks/useCustomerPoData';
import { fetchDefaultProductUom, primeProductUomsCacheFromProducts } from '@/lib/hooks/use-product-uoms';
import { usePrimeLineItemUoms } from '@/lib/hooks/use-prime-line-uoms';
import { patchPoEstimasiLineOnUomChange } from '@/lib/uom/line-patch';
import type { ProductUom } from '@/lib/uom/types';
import { useBgJob } from '@/lib/hooks/use-bg-job';
import { usePoMutations } from '@/lib/hooks/use-po-mutations';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { queryKeys } from '@/lib/query-keys';
import { useQueryClient } from '@/lib/hooks/useApiQuery';
import { invalidatePoCaches } from '@/lib/hooks/invalidate-operational';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { PoMutationAmbiguousError } from '@/lib/pembelian-po/mutation-errors';

export function useCustomerPoPage() {
  const queryClient = useQueryClient();
  const [user] = useState<JsonObject | null>(() => getUser() as JsonObject | null);
  const {
    list, reload: reloadList, setList, hasMore, loadMore, loadingMore, loading: listLoading,
  } = useCustomerPoList();
  const poMutations = usePoMutations(setList, async () => { await reloadList(); });
  const syncPendingMutation = useApiMutation([queryKeys.customerPurchaseOrders.all]);
  const [productCache, setProductCache] = useState<Record<string, JsonObject>>({});
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
  const autoSyncCooldownUntil = useRef(0);
  const [vendorSyncJobId, setVendorSyncJobId] = useState<string | null>(null);
  const { data: vendorSyncJob } = useBgJob(vendorSyncJobId);
  const [vendorTierMap, setVendorTierMap] = useState<JsonObject>({});
  const [vendorNameMap, setVendorNameMap] = useState<Record<string, string>>({});
  const [defaultTier, setDefaultTier] = useState('ECER');
  const searchParams = useSearchParams();
  const [wrMeta, setWrMeta] = useState<JsonObject | null>(null);
  const wrPrefillDone = useRef(false);

  usePrimeLineItemUoms(createOpen || Boolean(editingPo), lines.map((l) => str(l.localStokId)));

  const rememberProduct = useCallback((product: JsonObject) => {
    const id = str(product.id);
    if (!id) return;
    setProductCache((prev) => (prev[id] ? prev : { ...prev, [id]: product }));
    primeProductUomsCacheFromProducts([product as { id?: string; uoms?: ProductUom[] }]);
  }, []);

  const loadProductsByIds = useCallback(async (ids: string[]) => {
    const missing = [...new Set(ids.filter(Boolean))].filter((id) => !productCache[id]);
    if (!missing.length) return;
    try {
      const data = await fetchJson<JsonObject[] | { items?: JsonObject[] }>(
        `/api/products?ids=${missing.join(',')}&includeUom=1&withWarehouseStock=1`,
      );
      const rows = Array.isArray(data) ? data : (data?.items || []);
      if (!rows.length) return;
      setProductCache((prev) => {
        const next = { ...prev };
        for (const p of rows) {
          const id = str(p.id);
          if (id) next[id] = p;
        }
        return next;
      });
      primeProductUomsCacheFromProducts(rows as Array<{ id?: string; uoms?: ProductUom[] }>);
    } catch {
      // Produk opsional untuk tampilan form — gagal muat tidak memblokir edit.
    }
  }, [productCache]);

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
    loadVendorTiers();
    const onCatalogSynced = () => {
      loadVendorTiers();
    };
    window.addEventListener('vendor-catalog-synced', onCatalogSynced);
    return () => window.removeEventListener('vendor-catalog-synced', onCatalogSynced);
  }, [reloadList, loadVendorTiers]);

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

  // Deep-link from Food Production Kebutuhan Beli (?highlight=<cpoId>)
  const highlightDone = useRef<string | null>(null);
  useEffect(() => {
    const highlightId = searchParams.get('highlight') || searchParams.get('poId');
    if (!highlightId) return;
    if (highlightDone.current === highlightId) return;
    setExpandedId(highlightId);
    setShowAll(true);

    let cancelled = false;
    async function ensureHighlight() {
      if (listLoading) return;

      const inList = (Array.isArray(list) ? list : []).some((p) => str(p.id) === highlightId);
      if (!inList) {
        try {
          const po = await fetchJson<JsonObject>(`/api/customer-purchase-orders/${highlightId}`);
          if (cancelled || !po?.id) return;
          setList((prev) => {
            const rows = Array.isArray(prev) ? prev : [];
            if (rows.some((p) => str(p.id) === highlightId)) return rows;
            return [po, ...rows];
          });
        } catch {
          toast.error('PO target highlight tidak ditemukan');
          highlightDone.current = highlightId;
          return;
        }
      }

      // Wait a tick for DOM after list patch / showAll
      requestAnimationFrame(() => {
        if (cancelled) return;
        const flash = (node: HTMLElement) => {
          node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node.classList.add('ring-2', 'ring-primary');
          setTimeout(() => node.classList.remove('ring-2', 'ring-primary'), 2500);
        };
        const el = document.getElementById(`cpo-row-${highlightId}`);
        if (el) {
          flash(el);
          highlightDone.current = highlightId;
          return;
        }
        // One short retry; always mark done so we don't soft-loop on list updates
        setTimeout(() => {
          if (cancelled) return;
          const again = document.getElementById(`cpo-row-${highlightId}`);
          if (again) flash(again);
          else setExpandedId(highlightId);
          highlightDone.current = highlightId;
        }, 200);
      });
    }

    void ensureHighlight();
    return () => { cancelled = true; };
  }, [searchParams, list, listLoading, setList]);

  const canCreate = (PO_CAN_CREATE as readonly string[]).includes(String(user?.role || ''));
  const canRequest = (PO_CAN_REQUEST as readonly string[]).includes(String(user?.role || ''));
  const canDirectSubmit = (PO_CAN_DIRECT_SUBMIT as readonly string[]).includes(String(user?.role || ''));
  const canApprove = (PO_CAN_APPROVE as readonly string[]).includes(String(user?.role || ''));

  const vendorNameById = useMemo(() => {
    const map = { ...vendorNameMap };
    for (const p of Object.values(productCache)) {
      const id = str(p.vendorTenantId);
      const name = str(p.vendorTenantName);
      if (id && name && name !== id && !map[id]) map[id] = name;
    }
    return map;
  }, [vendorNameMap, productCache]);

  const pendingVendorSyncCount = useMemo(
    () => (Array.isArray(list) ? list : []).filter(
      (p) => !isPendingOptimisticPo(p)
        && p.status === 'APPROVED'
        && p.vendorSyncPending !== false,
    ).length,
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
          invalidatePoCaches(queryClient);
          const labels = syncedRows.map((s) => {
            const noPo = str(s.noPO);
            const noSo = str(s.vendorNoSO);
            return noSo ? `${noPo} → ${noSo}` : noPo;
          }).filter(Boolean).join(', ');
          const firstNoSo = syncedRows.map((s) => str(s.vendorNoSO)).find(Boolean) || '';
          const salesBase = String(process.env.NEXT_PUBLIC_SALES_APP_URL || '').replace(/\/$/, '');
          toast.success(`${syncedRows.length} PO terkirim ke vendor`, {
            description: labels,
            ...(salesBase && firstNoSo
              ? {
                  action: {
                    label: `Buka ${firstNoSo}`,
                    onClick: () => {
                      window.open(
                        `${salesBase}/penjualan/sales-order`,
                        '_blank',
                        'noopener,noreferrer',
                      );
                    },
                  },
                }
              : {}),
          });
        } else {
          void reloadList();
          autoSyncCooldownUntil.current = Date.now() + 60_000;
        }
        setVendorSyncJobId(null);
        autoSyncBusy.current = false;
      } else {
        toast.warning(String(vendorSyncJob.lastError || asObject(vendorSyncJob.result).error || 'Sync PO vendor gagal'));
        setVendorSyncJobId(null);
        autoSyncBusy.current = false;
        autoSyncCooldownUntil.current = Date.now() + 60_000;
      }
    }, 0);
    return () => clearTimeout(t);
  }, [vendorSyncJob, vendorSyncJobId, reloadList, queryClient]);

  const runAutoVendorSync = useCallback(async () => {
    if (autoSyncBusy.current) return;
    if (Date.now() < autoSyncCooldownUntil.current) return;
    autoSyncBusy.current = true;
    let startedAsyncJob = false;
    try {
      const data = await syncPendingMutation.mutateAsync({
        url: '/api/customer-purchase-orders/sync-pending',
        offlineLabel: 'Sync PO pending ke vendor',
      }) as JsonObject;
      if (data.async === false) {
        const syncedRows = asArray(data.synced) as JsonObject[];
        if (syncedRows.length > 0) {
          await reloadList();
          invalidatePoCaches(queryClient);
          const labels = syncedRows.map((s) => str(s.noPO)).filter(Boolean).join(', ');
          toast.success(`${syncedRows.length} PO terkirim ke vendor`, { description: labels });
        } else if (data.error) {
          toast.warning(String(data.error));
          autoSyncCooldownUntil.current = Date.now() + 60_000;
        }
        return;
      }
      if (data.jobId) {
        if (!data.reused) {
          toast.info('Mengirim PO ke vendor di background…');
        }
        setVendorSyncJobId(String(data.jobId));
        startedAsyncJob = true;
        return;
      }
      const syncedRows = asArray(data.synced) as JsonObject[];
      if (syncedRows.length > 0) {
        await reloadList();
        invalidatePoCaches(queryClient);
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
    if (vendorSyncJobId) return undefined;
    if (Date.now() < autoSyncCooldownUntil.current) return undefined;
    const t = setTimeout(() => {
      void runAutoVendorSync();
    }, 800);
    return () => clearTimeout(t);
  }, [user, pendingVendorSyncCount, vendorSyncJobId, runAutoVendorSync]);

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
    const itemIds = asArray(po.items)
      .map((it) => str(asObject(it).localStokId || asObject(it).stokId))
      .filter(Boolean);
    void loadProductsByIds(itemIds);
  };

  const canEditPo = (po: JsonObject) => {
    if (isPendingOptimisticPo(po)) return false;
    return canEditCustomerPo(String(user?.role || ''), po, {
      isMaster: user?.role === 'MASTER',
      userId: str(user?.id),
    });
  };

  const buildItemsPayload = () => {
    const map = new Map<string, JsonObject>();
    for (const l of lines) {
      const p = productCache[str(l.localStokId)];
      if (!p || !l.qty) continue;
      if (!p.vendorStokId && p.syncSource !== 'sales.app') continue;
      const qty = num(l.qty);
      const uomId = str(l.uomId);
      const productId = str(p.id);
      const key = uomId ? `${productId}::${uomId}` : productId;
      const estimasiHarga = parseEstimasiHargaInput(l.estimasiHarga as string | number | null | undefined);
      const prev = map.get(key);
      if (prev) {
        prev.qty = num(prev.qty) + qty;
        if (l.estimasiManual && estimasiHarga) prev.estimasiHarga = estimasiHarga;
      } else {
        map.set(key, {
          localStokId: productId,
          vendorStokId: p.vendorStokId,
          vendorTenantId: p.vendorTenantId,
          vendorKode: p.kode,
          kode: p.kode,
          nama: p.nama,
          satuan: str(l.satuan) || p.satuan,
          uomId: uomId || undefined,
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
    setExpandedId(null);
    const nextMonth = startOfMonth(date);
    if (dateKey(month) !== dateKey(nextMonth)) setMonth(nextMonth);
  };

  const addLine = () => setLines([...lines, emptyPoLine()]);

  const pickProduct = useCallback((index: number, product: JsonObject) => {
    rememberProduct(product);
    void selectProduct(index, str(product.id), product);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- selectProduct stabil via closure baris form
  }, [rememberProduct, lines, productCache, vendorTierMap, defaultTier]);

  async function selectProduct(i: number, id: string, picked?: JsonObject | null) {
    if (!id) {
      updateLine(i, { localStokId: '', uomId: '', satuan: '', factorToBase: undefined, estimasiHarga: '', estimasiManual: false });
      return;
    }
    const defaultUom = await fetchDefaultProductUom(id);
    const uomId = defaultUom?.id || '';
    const satuan = defaultUom?.satuan || '';
    const existingIdx = lines.findIndex(
      (l, idx) => idx !== i && l.localStokId === id && str(l.uomId) === uomId,
    );
    let p: JsonObject | null | undefined = picked || productCache[id];
    if (!p) {
      try {
        p = await fetchJson<JsonObject>(`/api/products/${id}`);
        rememberProduct(p);
      } catch {
        p = null;
      }
    }
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
      uomId,
      satuan,
      factorToBase: defaultUom?.factorToBase,
      estimasiHarga: poEstimasiFromProduct(p, vendorTierMap as Record<string, string>, defaultTier) || '',
      estimasiManual: false,
    });
  }

  const updateFormItemUom = (i: number, uom: ProductUom) => {
    const line = lines[i];
    if (!line?.localStokId) return;
    const dupIdx = lines.findIndex(
      (l, idx) => idx !== i && l.localStokId === line.localStokId && str(l.uomId) === uom.id,
    );
    if (dupIdx >= 0) {
      const mergedQty = num(lines[dupIdx].qty) + num(line.qty, 1);
      const next = lines
        .map((l, idx) => (idx === dupIdx ? { ...l, qty: mergedQty } : l))
        .filter((_, idx) => idx !== i);
      setLines(next.length ? next : [emptyPoLine()]);
      toast.info('Baris digabung — satuan sama');
      return;
    }
    updateLine(i, patchPoEstimasiLineOnUomChange(line, uom));
  };
  const removeLine = (i: number) => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines);
  const updateLine = (i: number, patch: JsonObject) => setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const lineDetails = useMemo(() => lines.map((l): JsonObject & { product: JsonObject | null } => {
    const p = productCache[str(l.localStokId)];
    return { ...l, product: p || null };
  }), [lines, productCache]);

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
        _optimistic: true,
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
      } else if (e instanceof PoMutationAmbiguousError) {
        toast.info('Memuat daftar PO…', { description: e.message });
        await reloadList();
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

  const trackVendorSyncJob = useCallback((jobId: string | null | undefined) => {
    if (!jobId) return;
    setVendorSyncJobId(String(jobId));
  }, []);

  const approvePo = async (id: string) => {
    setSubmitting(id);
    try {
      const data = await poMutations.approve(id);
      trackVendorSyncJob(data.vendorSyncJobId != null ? String(data.vendorSyncJobId) : null);
      if (data.retried) {
        if (data.vendorSynced) {
          toast.success(`Terkirim → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
        } else if (data.vendorSyncError) {
          toast.error(String(data.vendorSyncError));
        } else {
          toast.warning('Kirim vendor belum selesai — coba Kirim ke vendor lagi');
        }
      } else if (data.vendorSyncPending && !data.vendorSynced) {
        toast.warning('PO disetujui, kirim vendor gagal sebagian', {
          description: data.vendorSyncError ? String(data.vendorSyncError) : 'Ulangi Kirim ke vendor',
        });
      } else if (data.vendorSyncPending || data.async) {
        toast.success('PO disetujui', {
          description: 'Mengirim ke vendor di background — nomor SO muncul otomatis',
        });
      } else if (Array.isArray(data.vendorSubmissions) && data.vendorSubmissions.length > 1) {
        toast.success(`Disetujui → ${data.vendorSubmissions.length} SO vendor: ${formatPoVendorSoDisplay(data, vendorNameById)}`);
      } else {
        toast.success(`Disetujui & dikirim → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else if (e instanceof PoMutationAmbiguousError) {
        toast.info('Memuat status PO…', { description: e.message });
        await reloadList();
      } else {
        toast.error(e instanceof Error ? e.message : 'Gagal menyetujui — tidak dapat menghubungi server');
      }
    }
    setSubmitting('');
  };

  const syncVendorPo = async (id: string) => {
    setSubmitting(id);
    try {
      const data = await poMutations.syncVendor(id);
      trackVendorSyncJob(data.vendorSyncJobId != null ? String(data.vendorSyncJobId) : null);
      if (data.async || (data.vendorSyncPending && !data.vendorSynced)) {
        toast.warning(data.vendorSyncError ? String(data.vendorSyncError) : 'Kirim vendor belum selesai');
      } else {
        invalidatePoCaches(queryClient);
        toast.success(`Dikirim ke vendor → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else if (e instanceof PoMutationAmbiguousError) {
        toast.info('Memuat status PO…', { description: e.message });
        await reloadList();
      } else {
        toast.error(e instanceof Error ? e.message : 'Gagal kirim — tidak dapat menghubungi server');
      }
    }
    setSubmitting('');
  };

  const syncVendorForVendorPo = async (id: string, vendorTenantId: string) => {
    const key = `${id}:${vendorTenantId}`;
    setSubmitting(key);
    try {
      const data = await poMutations.syncVendorForVendor(id, vendorTenantId);
      trackVendorSyncJob(data.vendorSyncJobId != null ? String(data.vendorSyncJobId) : null);
      if (data.async || data.vendorSyncPending) {
        toast.success(`Retry ${vendorNameById[vendorTenantId] || vendorTenantId} di background`, {
          description: 'Nomor SO muncul otomatis setelah sync selesai',
        });
      } else if (data.vendorSynced) {
        toast.success(`Vendor ${vendorNameById[vendorTenantId] || vendorTenantId} tersinkron`);
      } else {
        toast.warning('Masih ada vendor lain yang gagal — ulangi untuk vendor tersebut');
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : 'Gagal kirim vendor');
    }
    setSubmitting('');
  };

  const syncSoLinesPo = async (id: string) => {
    setSubmitting(id);
    try {
      const data = await poMutations.syncSoLines(id);
      if (data.synced) {
        toast.success('Baris PO diselaraskan dengan SO sales.app');
      } else {
        toast.info(typeof data.message === 'string' ? data.message : 'Sudah selaras dengan SO sales.app');
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : 'Gagal sync baris SO');
    }
    setSubmitting('');
  };

  const rejectPo = async (id: string, reason = 'Ditolak admin') => {
    setSubmitting(id);
    try {
      await poMutations.reject(id, reason);
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
      trackVendorSyncJob(data.vendorSyncJobId != null ? String(data.vendorSyncJobId) : null);
      if (data.retried) {
        if (data.vendorSynced) {
          toast.success(`Terkirim → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
        } else if (data.vendorSyncError) {
          toast.error(String(data.vendorSyncError));
        } else {
          toast.warning(typeof data.message === 'string' ? data.message : 'Kirim vendor belum selesai');
        }
      } else if (data.vendorSyncPending && !data.vendorSynced) {
        toast.warning('PO dikirim, sync vendor gagal', {
          description: data.vendorSyncError ? String(data.vendorSyncError) : 'Ulangi Kirim ke vendor',
        });
      } else if (data.vendorSyncPending || data.async) {
        toast.success('PO dikirim (disetujui)', {
          description: 'Mengirim ke vendor di background — nomor SO muncul otomatis',
        });
      } else if (Array.isArray(data.vendorSubmissions) && data.vendorSubmissions.length > 1) {
        toast.success(`Dikirim → ${data.vendorSubmissions.length} SO vendor: ${formatPoVendorSoDisplay(data, vendorNameById)}`);
      } else {
        toast.success(`Dikirim → ${formatPoVendorSoDisplay(data, vendorNameById) || data.vendorSoId || ''}`);
      }
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else if (e instanceof PoMutationAmbiguousError) {
        toast.info('Memuat status PO…', { description: e.message });
        await reloadList();
      } else {
        toast.error(e instanceof Error ? e.message : 'Gagal kirim — tidak dapat menghubungi server');
      }
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
    runAutoVendorSync,
    vendorSyncJobId,
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
    vendorTierMap,
    defaultTier,
    onProductPick: pickProduct,
    openCreate,
    openEdit,
    canEditPo,
    addLine,
    removeLine,
    selectProduct,
    updateLine,
    updateFormItemUom,
    createPo,
    saveEditPo,
    submitting,
    requestApproval,
    approvePo,
    syncVendorPo,
    syncVendorForVendorPo,
    syncSoLinesPo,
    rejectPo,
    submitPo,
    vendorNameById,
    closeFormDialog,
  };
}
