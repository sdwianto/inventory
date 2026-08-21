'use client';

import type { JsonObject } from '@/types/json';
import { str, num, asObject, asArray } from '@/types/json';
import type { SessionUser } from '@/types/auth';
import type { ListExportFormat } from '@/lib/run-list-export';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Search, Package, Settings2, RefreshCw } from 'lucide-react';
const ListExportMenu = dynamic(() => import('@/components/ListExportMenu'), { ssr: false });
import BulkSelectionBar from '@/components/BulkSelectionBar';
import { useListSelection } from '@/hooks/useListSelection';
import { runListExport } from '@/lib/run-list-export';
import { postBulkDelete } from '@/lib/bulk-delete-client';
import { formatIDR } from '@/lib/format';
import { useConfirm } from '@/components/ConfirmProvider';
import { useSessionUserWithTenantFilter } from '@/lib/hooks/use-session-user';
import TenantScopeField, { tenantLabel, type TenantOption } from '@/components/TenantScopeField';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { WAREHOUSES, warehouseName } from '@/lib/warehouses-client';
import { resolveVendorTier, vendorPriceFromProduct, vendorTierLabel } from '@/lib/vendor-price';
import { productStockLabel, productStockTitle } from '@/lib/uom/display';
import { EMPTY_PRODUCT, PRODUCT_MANAGE_ROLES, PRODUCT_SELECT_CLASS } from '@/lib/produk/constants';
import {
  ITEM_ROLE_LABELS,
  ITEM_ROLES_UI,
  normalizeItemRole,
  type ItemRole,
} from '@/lib/food-production/item-role';
import {
  classifyProduct,
  isWeakProdukGrup,
  sortProdukGrupOptions,
  suggestProdukGrup,
} from '@/lib/api/product-classification';
import { FormSectionTitle, WarehousePicker } from '@/components/produk/ProductFormParts';
import { useProdukCatalog } from '@/hooks/useProdukCatalog';
import { fetchAllCursorPages } from '@/lib/api/fetch-cursor-pages';
import { useApiQuery, useQueryClient } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { useCatalogSyncJob } from '@/lib/hooks/use-catalog-sync-job';
import { BG_JOB_TERMINAL_STATUSES, isBgJobSuccess } from '@/lib/hooks/use-bg-job';
import { useOnceTerminalEffect } from '@/lib/hooks/use-once-terminal-effect';
import { useMasterTenants } from '@/lib/hooks/use-master-tenants';
import { useProdukMeta } from '@/lib/hooks/use-produk-meta';
import { queryKeys } from '@/lib/query-keys';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';
import { fetchJson } from '@/lib/fetch-json';
import { ProductUomTable } from '@/components/produk/ProductUomTable';
import {
  defaultUomRows,
  formFieldsToProductPayload,
  productToFormFields,
  uomRowsFromProduct,
  validateFormUomRows,
  type ProductLike,
  type ProductUomFormRow,
} from '@/lib/uom/form';

