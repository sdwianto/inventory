'use client';
import { str, type JsonObject } from '@/types/json';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { LayoutGrid, Pencil, Plus } from 'lucide-react';
import { useSessionUserWithTenantFilter } from '@/lib/hooks/use-session-user';
import TenantScopeField, { tenantLabel, type TenantOption } from '@/components/TenantScopeField';
import { withActingTenantQuery } from '@/lib/tenant-api';
import { useApiQuery } from '@/lib/hooks/useApiQuery';
import { useApiMutation } from '@/lib/hooks/use-api-mutation';
import { useMasterTenants } from '@/lib/hooks/use-master-tenants';
import { queryKeys } from '@/lib/query-keys';
import { OfflineQueuedError } from '@/lib/offline-mutation-queue';

/** Client-safe warehouse options (mirror `WAREHOUSE_CODES` — avoid importing mongodb helpers). */
const WH_OPTIONS = [
  { kode: 'GKERING', label: 'Gudang Kering' },
  { kode: 'GBASAH', label: 'Gudang Basah' },
  { kode: 'GJANITOR', label: 'Gudang Janitor' },
] as const;

const empty = {
  kode: '',
  warehouseKode: 'GKERING',
  nama: '',
  isDefault: false,
  aktif: true,
  tenantId: '',
};

