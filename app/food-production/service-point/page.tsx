'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { MapPinned, Plus, Pencil, RefreshCw, Power, Trash2 } from 'lucide-react';
import {
  KATEGORI_PORSI_OPTIONS,
  SERVICE_POINT_JENIS_LABELS,
  formatServicePointDropsJam,
  sumPorsiByKategori,
  type ServicePointDrop,
  type ServicePointJenis,
  type ServicePointPorsiByKategori,
} from '@/lib/food-production/service-point';
import type { KategoriPorsi } from '@/lib/food-production/production-plan';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface KitchenOpt { id: string; nama: string }
interface DropFormRow {
  key: string;
  id: string;
  label: string;
  jamKirim: string;
  qtyHint: string;
}
interface SpRow {
  id: string;
  kode?: string;
  nama: string;
  jenis?: ServicePointJenis;
  kitchenId?: string;
  kitchenNama?: string;
  alamat?: string;
  kapasitasPorsi?: number;
  porsiByKategori?: ServicePointPorsiByKategori;
  jamKirim?: string;
  drops?: ServicePointDrop[];
  pic?: string;
  picNoTelp?: string;
  aktif: boolean;
}

type PorsiFormMap = Record<KategoriPorsi, string>;

function emptyPorsiForm(): PorsiFormMap {
  return Object.fromEntries(KATEGORI_PORSI_OPTIONS.map((o) => [o.value, ''])) as PorsiFormMap;
}

function porsiFormFromRow(map?: ServicePointPorsiByKategori): PorsiFormMap {
  const base = emptyPorsiForm();
  if (!map) return base;
  for (const opt of KATEGORI_PORSI_OPTIONS) {
    const n = Number(map[opt.value]);
    if (Number.isFinite(n) && n > 0) base[opt.value] = String(n);
  }
  return base;
}

function porsiFormToPayload(form: PorsiFormMap): ServicePointPorsiByKategori {
  const out: ServicePointPorsiByKategori = {};
  for (const opt of KATEGORI_PORSI_OPTIONS) {
    const n = Number(String(form[opt.value] || '').replace(',', '.'));
    if (Number.isFinite(n) && n > 0) out[opt.value] = Math.round(n);
  }
  return out;
}

function dropsFormFromRow(drops?: ServicePointDrop[]): DropFormRow[] {
  return (drops || []).map((d, i) => ({
    key: d.id || `drop-${i}`,
    id: d.id || '',
    label: d.label || '',
    jamKirim: d.jamKirim || '',
    qtyHint: d.qtyHint != null ? String(d.qtyHint) : '',
  }));
}

function dropsFormToPayload(rows: DropFormRow[]): ServicePointDrop[] {
  return rows
    .map((r, i) => {
      const jamKirim = r.jamKirim.trim();
      if (!jamKirim) return null;
      const qty = Number(r.qtyHint);
      const label = r.label.trim() || undefined;
      return {
        id: r.id.trim() || `drop-${jamKirim.replace(':', '') || i + 1}`,
        jamKirim,
        label,
        qtyHint: Number.isFinite(qty) && qty > 0 ? Math.round(qty) : undefined,
      } as ServicePointDrop;
    })
    .filter((x): x is ServicePointDrop => !!x);
}

const emptyForm = {
  kode: '',
  nama: '',
  jenis: 'SEKOLAH' as ServicePointJenis,
  kitchenId: '',
  alamat: '',
  jamKirim: '',
  drops: [] as DropFormRow[],
  porsiByKategori: emptyPorsiForm(),
  pic: '',
  picNoTelp: '',
};

const SERVICE_POINT_JENIS_OPTIONS: Array<{ value: ServicePointJenis; label: string }> = [
  { value: 'SEKOLAH', label: 'Sekolah' },
  { value: 'POSYANDU', label: 'Posyandu' },
  { value: 'LAINNYA', label: 'Lainya' },
];

function nextServicePointKode(rows: SpRow[]): string {
  let max = 0;
  for (const row of rows) {
    const match = /^Ti-(\d+)$/i.exec(String(row.kode || '').trim());
    if (!match) continue;
    max = Math.max(max, Number(match[1]) || 0);
  }
  return `Ti-${String(max + 1).padStart(2, '0')}`;
}