export default function ProdukPage() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { user, filterTenantId, setFilterTenantId } = useSessionUserWithTenantFilter();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<JsonObject | null>(null);
  const [form, setForm] = useState<JsonObject>(EMPTY_PRODUCT);
  const [showMeta, setShowMeta] = useState(false);
  const [newGrup, setNewGrup] = useState('');
  const [newSatuan, setNewSatuan] = useState('');
  const [metaTenantId, setMetaTenantId] = useState('');
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [gudangFilter, setGudangFilter] = useState(() => (
    Object.fromEntries(WAREHOUSES.map((w) => [w.kode, true])) as Record<string, boolean>
  ));
  const [itemRoleFilter, setItemRoleFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const selection = useListSelection((item: { id: string }) => item.id);

  const isMaster = user?.role === 'MASTER';
  const { tenants: masterTenants } = useMasterTenants(isMaster);
  const tenants = masterTenants as TenantOption[];
  const canManageProducts = (PRODUCT_MANAGE_ROLES as readonly string[]).includes(String(user?.role || ''));
  const catalogGudangKode = useMemo(() => {
    const selected = WAREHOUSES.filter((w) => gudangFilter[w.kode]).map((w) => w.kode);
    if (!selected.length || selected.length === WAREHOUSES.length) return '';
    return selected.join(',');
  }, [gudangFilter]);
  const {
    products,
    loading,
    hasMore,
    loadMore,
    loadingMore,
    error,
    reload,
  } = useProdukCatalog({
    filterTenantId,
    isMaster,
    q: debouncedQ,
    gudangKode: catalogGudangKode,
    itemRole: itemRoleFilter,
  });

  const metaScopeTenantId = showMeta
    ? metaTenantId
    : showForm
      ? (str(form.tenantId) || filterTenantId || user?.tenantId || '')
      : '';
  const metaEnabled = showForm || showMeta;
  const { grupList, satuanList } = useProdukMeta(metaScopeTenantId, isMaster, metaEnabled);
  const grupOptions = useMemo(
    () => sortProdukGrupOptions(grupList.map((g) => ({ id: str(g.id), nama: str(g.nama) }))),
    [grupList],
  );

  const { data: vendorTiersData } = useApiQuery<JsonObject>(
    queryKeys.integrations.vendorTiers,
    user ? '/api/integrations/vendor-tiers' : null,
    { enabled: Boolean(user), staleTime: 120_000 },
  );
  const vendorTierMap = asObject(vendorTiersData?.tierMap);
  const defaultTier = str(vendorTiersData?.tierHargaDefault, 'ECER');

  const metaMutation = useApiMutation([queryKeys.productMeta.all]);
  const productMutation = useApiMutation([queryKeys.products.all, queryKeys.productMeta.all]);
  const syncVendorMutation = useApiMutation([queryKeys.products.all, queryKeys.integrations.all]);

  const load = async () => {
    await reload();
    selection.clear();
  };

  const effectiveTenantForForm = () => {
    if (isMaster) return form.tenantId || filterTenantId || '';
    return user?.tenantId || '';
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    selection.clear();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset bulk selection when list scope changes
  }, [debouncedQ, filterTenantId]);

  useEffect(() => {
    if (!user) return undefined;
    const onCatalogSynced = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.integrations.vendorTiers });
      if (isMaster && !filterTenantId) void load();
      else if (!isMaster || filterTenantId) void load();
    };
    window.addEventListener('vendor-catalog-synced', onCatalogSynced);
    return () => window.removeEventListener('vendor-catalog-synced', onCatalogSynced);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load() is stable enough for catalog sync listener
  }, [user, filterTenantId, isMaster, queryClient]);

  const openNew = () => {
    setEditing(null);
    const defaultTenant = isMaster ? (filterTenantId || '') : (user?.tenantId || 'default');
    const nextForm = {
      ...EMPTY_PRODUCT,
      kode: `B${String(Date.now()).slice(-6)}`,
      tenantId: defaultTenant,
      uoms: defaultUomRows(),
    };
    setForm(nextForm);
    setShowForm(true);
  };

  const formUoms = (f: JsonObject): ProductUomFormRow[] => {
    if (Array.isArray(f.uoms)) return f.uoms as ProductUomFormRow[];
    return uomRowsFromProduct(f as ProductLike);
  };

  const openEdit = (p: JsonObject) => {
    setEditing(p);
    const tid = String(p.tenantId || 'default');
    setForm({ ...p, tenantId: tid, uoms: uomRowsFromProduct(p as ProductLike) });
    setShowForm(true);
    void (async () => {
      try {
        let url = `/api/products/${str(p.id)}`;
        url = withActingTenantQuery(url, filterTenantId, isMaster);
        const detail = await fetchJson<JsonObject>(url);
        setForm({
          ...p,
          ...detail,
          tenantId: tid,
          uoms: uomRowsFromProduct({ ...p, ...detail } as ProductLike),
        });
      } catch (e) {
        if (e instanceof OfflineQueuedError) toast.message(e.message);
        else toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const openMetaDialog = () => {
    const tid = effectiveTenantForForm() || filterTenantId;
    if (isMaster && !tid) {
      toast.error('Pilih tenant filter atau tenant produk terlebih dahulu');
      return;
    }
    setMetaTenantId(str(tid));
    setNewGrup('');
    setNewSatuan('');
    setShowMeta(true);
  };

  const addGrup = async () => {
    const nama = newGrup.trim();
    if (!nama) return;
    const payload: JsonObject = { nama };
    if (isMaster && metaTenantId) payload.tenantId = metaTenantId;
    try {
      await metaMutation.mutateAsync({ url: '/api/produk-grup', body: payload });
      setNewGrup('');
      toast.success('Grup ditambahkan');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const addSatuan = async () => {
    const nama = newSatuan.trim().toUpperCase();
    if (!nama) return;
    const payload: JsonObject = { nama };
    if (isMaster && metaTenantId) payload.tenantId = metaTenantId;
    try {
      await metaMutation.mutateAsync({ url: '/api/produk-satuan', body: payload });
      setNewSatuan('');
      toast.success('Satuan ditambahkan');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const removeGrup = async (id: string) => {
    if (!(await confirm({ title: 'Hapus grup?', description: 'Grup yang masih dipakai produk tidak bisa dihapus.', confirmText: 'Hapus' }))) return;
    try {
      await metaMutation.mutateAsync({ url: `/api/produk-grup/${id}`, method: 'DELETE' });
      toast.success('Grup dihapus');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const removeSatuan = async (id: string) => {
    if (!(await confirm({ title: 'Hapus satuan?', description: 'Satuan yang masih dipakai produk tidak bisa dihapus.', confirmText: 'Hapus' }))) return;
    try {
      await metaMutation.mutateAsync({ url: `/api/produk-satuan/${id}`, method: 'DELETE' });
      toast.success('Satuan dihapus');
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (isMaster && !editing && !form.tenantId) {
      toast.error('Pilih tenant untuk produk baru');
      return;
    }
    const vendorLocked = Boolean(editing && isVendorSynced(editing));
    if (!form.grup) {
      toast.error('Pilih grup dari daftar master');
      return;
    }
    const uoms = formUoms(form);
    if (!vendorLocked) {
      const uomErr = validateFormUomRows(uoms);
      if (uomErr) {
        toast.error(uomErr);
        return;
      }
    }
    try {
      let payload: JsonObject;
      if (vendorLocked) {
        payload = {
          hargaBeli: num(form.hargaBeli),
          minStok: num(form.minStok),
          gudangKode: str(form.gudangKode, 'GKERING'),
          itemRole: normalizeItemRole(form.itemRole),
          classificationSource: form.classificationSource === 'manual' ? 'manual' : 'inferred',
        };
      } else {
        const fields = productToFormFields({ ...form, uoms } as ProductLike, str(form.tenantId));
        payload = {
          ...formFieldsToProductPayload(fields, {
            includeTenantId: isMaster && !editing,
            isEdit: Boolean(editing),
          }),
          gudangKode: str(form.gudangKode, 'GKERING'),
        };
        if (!editing) payload.stok = num(form.stok);
      }
      payload.classificationSource = form.classificationSource === 'manual' ? 'manual' : 'inferred';
      // Faktor resep dapur — lokal & vendor (bukan field locked sales.app).
      payload.recipeBaseGrams = form.recipeBaseGrams === '' || form.recipeBaseGrams == null
        ? null
        : num(form.recipeBaseGrams);
      payload.recipeBaseMl = form.recipeBaseMl === '' || form.recipeBaseMl == null
        ? null
        : num(form.recipeBaseMl);
      if (!isMaster) delete payload.tenantId;
      if (editing) delete payload.stok;
      await productMutation.mutateAsync({
        url: editing ? `/api/products/${editing.id}` : '/api/products',
        method: editing ? 'PUT' : 'POST',
        body: payload,
      });
      toast.success(editing ? 'Produk diperbarui' : 'Produk ditambahkan');
      setShowForm(false);
      void load();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Hapus Produk?', description: 'Produk ini akan dihapus dari master data.', confirmText: 'Hapus' }))) return;
    try {
      await productMutation.mutateAsync({ url: `/api/products/${id}`, method: 'DELETE' });
      toast.success('Produk dihapus');
      void load();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const bulkDelete = async () => {
    const ids = selection.ids();
    if (ids.length === 0) return;
    if (!(await confirm({
      title: `Hapus ${ids.length} produk?`,
      description: 'Produk terpilih akan dihapus permanen dari master data.',
      confirmText: 'Hapus semua',
    }))) return;
    setBulkDeleting(true);
    try {
      const data = await postBulkDelete('/api/products/bulk-delete', ids);
      toast.success(`${data.deleted ?? ids.length} produk dihapus`);
      selection.clear();
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
    setBulkDeleting(false);
  };

  const getExportColumns = () => [
    ...(isMaster ? [{ key: 'tenantId', label: 'Tenant', value: (r: JsonObject) => tenantLabel(tenants, str(r.tenantId)) }] : []),
    { key: 'kode', label: 'Kode' },
    { key: 'nama', label: 'Nama' },
    { key: 'grup', label: 'Grup' },
    { key: 'gudangKode', label: 'Gudang', value: (r: JsonObject) => warehouseName(str(r.gudangKode, 'GKERING')) },
    { key: 'satuan', label: 'Satuan' },
    { key: 'isBase', label: 'Satuan Dasar', value: (r: JsonObject) => (r.isBase ? 'Ya' : 'Tidak') },
    { key: 'factorToBase', label: 'Faktor ke Base' },
    { key: 'barcode', label: 'Barcode' },
    { key: 'hargaBeli', label: 'Harga Beli (per base)' },
    { key: 'hargaSpesial', label: 'Harga Spesial' },
    { key: 'hargaGrosir', label: 'Harga Grosir' },
    { key: 'hargaEcer', label: 'Harga Ecer' },
    { key: 'stokBase', label: 'Stok (base)' },
    { key: 'minStok', label: 'Stok Minimum (base)' },
    { key: 'aktif', label: 'Aktif', value: (r) => (r.aktif !== false ? 'Ya' : 'Tidak') },
  ];

  const flattenProductsForExport = (products: JsonObject[]) => {
    const rows: JsonObject[] = [];
    for (const p of products) {
      const uoms = asArray(p.uoms);
      const gudang = warehouseName(str(p.gudangKode, 'GKERING'));
      if (!uoms.length) {
        rows.push({
          tenantId: p.tenantId,
          kode: p.kode,
          nama: p.nama,
          grup: p.grup,
          gudangKode: gudang,
          satuan: p.satuan,
          isBase: true,
          factorToBase: 1,
          barcode: p.barcode,
          hargaBeli: p.hargaBeli,
          hargaSpesial: p.hargaSpesial,
          hargaGrosir: p.hargaGrosir,
          hargaEcer: p.hargaEcer,
          stokBase: p.stok,
          minStok: p.minStok,
          aktif: p.aktif,
        });
        continue;
      }
      for (const raw of uoms) {
        const u = asObject(raw);
        rows.push({
          tenantId: p.tenantId,
          kode: p.kode,
          nama: p.nama,
          grup: p.grup,
          gudangKode: gudang,
          satuan: u.satuan,
          isBase: u.isBase === true,
          factorToBase: u.factorToBase ?? 1,
          barcode: u.barcode || '',
          hargaBeli: p.hargaBeli,
          hargaSpesial: u.hargaSpesial ?? p.hargaSpesial,
          hargaGrosir: u.hargaGrosir ?? p.hargaGrosir,
          hargaEcer: u.hargaEcer ?? p.hargaEcer,
          stokBase: u.isBase === true ? p.stok : '',
          minStok: u.isBase === true ? p.minStok : '',
          aktif: p.aktif,
        });
      }
    }
    return rows;
  };

  const fetchExportRows = async () => {
    const EXPORT_MAX = 2000;
    let base = `/api/products?q=${encodeURIComponent(debouncedQ)}&includeUom=1`;
    if (catalogGudangKode) base += `&gudangKode=${encodeURIComponent(catalogGudangKode)}`;
    if (itemRoleFilter) base += `&itemRole=${encodeURIComponent(itemRoleFilter)}`;
    base = withActingTenantQuery(base, filterTenantId, isMaster);
    const all = await fetchAllCursorPages<JsonObject>(base, {
      limit: 500,
      maxPages: Math.ceil(EXPORT_MAX / 500),
    });
    const filtered = all.filter((p) => gudangFilter[str(p.gudangKode, 'GKERING') as keyof typeof gudangFilter]);
    if (filtered.length === 0) throw new Error('Tidak ada data untuk diekspor');
    const capped = filtered.slice(0, EXPORT_MAX);
    return {
      rows: flattenProductsForExport(capped),
      truncated: filtered.length > EXPORT_MAX || all.length >= EXPORT_MAX,
    };
  };

  const exportData = async (format: ListExportFormat) => {
    try {
      const { rows, truncated } = await fetchExportRows();
      const stamp = new Date().toISOString().slice(0, 10);
      const tenantPart = filterTenantId ? `-${filterTenantId}` : '';
      await runListExport(format, {
        baseName: `produk${tenantPart}-${stamp}`,
        title: 'Master Produk',
        columns: getExportColumns(),
        rows,
      });
      toast.success(
        truncated
          ? `${rows.length} produk diekspor (maks 2000 — persempit filter untuk data lengkap)`
          : `${rows.length} produk diekspor`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const colSpan = (isMaster ? 12 : 11) - (canManageProducts ? 0 : 2);

  const toggleGudang = (kode: string, checked: boolean) => {
    setGudangFilter((prev) => {
      const next = { ...prev, [kode]: checked };
      if (!WAREHOUSES.some((w) => next[w.kode])) return prev;
      return next;
    });
  };

  const filteredProducts = useMemo(() => products.filter((p) => {
    if (!showInactive && p.aktif === false) return false;
    const g = str(p.gudangKode, 'GKERING');
    if (!gudangFilter[g]) return false;
    if (itemRoleFilter) {
      const role = normalizeItemRole(p.itemRole);
      if (role !== itemRoleFilter) return false;
    }
    return true;
  }), [products, gudangFilter, itemRoleFilter, showInactive]);
  const inactiveHiddenCount = useMemo(
    () => (showInactive ? 0 : products.filter((p) => p.aktif === false).length),
    [products, showInactive],
  );

  const showAllGudang = WAREHOUSES.every((w) => gudangFilter[w.kode]);
  const allSelected = filteredProducts.length > 0 && filteredProducts.every((p) => selection.isSelected(str(p.id)));
  const isVendorSynced = (p: JsonObject) => p?.syncSource === 'sales.app';
  const displayHargaBeli = (p: JsonObject) => {
    const beli = parseInt(str(p?.hargaBeli), 10);
    if (beli > 0) return { amount: beli, vendorRef: false };
    if (isVendorSynced(p)) {
      const tier = resolveVendorTier(p, vendorTierMap as Record<string, string>, defaultTier);
      const ref = vendorPriceFromProduct(p, tier);
      if (ref > 0) return { amount: ref, vendorRef: true, tier };
    }
    return { amount: beli, vendorRef: false };
  };
  const [syncing, setSyncing] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const { data: catalogJobData } = useCatalogSyncJob(activeJobId);
  const catalogJobStatus = catalogJobData && activeJobId ? String(catalogJobData.status || '') : null;

  const reportSyncResult = (data: JsonObject) => {
    const total = num(data.total);
    if (total === 0) {
      toast.error('Katalog kosong — cek SALES_VENDOR_TENANT_ID di .env.local (produk sales.app mungkin di tenant lain)');
      return;
    }
    toast.success(`Sync OK: ${num(data.created)} baru, ${num(data.updated)} diperbarui (${total} dari sales.app)`);
    const dupList = Array.isArray(data.duplicateBarcodes) ? data.duplicateBarcodes : [];
    if (dupList.length > 0) {
      toast.warning(`${dupList.length} produk punya barcode yang sama dengan produk aktif lain — cek badge "Barcode duplikat" di tabel`);
    }
    window.dispatchEvent(new CustomEvent('vendor-catalog-synced', { detail: data }));
    void load();
  };

  useOnceTerminalEffect(activeJobId, catalogJobData, catalogJobStatus, BG_JOB_TERMINAL_STATUSES, (status) => {
    if (isBgJobSuccess(status)) {
      reportSyncResult((catalogJobData?.result || {}) as JsonObject);
    } else {
      const errMsg = String(catalogJobData?.lastError || (catalogJobData?.result as JsonObject)?.error || 'Sync gagal');
      toast.error(errMsg);
    }
    setActiveJobId(null);
    setSyncing(false);
  });

  const syncFromVendor = async () => {
    setSyncing(true);
    try {
      const data = await syncVendorMutation.mutateAsync({
        url: '/api/sync/vendor-catalog',
        body: {},
        offlineLabel: 'Sync katalog dari sales.app',
      }) as JsonObject;
      if (data.jobId) {
        toast.info('Sync katalog berjalan di background…');
        setActiveJobId(String(data.jobId));
        return;
      }
      reportSyncResult(data);
      setSyncing(false);
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
      setSyncing(false);
    }
  };

  return (
    <>
    <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><Package className="w-6 h-6" /> Master Produk</h1>
            <p className="text-sm text-slate-500">
              {canManageProducts
                ? 'Nama, satuan & harga vendor (sesuai tier pelanggan) disinkron dari sales.app — stok & harga beli lokal dikelola di sini'
                : 'Lihat daftar produk — perubahan stok via penerimaan barang & release inventory'}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {canManageProducts && (
              <>
                <Button variant="outline" onClick={syncFromVendor} disabled={syncing}>
                  <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
                  {syncing ? 'Sync...' : 'Sync dari sales.app'}
                </Button>
                <Button variant="outline" onClick={openMetaDialog}>
                  <Settings2 className="w-4 h-4 mr-2" /> Grup &amp; Satuan
                </Button>
                <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600">
                  <Plus className="w-4 h-4 mr-2" /> Produk Baru
                </Button>
              </>
            )}
            <ListExportMenu onExport={exportData} disabled={loading} />
          </div>
        </div>

        {canManageProducts && (
          <BulkSelectionBar
            count={selection.count}
            entityLabel="produk"
            onDelete={bulkDelete}
            onClear={selection.clear}
            deleting={bulkDeleting}
          />
        )}

        <div className="flex gap-2 flex-wrap items-end">
          {isMaster && (
            <TenantScopeField
              user={user}
              tenants={tenants}
              value={filterTenantId}
              onChange={(tid) => {
                setFilterTenantId(tid);
              }}
              label="Filter tenant"
              className="w-full max-w-xs"
            />
          )}
          <div className="relative flex-1 max-w-md min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              placeholder="Cari kode, nama, atau barcode..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="min-w-[10rem]">
            <select
              className={PRODUCT_SELECT_CLASS}
              value={itemRoleFilter}
              onChange={(e) => setItemRoleFilter(e.target.value)}
              aria-label="Filter peran item"
            >
              <option value="">Semua peran item</option>
              {ITEM_ROLES_UI.map((role) => (
                <option key={role} value={role}>{ITEM_ROLE_LABELS[role]}</option>
              ))}
            </select>
          </div>
          <div className="text-sm text-slate-500 self-center pb-2">
            Total: <span className="font-semibold text-slate-800">{filteredProducts.length}</span> produk
            {!showAllGudang && products.length !== filteredProducts.length && (
              <span className="text-xs text-slate-400 ml-1">dari {products.length}</span>
            )}
            {isMaster && !filterTenantId && (
              <span className="text-xs text-slate-400 ml-1">(semua tenant)</span>
            )}
            {inactiveHiddenCount > 0 && (
              <span className="text-xs text-slate-400 ml-1">({inactiveHiddenCount} nonaktif disembunyikan)</span>
            )}
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer select-none self-center text-sm text-slate-600">
            <Checkbox
              id="produk-show-inactive"
              checked={showInactive}
              onCheckedChange={(v) => setShowInactive(v === true)}
            />
            <Label htmlFor="produk-show-inactive" className="text-sm font-medium cursor-pointer">
              Tampilkan nonaktif
            </Label>
          </label>
          <div className="ml-auto flex flex-wrap items-center gap-4 rounded-lg border bg-slate-50 px-3 py-2 self-center">
            {WAREHOUSES.map((w) => (
              <label
                key={w.kode}
                className="inline-flex items-center gap-2 cursor-pointer select-none"
              >
                <Checkbox
                  id={`produk-gudang-${w.kode}`}
                  checked={!!gudangFilter[w.kode]}
                  onCheckedChange={(v) => toggleGudang(w.kode, v === true)}
                  className={
                    w.kode === 'GBASAH'
                      ? 'border-blue-400 data-[state=checked]:bg-blue-600'
                      : w.kode === 'GJANITOR'
                        ? 'border-emerald-400 data-[state=checked]:bg-emerald-600'
                        : 'border-amber-500 data-[state=checked]:bg-amber-600'
                  }
                />
                <Label
                  htmlFor={`produk-gudang-${w.kode}`}
                  className={`text-sm font-medium cursor-pointer ${
                    w.kode === 'GBASAH'
                      ? 'text-blue-800'
                      : w.kode === 'GJANITOR'
                        ? 'text-emerald-800'
                        : 'text-amber-800'
                  }`}
                >
                  {w.nama}
                </Label>
              </label>
            ))}
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                <tr>
                  {canManageProducts && (
                    <th className="px-3 py-2 w-10">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => selection.toggleAll(filteredProducts as { id: string }[])}
                        disabled={filteredProducts.length === 0}
                        aria-label="Pilih semua"
                      />
                    </th>
                  )}
                  {isMaster && <th className="px-3 py-2 text-left">Tenant</th>}
                  <th className="px-3 py-2 text-left">Kode</th>
                  <th className="px-3 py-2 text-left">Barcode</th>
                  <th className="px-3 py-2 text-left">Nama</th>
                  <th className="px-3 py-2 text-left">Grup</th>
                  <th className="px-3 py-2 text-left">Peran</th>
                  <th className="px-3 py-2 text-left">Gudang</th>
                  <th className="px-3 py-2 text-center">Sat</th>
                  <th className="px-3 py-2 text-right">Harga Beli</th>
                  <th className="px-3 py-2 text-right">Stok</th>
                  {canManageProducts && <th className="px-3 py-2 text-center w-24">Aksi</th>}
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={colSpan} className="text-center py-10 text-slate-400">Memuat...</td></tr>
                )}
                {!loading && filteredProducts.length === 0 && (
                  <tr><td colSpan={colSpan} className="text-center py-10 text-slate-400">
                    {products.length === 0 ? 'Tidak ada produk' : 'Tidak ada produk di gudang yang dipilih'}
                  </td></tr>
                )}
                {filteredProducts.map((p) => (
                  <tr key={str(p.id)} className={`border-t hover:bg-slate-50 ${selection.isSelected(str(p.id)) ? 'bg-orange-50/50' : ''}`}>
                    {canManageProducts && (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selection.isSelected(str(p.id))}
                          onChange={() => selection.toggle(str(p.id))}
                          aria-label={`Pilih ${str(p.nama)}`}
                        />
                      </td>
                    )}
                    {isMaster && (
                      <td className="px-3 py-2 text-xs">
                        <span className="px-2 py-0.5 bg-orange-50 text-orange-800 rounded font-mono">
                          {tenantLabel(tenants, str(p.tenantId, 'default'))}
                        </span>
                      </td>
                    )}
                    <td className="px-3 py-2 font-mono text-xs">{str(p.kode)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{str(p.barcode)}</td>
                    <td className="px-3 py-2 font-medium">
                      {str(p.nama)}
                      {isVendorSynced(p) && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded align-middle">sales.app</span>
                      )}
                      {p.barcodeDuplicateWarning === true && (
                        <span
                          className="ml-1.5 inline-flex items-center rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-red-700 align-middle"
                          title="Barcode ini juga dipakai produk aktif lain — kemungkinan duplikat dari sales.app"
                        >
                          Barcode duplikat
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs"><span className="px-2 py-0.5 bg-slate-100 rounded">{str(p.grup)}</span></td>
                    <td className="px-3 py-2 text-xs">
                      <span className="px-2 py-0.5 bg-emerald-50 text-emerald-800 rounded">
                        {ITEM_ROLE_LABELS[normalizeItemRole(p.itemRole) as ItemRole]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`px-2 py-0.5 rounded font-medium ${
                        str(p.gudangKode, 'GKERING') === 'GBASAH'
                          ? 'bg-blue-50 text-blue-800'
                          : str(p.gudangKode, 'GKERING') === 'GJANITOR'
                            ? 'bg-emerald-50 text-emerald-800'
                            : 'bg-amber-50 text-amber-800'
                      }`}>
                        {warehouseName(str(p.gudangKode, 'GKERING'))}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      <span className="uppercase">{str(p.satuan)}</span>
                      {num(p.uomCount, 1) > 1 && (
                        <span
                          className="ml-1 inline-block text-[10px] px-1 py-0.5 bg-orange-100 text-orange-800 rounded font-medium"
                          title={`${num(p.uomCount)} satuan`}
                        >
                          +{num(p.uomCount, 1) - 1}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">
                      {(() => {
                        const { amount, vendorRef, tier } = displayHargaBeli(p);
                        return vendorRef ? (
                          <span title={`Harga vendor tier ${vendorTierLabel(tier)}`}>
                            {formatIDR(amount)}
                            <span className="ml-1 text-[10px] text-blue-600 font-normal">{vendorTierLabel(tier)}</span>
                          </span>
                        ) : formatIDR(amount);
                      })()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={`font-semibold ${num(p.stokGudangQty ?? p.stok) <= num(p.minStok) ? 'text-red-600' : ''}`}
                        title={productStockTitle({
                          stok: num(p.stok),
                          stokDisplay: str(p.stokDisplay) || undefined,
                          gudangKode: str(p.gudangKode, 'GKERING'),
                          stokByWarehouse: asObject(p.stokByWarehouse) as Record<string, number | string>,
                          stokGudangQty: num(p.stokGudangQty),
                        })}
                      >
                        {productStockLabel({
                          stok: num(p.stok),
                          stokDisplay: str(p.stokDisplay) || undefined,
                          satuan: str(p.satuan),
                          gudangKode: str(p.gudangKode, 'GKERING'),
                          stokByWarehouse: asObject(p.stokByWarehouse) as Record<string, number | string>,
                          stokGudangQty: num(p.stokGudangQty),
                        })}
                      </span>
                    </td>
                    {canManageProducts && (
                      <td className="px-3 py-2">
                        <div className="flex justify-center gap-1">
                          <button type="button" onClick={() => openEdit(p)} className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"><Pencil className="w-4 h-4" /></button>
                          {!isVendorSynced(p) && (
                            <button type="button" onClick={() => remove(str(p.id))} className="p-1.5 hover:bg-red-50 text-red-600 rounded"><Trash2 className="w-4 h-4" /></button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && (
            <div className="mx-3 mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex flex-wrap items-center justify-between gap-2">
              <span>{error}</span>
              <Button variant="outline" size="sm" onClick={() => void reload()}>Coba lagi</Button>
            </div>
          )}
          {!loading && hasMore && (
            <div className="p-3 border-t text-center">
              <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Memuat…' : `Muat lebih (${products.length} ditampilkan)`}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          {editing && isVendorSynced(editing) && (
            <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">
              Kode, nama, grup, dan satuan dikelola di sales.app. Di inventory: gudang, stok minimum, harga beli,
              serta faktor resep dapur (recipeBaseGrams / recipeBaseMl) yang bisa diubah.
            </p>
          )}
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Produk' : 'Produk Baru'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {isMaster && !editing && (
              <div className="col-span-2">
                <TenantScopeField
                  user={user}
                  tenants={tenants}
                  value={str(form.tenantId)}
                  onChange={(tid) => {
                    setForm({ ...form, tenantId: tid });
                  }}
                  required
                  label="Tenant pemilik produk"
                />
              </div>
            )}
            {isMaster && editing && (
              <div className="col-span-2">
                <Label>Tenant</Label>
                <Input
                  readOnly
                  disabled
                  value={tenantLabel(tenants, str(form.tenantId))}
                  className="bg-slate-50"
                />
              </div>
            )}

            <FormSectionTitle>Identitas Produk</FormSectionTitle>
            <div>
              <Label>Kode *</Label>
              <Input
                value={str(form.kode)}
                onChange={(e) => setForm({ ...form, kode: e.target.value })}
                disabled={!!editing || Boolean(editing && isVendorSynced(editing))}
                className="font-mono"
              />
            </div>
            <div>
              <Label>Grup *</Label>
              <select
                className={PRODUCT_SELECT_CLASS}
                value={str(form.grup)}
                onChange={(e) => {
                  const grup = e.target.value;
                  const inferred = classifyProduct({ grup, nama: str(form.nama) });
                  setForm({
                    ...form,
                    grup,
                    ...(form.classificationSource === 'manual'
                      ? {}
                      : { itemRole: inferred.itemRole, gudangKode: inferred.gudangKode, classificationSource: 'inferred' }),
                  });
                }}
                disabled={grupList.length === 0 || Boolean(editing && isVendorSynced(editing))}
              >
                <option value="">{grupList.length ? '— Pilih grup —' : '— Belum ada grup —'}</option>
                {grupOptions.map((g) => (
                  <option key={g.id} value={g.nama}>{g.nama}</option>
                ))}
                {!!form.grup && !grupList.some((g) => g.nama === form.grup) && (
                  <option value={str(form.grup)}>{str(form.grup)} (legacy)</option>
                )}
              </select>
            </div>
            <div>
              <Label>Peran Item (Food Production)</Label>
              <select
                className={PRODUCT_SELECT_CLASS}
                value={normalizeItemRole(form.itemRole)}
                onChange={(e) => setForm({ ...form, itemRole: e.target.value, classificationSource: 'manual' })}
              >
                {ITEM_ROLES_UI.map((role) => (
                  <option key={role} value={role}>{ITEM_ROLE_LABELS[role]}</option>
                ))}
                {normalizeItemRole(form.itemRole) === 'SEMI_FINISHED' && (
                  <option value="SEMI_FINISHED">{ITEM_ROLE_LABELS.SEMI_FINISHED}</option>
                )}
              </select>
              <p className="text-[11px] text-slate-500 mt-1">
                {form.classificationSource === 'manual'
                  ? 'Dikoreksi manual — sync Sales tidak menimpa peran/gudang.'
                  : 'Otomatis dari grup Sales. Boleh dikoreksi.'}
                {' '}
                <button
                  type="button"
                  className="text-orange-700 hover:underline"
                  onClick={() => {
                    const inferred = classifyProduct({ grup: str(form.grup), nama: str(form.nama) });
                    setForm({
                      ...form,
                      itemRole: inferred.itemRole,
                      gudangKode: inferred.gudangKode,
                      classificationSource: 'inferred',
                    });
                  }}
                >
                  Ikuti klasifikasi otomatis
                </button>
              </p>
            </div>
            <div className="col-span-2">
              <Label>Nama Produk *</Label>
              <Input
                value={str(form.nama)}
                onChange={(e) => {
                  const nama = e.target.value;
                  const nextGrup = (!editing && form.classificationSource !== 'manual' && isWeakProdukGrup(form.grup))
                    ? (suggestProdukGrup(nama) || form.grup)
                    : form.grup;
                  const inferred = classifyProduct({ grup: str(nextGrup), nama });
                  setForm({
                    ...form,
                    nama,
                    grup: nextGrup,
                    ...(form.classificationSource === 'manual'
                      ? {}
                      : { itemRole: inferred.itemRole, gudangKode: inferred.gudangKode, classificationSource: 'inferred' }),
                  });
                }}
                disabled={Boolean(editing && isVendorSynced(editing))}
              />
            </div>

            <FormSectionTitle>Harga Beli &amp; Stok</FormSectionTitle>
            <div>
              <Label>Harga Beli (per satuan dasar)</Label>
              <Input
                type="number"
                min={0}
                value={num(form.hargaBeli)}
                onChange={(e) => setForm({ ...form, hargaBeli: parseInt(e.target.value || '0', 10) })}
              />
              <p className="text-[11px] text-slate-400 mt-1">Isi dulu sebelum atur margin % harga jual per satuan.</p>
            </div>
            <div>
              <Label>Stok Minimum</Label>
              <Input
                type="number"
                min={0}
                value={num(form.minStok)}
                onChange={(e) => setForm({ ...form, minStok: parseFloat(e.target.value || '0') })}
              />
            </div>

            <ProductUomTable
              rows={formUoms(form)}
              onChange={(uoms) => setForm({ ...form, uoms })}
              satuanList={satuanList.map((s) => ({ id: str(s.id), nama: str(s.nama) }))}
              hargaBeli={num(form.hargaBeli)}
              readOnly={Boolean(editing && isVendorSynced(editing))}
            />

            <FormSectionTitle>Faktor Resep Dapur</FormSectionTitle>
            <div>
              <Label>Gram per satuan basis (recipeBaseGrams)</Label>
              <Input
                type="number"
                min={0}
                step="any"
                value={form.recipeBaseGrams === '' || form.recipeBaseGrams == null ? '' : num(form.recipeBaseGrams)}
                onChange={(e) => setForm({
                  ...form,
                  recipeBaseGrams: e.target.value === '' ? '' : parseFloat(e.target.value),
                })}
                placeholder="contoh: 25000 untuk 1 SAK = 25 kg"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Wajib bila basis SAK/BTL/IKAT dan resep memakai GR. 1 {str(form.satuan) || 'basis'} = N gram.
              </p>
            </div>
            <div>
              <Label>Ml per satuan basis (recipeBaseMl)</Label>
              <Input
                type="number"
                min={0}
                step="any"
                value={form.recipeBaseMl === '' || form.recipeBaseMl == null ? '' : num(form.recipeBaseMl)}
                onChange={(e) => setForm({
                  ...form,
                  recipeBaseMl: e.target.value === '' ? '' : parseFloat(e.target.value),
                })}
                placeholder="contoh: 1000 untuk 1 BTL = 1 L"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Untuk konversi ML dari resep ke basis kemasan. Tidak mengubah satuan stok/pengadaan.
              </p>
            </div>

            <FormSectionTitle>Gudang Penyimpanan</FormSectionTitle>
            <div className="col-span-2">
              <WarehousePicker
                value={str(form.gudangKode)}
                onChange={(kode) => setForm({ ...form, gudangKode: kode, classificationSource: 'manual' })}
              />
              <p className="text-[11px] text-slate-400 mt-2">Satu produk hanya disimpan di satu gudang. Koreksi manual dihormati saat sync dari Sales.</p>
            </div>

            <div>
              <Label>Stok</Label>
              {editing ? (
                <>
                  <div className="border rounded-md px-3 py-2 bg-slate-50 font-mono text-sm">{str(form.stok)}</div>
                  <p className="text-[11px] text-slate-500 mt-1">
                    Ubah stok lewat menu <strong>Stok → Penyesuaian</strong> (stock opname). GRN &amp; release juga memperbarui stok otomatis.
                  </p>
                </>
              ) : (
                <Input
                  type="number"
                  min={0}
                  value={num(form.stok)}
                  onChange={(e) => setForm({ ...form, stok: parseFloat(e.target.value || '0') })}
                />
              )}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
            <Button onClick={save} className="bg-orange-500 hover:bg-orange-600">Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showMeta} onOpenChange={setShowMeta}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Kelola Grup &amp; Satuan Produk</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500 -mt-2">
            Definisikan grup dan satuan di sini. Saat membuat produk baru, pilih dari dropdown — tidak perlu mengetik manual.
            {isMaster && metaTenantId && (
              <span className="block mt-1 font-mono text-xs text-orange-700">Tenant: {tenantLabel(tenants, metaTenantId)}</span>
            )}
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Grup Produk</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="Nama grup baru..."
                  value={newGrup}
                  onChange={(e) => setNewGrup(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addGrup()}
                />
                <Button type="button" onClick={addGrup} className="shrink-0">Tambah</Button>
              </div>
              <ul className="border rounded-md divide-y max-h-48 overflow-auto text-sm">
                {grupList.length === 0 && (
                  <li className="px-3 py-2 text-slate-400">Belum ada grup</li>
                )}
                {grupList.map((g) => (
                  <li key={str(g.id)} className="px-3 py-2 flex items-center justify-between">
                    <span>{str(g.nama)}</span>
                    <button type="button" onClick={() => removeGrup(str(g.id))} className="text-red-600 hover:bg-red-50 p-1 rounded">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-2">
              <Label>Satuan</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="PCS, KG, BOX..."
                  value={newSatuan}
                  onChange={(e) => setNewSatuan(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addSatuan()}
                />
                <Button type="button" onClick={addSatuan} className="shrink-0">Tambah</Button>
              </div>
              <ul className="border rounded-md divide-y max-h-48 overflow-auto text-sm">
                {satuanList.length === 0 && (
                  <li className="px-3 py-2 text-slate-400">Belum ada satuan</li>
                )}
                {satuanList.map((s) => (
                  <li key={str(s.id)} className="px-3 py-2 flex items-center justify-between">
                    <span className="font-mono">{str(s.nama)}</span>
                    <button type="button" onClick={() => removeSatuan(str(s.id))} className="text-red-600 hover:bg-red-50 p-1 rounded">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMeta(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