export default function WarehouseBinsPage() {
  const { user, filterTenantId, setFilterTenantId } = useSessionUserWithTenantFilter();
  const [whFilter, setWhFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<JsonObject | null>(null);
  const [form, setForm] = useState(empty);

  const isMaster = user?.role === 'MASTER';
  const { tenants: masterTenants } = useMasterTenants(isMaster);
  const tenants = masterTenants as TenantOption[];

  const binsUrl = useMemo(() => {
    if (!user) return null;
    if (isMaster && !filterTenantId) return null;
    let url = '/api/warehouse-bins';
    const qs = new URLSearchParams();
    if (whFilter) qs.set('warehouseKode', whFilter);
    const q = qs.toString();
    if (q) url += `?${q}`;
    return withActingTenantQuery(url, filterTenantId, isMaster);
  }, [user, filterTenantId, isMaster, whFilter]);

  const { data: listData = [], refetch, isLoading } = useApiQuery<JsonObject[]>(
    queryKeys.warehouseBins.list({
      tenantId: filterTenantId || undefined,
      warehouseKode: whFilter || undefined,
    }),
    binsUrl,
    { enabled: Boolean(binsUrl) },
  );
  const list = useMemo(() => (Array.isArray(listData) ? listData : []), [listData]);

  const saveMutation = useApiMutation([queryKeys.warehouseBins.all]);

  const openCreate = () => {
    setEditing(null);
    setForm({
      ...empty,
      warehouseKode: whFilter || 'GKERING',
      tenantId: filterTenantId || '',
    });
    setShowForm(true);
  };

  const openEdit = (row: JsonObject) => {
    setEditing(row);
    setForm({
      kode: str(row.kode),
      warehouseKode: str(row.warehouseKode) || 'GKERING',
      nama: str(row.nama),
      isDefault: !!row.isDefault,
      aktif: row.aktif !== false,
      tenantId: str(row.tenantId),
    });
    setShowForm(true);
  };

  const save = async () => {
    try {
      const body: Record<string, unknown> = {
        kode: form.kode,
        warehouseKode: form.warehouseKode,
        nama: form.nama,
        isDefault: form.isDefault,
        aktif: form.aktif,
      };
      if (isMaster && filterTenantId) body.tenantId = filterTenantId;

      if (editing) {
        await saveMutation.mutateAsync({
          url: `/api/warehouse-bins/${str(editing.id)}`,
          method: 'PUT',
          body,
          offlineLabel: `Ubah bin ${form.kode}`,
        });
        toast.success('Bin diperbarui');
      } else {
        await saveMutation.mutateAsync({
          url: '/api/warehouse-bins',
          method: 'POST',
          body,
          offlineLabel: `Buat bin ${form.kode}`,
        });
        toast.success('Bin dibuat');
      }
      setShowForm(false);
      void refetch();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const deactivate = async (row: JsonObject) => {
    try {
      await saveMutation.mutateAsync({
        url: `/api/warehouse-bins/${str(row.id)}`,
        method: 'DELETE',
        offlineLabel: `Nonaktifkan bin ${str(row.kode)}`,
      });
      toast.success('Bin dinonaktifkan');
      void refetch();
    } catch (e) {
      if (e instanceof OfflineQueuedError) toast.message(e.message);
      else toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <LayoutGrid className="w-6 h-6" /> Bin / Slot Gudang
            </h1>
            <p className="text-sm text-slate-500">
              Master alamat bin per gudang (W2-16). Saldo stok tetap level gudang;
              bin default distempel ke lot/kartu saat GRN POST.
            </p>
          </div>
          <Button onClick={openCreate} className="bg-orange-500 hover:bg-orange-600">
            <Plus className="w-4 h-4 mr-1" /> Bin Baru
          </Button>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          {isMaster && (
            <TenantScopeField
              user={user}
              tenants={tenants}
              value={filterTenantId}
              onChange={setFilterTenantId}
              label="Filter tenant"
              className="max-w-xs"
            />
          )}
          <div className="max-w-xs">
            <Label>Gudang</Label>
            <select
              className="w-full border rounded-md h-9 px-2 text-sm"
              value={whFilter}
              onChange={(e) => setWhFilter(e.target.value)}
            >
              <option value="">Semua</option>
              {WH_OPTIONS.map((w) => (
                <option key={w.kode} value={w.kode}>{w.label} ({w.kode})</option>
              ))}
            </select>
          </div>
        </div>

        <div className="bg-white border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-600">
              <tr>
                {isMaster && <th className="px-3 py-2 text-left">Tenant</th>}
                <th className="px-3 py-2 text-left">Gudang</th>
                <th className="px-3 py-2 text-left">Kode</th>
                <th className="px-3 py-2 text-left">Nama</th>
                <th className="px-3 py-2 text-center">Default</th>
                <th className="px-3 py-2 text-center">Aktif</th>
                <th className="px-3 py-2 text-center w-28">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isMaster && !filterTenantId && (
                <tr>
                  <td colSpan={7} className="text-center py-10 text-slate-400">
                    Pilih tenant untuk melihat bin
                  </td>
                </tr>
              )}
              {(isMaster ? filterTenantId : true) && isLoading && (
                <tr>
                  <td colSpan={isMaster ? 7 : 6} className="text-center py-10 text-slate-400">
                    Memuat bin…
                  </td>
                </tr>
              )}
              {(isMaster ? filterTenantId : true) && !isLoading && list.length === 0 && (
                <tr>
                  <td colSpan={isMaster ? 7 : 6} className="text-center py-10 text-slate-400">
                    Belum ada bin — buat bin receiving default untuk mulai stempel GRN
                  </td>
                </tr>
              )}
              {list.map((row) => (
                <tr key={str(row.id)} className="border-t hover:bg-slate-50">
                  {isMaster && (
                    <td className="px-3 py-2 text-xs">
                      <span className="px-2 py-0.5 bg-orange-50 text-orange-800 rounded font-mono">
                        {tenantLabel(tenants, str(row.tenantId))}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono text-xs">{str(row.warehouseKode)}</td>
                  <td className="px-3 py-2 font-mono text-xs font-medium">{str(row.kode)}</td>
                  <td className="px-3 py-2">{str(row.nama) || '-'}</td>
                  <td className="px-3 py-2 text-center">{row.isDefault ? 'Ya' : '—'}</td>
                  <td className="px-3 py-2 text-center">{row.aktif === false ? 'Tidak' : 'Ya'}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-center gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(row)}
                        className="p-1.5 hover:bg-blue-50 text-blue-600 rounded"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      {row.aktif !== false && (
                        <button
                          type="button"
                          onClick={() => void deactivate(row)}
                          className="px-2 text-xs text-slate-500 hover:text-red-600"
                          title="Nonaktifkan"
                        >
                          Off
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Bin' : 'Bin Baru'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Gudang</Label>
              <select
                className="w-full border rounded-md h-9 px-2 text-sm"
                value={form.warehouseKode}
                onChange={(e) => setForm({ ...form, warehouseKode: e.target.value })}
                disabled={!!editing}
              >
                {WH_OPTIONS.map((w) => (
                  <option key={w.kode} value={w.kode}>{w.label} ({w.kode})</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Kode</Label>
              <Input
                value={form.kode}
                onChange={(e) => setForm({ ...form, kode: e.target.value })}
                placeholder="RCV / A-01-01"
                disabled={!!editing}
              />
            </div>
            <div>
              <Label>Nama</Label>
              <Input
                value={form.nama}
                onChange={(e) => setForm({ ...form, nama: e.target.value })}
                placeholder="Receiving / Rak A"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
              />
              Default receiving (stempel GRN)
            </label>
            {editing && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.aktif}
                  onChange={(e) => setForm({ ...form, aktif: e.target.checked })}
                />
                Aktif
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
            <Button onClick={() => void save()} className="bg-orange-500 hover:bg-orange-600">
              Simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