export default function ServicePointPage() {
  const confirm = useConfirm();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<SpRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SpRow | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sRes, kRes] = await Promise.all([
        fetch('/api/service-points', { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const sData = await sRes.json();
      const kData = await kRes.json();
      if (!sRes.ok) throw new Error(sData?.error || 'Gagal memuat');
      setRows(Array.isArray(sData) ? sData : []);
      setKitchens(Array.isArray(kData) ? kData : []);
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

  function openCreate() {
    setEditing(null);
    setForm({
      ...emptyForm,
      kode: nextServicePointKode(rows),
      porsiByKategori: emptyPorsiForm(),
      drops: [],
    });
    setOpen(true);
  }

  function openEdit(row: SpRow) {
    setEditing(row);
    setForm({
      kode: row.kode || '',
      nama: row.nama,
      jenis: row.jenis || 'SEKOLAH',
      kitchenId: row.kitchenId || '',
      alamat: row.alamat || '',
      jamKirim: row.jamKirim || '',
      drops: dropsFormFromRow(row.drops),
      porsiByKategori: porsiFormFromRow(row.porsiByKategori),
      pic: row.pic || '',
      picNoTelp: row.picNoTelp || '',
    });
    setOpen(true);
  }

  const penerimaManfaatTotal = useMemo(
    () => sumPorsiByKategori(porsiFormToPayload(form.porsiByKategori)),
    [form.porsiByKategori],
  );

  async function save() {
    setSaving(true);
    try {
      const url = editing ? `/api/service-points/${editing.id}` : '/api/service-points';
      const method = editing ? 'PUT' : 'POST';
      const porsiByKategori = porsiFormToPayload(form.porsiByKategori);
      const drops = dropsFormToPayload(form.drops);
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          kode: form.kode || undefined,
          nama: form.nama,
          jenis: form.jenis,
          kitchenId: form.kitchenId || undefined,
          alamat: form.alamat || undefined,
          jamKirim: form.jamKirim || undefined,
          drops,
          porsiByKategori,
          pic: form.pic || undefined,
          picNoTelp: form.picNoTelp || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Titik diperbarui' : 'Titik ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function toggleAktif(row: SpRow) {
    if (row.aktif) {
      const okConfirm = await confirm({
        title: 'Nonaktifkan titik layanan?',
        description: row.nama,
        confirmText: 'Nonaktifkan',
        variant: 'destructive',
      });
      if (!okConfirm) return;
      const res = await fetch(`/api/service-points/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error || 'Gagal');
        return;
      }
      toast.success('Titik dinonaktifkan');
    } else {
      const res = await fetch(`/api/service-points/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ aktif: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.error || 'Gagal');
        return;
      }
      toast.success('Titik diaktifkan kembali');
    }
    await load();
  }

  async function deleteRow(row: SpRow) {
    const okConfirm = await confirm({
      title: 'Hapus titik layanan?',
      description: `${row.kode || ''} ${row.nama} — data akan dihapus permanen.`,
      confirmText: 'Hapus',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    const res = await fetch(`/api/service-points/${row.id}?permanent=1`, {
      method: 'DELETE',
      headers: { ...actingTenantHeaders() },
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data?.error || 'Gagal menghapus');
      return;
    }
    toast.success('Titik dihapus');
    await load();
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <MapPinned className="h-5 w-5" />
            Titik Layanan
          </h1>
          <p className="text-sm text-muted-foreground">
            Master sekolah / tray / titik makan penerima distribusi MBG
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> Tambah
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Kode</th>
              <th className="text-left p-3">Nama</th>
              <th className="text-left p-3">Jenis</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Jam Makan</th>
              <th className="text-left p-3">Drop</th>
              <th className="text-right p-3">Penerima Manfaat</th>
              <th className="text-left p-3">PIC</th>
              <th className="text-left p-3">No Telp</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={11} className="p-6 text-center text-muted-foreground">Belum ada titik layanan</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs">{row.kode || '—'}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3">{SERVICE_POINT_JENIS_LABELS[row.jenis || 'LAINNYA'] || 'Lainya'}</td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3 font-mono text-xs tabular-nums">{row.jamKirim || '—'}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {formatServicePointDropsJam(row.drops)}
                </td>
                <td className="p-3 text-right">{row.kapasitasPorsi ?? '—'}</td>
                <td className="p-3">{row.pic || '—'}</td>
                <td className="p-3 font-mono text-xs">{row.picNoTelp || '—'}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right space-x-1">
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="Ubah">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void toggleAktif(row)} title={row.aktif ? 'Nonaktifkan' : 'Aktifkan'}>
                        <Power className={`h-4 w-4 ${row.aktif ? 'text-destructive' : 'text-emerald-600'}`} />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void deleteRow(row)} title="Hapus">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Titik' : 'Tambah Titik'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Kode</Label>
                <Input
                  value={form.kode}
                  readOnly
                  placeholder="Ti-01"
                  className="bg-muted/40"
                />
              </div>
              <div className="space-y-1">
                <Label>Jenis</Label>
                <select
                  className="w-full h-10 border rounded-md px-2 text-sm"
                  value={form.jenis}
                  onChange={(e) => setForm((f) => ({ ...f, jenis: e.target.value as ServicePointJenis }))}
                >
                  {SERVICE_POINT_JENIS_OPTIONS.map((j) => (
                    <option key={j.value} value={j.value}>{j.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Nama</Label>
              <Input value={form.nama} onChange={(e) => setForm((f) => ({ ...f, nama: e.target.value }))} placeholder="SDN 01" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Dapur penyalur</Label>
                <select
                  className="w-full h-10 border rounded-md px-2 text-sm"
                  value={form.kitchenId}
                  onChange={(e) => setForm((f) => ({ ...f, kitchenId: e.target.value }))}
                >
                  <option value="">—</option>
                  {kitchens.map((k) => <option key={k.id} value={k.id}>{k.nama}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Jam Makan</Label>
                <Input
                  type="time"
                  value={form.jamKirim}
                  onChange={(e) => setForm((f) => ({ ...f, jamKirim: e.target.value }))}
                />
                <p className="text-[10px] text-muted-foreground">Fallback urutan rute bila belum ada jam drop</p>
              </div>
            </div>
            <div className="space-y-2 rounded-md border p-3 bg-muted/20">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-medium">Jam pengiriman / drop (opsional)</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setForm((f) => ({
                    ...f,
                    drops: [
                      ...f.drops,
                      {
                        key: `new-${Date.now()}`,
                        id: '',
                        label: '',
                        jamKirim: '',
                        qtyHint: '',
                      },
                    ],
                  }))}
                >
                  <Plus className="h-3.5 w-3.5 mr-1" /> Tambah jam
                </Button>
              </div>
              {form.drops.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Dipakai untuk urutan rute. Contoh: 08:50, 09:00
                </p>
              )}
              <div className="space-y-2">
                {form.drops.map((drop) => (
                  <div key={drop.key} className="grid grid-cols-[6.5rem_1fr_5rem_auto] gap-2 items-end">
                    <div className="space-y-1">
                      <Label className="text-xs font-normal">Jam</Label>
                      <Input
                        type="time"
                        value={drop.jamKirim}
                        onChange={(e) => setForm((f) => ({
                          ...f,
                          drops: f.drops.map((d) => (
                            d.key === drop.key ? { ...d, jamKirim: e.target.value } : d
                          )),
                        }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-normal">Keterangan</Label>
                      <Input
                        value={drop.label}
                        placeholder="opsional"
                        onChange={(e) => setForm((f) => ({
                          ...f,
                          drops: f.drops.map((d) => (
                            d.key === drop.key ? { ...d, label: e.target.value } : d
                          )),
                        }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs font-normal">Qty</Label>
                      <Input
                        type="number"
                        min={0}
                        value={drop.qtyHint}
                        placeholder="0"
                        onChange={(e) => setForm((f) => ({
                          ...f,
                          drops: f.drops.map((d) => (
                            d.key === drop.key ? { ...d, qtyHint: e.target.value } : d
                          )),
                        }))}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setForm((f) => ({
                        ...f,
                        drops: f.drops.filter((d) => d.key !== drop.key),
                      }))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2 rounded-md border p-3 bg-muted/20">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-medium">Kategori porsi</Label>
                <div className="text-xs text-muted-foreground">
                  Penerima Manfaat:{' '}
                  <span className="font-semibold text-foreground tabular-nums">
                    {penerimaManfaatTotal.toLocaleString('id-ID')}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {KATEGORI_PORSI_OPTIONS.map((opt) => (
                  <div key={opt.value} className="space-y-1">
                    <Label className="text-xs font-normal">
                      {opt.label}
                      {opt.hint ? (
                        <span className="text-muted-foreground"> — {opt.hint}</span>
                      ) : null}
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      inputMode="numeric"
                      placeholder="0"
                      value={form.porsiByKategori[opt.value]}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        porsiByKategori: {
                          ...f.porsiByKategori,
                          [opt.value]: e.target.value,
                        },
                      }))}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Total kategori otomatis menjadi Penerima Manfaat.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Alamat</Label>
              <Input value={form.alamat} onChange={(e) => setForm((f) => ({ ...f, alamat: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>PIC</Label>
                <Input value={form.pic} onChange={(e) => setForm((f) => ({ ...f, pic: e.target.value }))} placeholder="Nama penanggung jawab" />
              </div>
              <div className="space-y-1">
                <Label>No Telp</Label>
                <Input
                  value={form.picNoTelp}
                  onChange={(e) => setForm((f) => ({ ...f, picNoTelp: e.target.value }))}
                  placeholder="08xxxxxxxxxx"
                  inputMode="tel"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void save()} disabled={saving || !form.nama.trim()}>
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
