'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import RecipeSearchSelect from '@/components/RecipeSearchSelect';
import {
  BAHAN_PANGAN_OPTIONS,
  bahanPanganLabel,
  type BahanPangan,
} from '@/lib/food-production/menu';
import Link from 'next/link';
import { UtensilsCrossed, Plus, Pencil, RefreshCw, Trash2, CalendarDays } from 'lucide-react';

interface RecipeOpt {
  id: string;
  kode: string;
  nama: string;
  aktif?: boolean;
}

interface MenuItemForm {
  bahanPangan: '' | BahanPangan;
  recipeId: string;
  porsi: string;
}

interface MenuRow {
  id: string;
  kode: string;
  nama: string;
  effectiveDate: string;
  targetCostPerPorsi?: number;
  catatan?: string;
  gambarUrl?: string;
  items: Array<{
    recipeId: string;
    porsi: number;
    bahanPangan?: BahanPangan;
    recipeKode?: string;
    recipeNama?: string;
  }>;
  aktif: boolean;
}

const emptyItem = (): MenuItemForm => ({ bahanPangan: '', recipeId: '', porsi: '1' });

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeNama(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function formItemKey(recipeId: string, bahanPangan: string): string {
  return `${recipeId}::${bahanPangan}`;
}

/** Same recipeId + bahanPangan → one row; porsi summed. Keeps at most one empty row. */
function consolidateFormItems(rows: MenuItemForm[]): MenuItemForm[] {
  const byKey = new Map<string, MenuItemForm>();
  let hasEmpty = false;
  for (const row of rows) {
    const id = String(row.recipeId || '').trim();
    const bp = row.bahanPangan;
    if (!id || !bp) {
      hasEmpty = true;
      continue;
    }
    const key = formItemKey(id, bp);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row, recipeId: id, bahanPangan: bp });
      continue;
    }
    existing.porsi = String((Number(existing.porsi) || 0) + (Number(row.porsi) || 0));
  }
  const merged = [...byKey.values()];
  if (hasEmpty || merged.length === 0) merged.push(emptyItem());
  return merged;
}

function menuBahanPanganSummary(
  items: MenuRow['items'] | undefined,
): string {
  if (!items?.length) return '—';
  const labels = [
    ...new Set(
      items
        .map((i) => bahanPanganLabel(i.bahanPangan))
        .filter((l) => l && l !== '—'),
    ),
  ];
  return labels.length ? labels.join(', ') : '—';
}

export default function FoodProductionMenuPage() {
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [recipes, setRecipes] = useState<RecipeOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MenuRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [nextKode, setNextKode] = useState('MNU-0001');
  const [namaSuggestOpen, setNamaSuggestOpen] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<{ kode: string; nama: string } | null>(null);
  const namaWrapRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    kode: '',
    nama: '',
    effectiveDate: today(),
    targetCostPerPorsi: '',
    catatan: '',
    aktif: true,
  });
  const [items, setItems] = useState<MenuItemForm[]>([emptyItem()]);
  const [gambarPhotos, setGambarPhotos] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, rRes, kRes] = await Promise.all([
        fetch('/api/menus', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/recipes', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/menus?nextKode=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const mData = await mRes.json();
      const rData = await rRes.json();
      const kData = await kRes.json();
      if (!mRes.ok) throw new Error(mData?.error || 'Gagal memuat menu');
      setRows(Array.isArray(mData) ? mData : []);
      setRecipes(Array.isArray(rData) ? rData : []);
      if (kRes.ok && kData?.kode) setNextKode(String(kData.kode));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat menu');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!namaWrapRef.current?.contains(e.target as Node)) {
        setNamaSuggestOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const namaSuggestions = useMemo(() => {
    if (editing) return [];
    const q = normalizeNama(form.nama).toLowerCase();
    if (q.length < 1) return [];
    return rows
      .filter((r) => r.aktif !== false)
      .filter((r) => {
        const n = normalizeNama(r.nama).toLowerCase();
        const k = String(r.kode || '').toLowerCase();
        return n.includes(q) || k.includes(q);
      })
      .slice(0, 8);
  }, [editing, form.nama, rows]);

  const exactNamaMatch = useMemo(() => {
    const n = normalizeNama(form.nama).toLowerCase();
    if (!n) return null;
    return rows.find((r) => {
      if (editing && r.id === editing.id) return false;
      return r.aktif !== false && normalizeNama(r.nama).toLowerCase() === n;
    }) || null;
  }, [editing, form.nama, rows]);

  async function openCreate() {
    setEditing(null);
    setLoadedFrom(null);
    setNamaSuggestOpen(false);
    setForm({
      kode: nextKode,
      nama: '',
      effectiveDate: today(),
      targetCostPerPorsi: '',
      catatan: '',
      aktif: true,
    });
    setItems([emptyItem()]);
    setGambarPhotos([]);
    setOpen(true);
    try {
      const kRes = await fetch('/api/menus?nextKode=1', { headers: { ...actingTenantHeaders() } });
      const kData = await kRes.json();
      if (kRes.ok && kData?.kode) {
        const kode = String(kData.kode);
        setNextKode(kode);
        setForm((f) => ({ ...f, kode }));
      }
    } catch {
      // keep cached nextKode
    }
  }

  function openEdit(row: MenuRow) {
    setEditing(row);
    setLoadedFrom(null);
    setNamaSuggestOpen(false);
    setForm({
      kode: row.kode,
      nama: row.nama,
      effectiveDate: row.effectiveDate || today(),
      targetCostPerPorsi: row.targetCostPerPorsi != null ? String(row.targetCostPerPorsi) : '',
      catatan: row.catatan || '',
      aktif: row.aktif !== false,
    });
    setItems(
      (row.items || []).length
        ? row.items.map((i) => ({
          bahanPangan: i.bahanPangan || '',
          recipeId: i.recipeId,
          porsi: String(i.porsi),
        }))
        : [emptyItem()],
    );
    setGambarPhotos(row.gambarUrl ? [row.gambarUrl] : []);
    setOpen(true);
  }

  function applyFromExisting(row: MenuRow) {
    setForm((f) => ({
      ...f,
      nama: row.nama,
      effectiveDate: row.effectiveDate || today(),
      targetCostPerPorsi: row.targetCostPerPorsi != null ? String(row.targetCostPerPorsi) : '',
      catatan: row.catatan || '',
      aktif: true,
    }));
    setItems(
      (row.items || []).length
        ? row.items.map((i) => ({
          bahanPangan: i.bahanPangan || '',
          recipeId: i.recipeId,
          porsi: String(i.porsi),
        }))
        : [emptyItem()],
    );
    setGambarPhotos(row.gambarUrl ? [row.gambarUrl] : []);
    setLoadedFrom({ kode: row.kode, nama: row.nama });
    setNamaSuggestOpen(false);
    toast.message(`Detail dimuat dari ${row.kode} — ubah nama untuk simpan sebagai menu baru`);
  }

  async function save() {
    setSaving(true);
    try {
      const nama = normalizeNama(form.nama);
      if (!nama) throw new Error('Nama menu wajib diisi');
      if (!editing && exactNamaMatch) {
        throw new Error(
          `Menu "${exactNamaMatch.nama}" sudah ada (${exactNamaMatch.kode}). Ubah nama, atau batalkan jika sama.`,
        );
      }
      const filled = consolidateFormItems(items).filter((i) => i.recipeId || i.bahanPangan);
      if (!filled.length) throw new Error('Minimal 1 baris isi menu');
      for (let i = 0; i < filled.length; i++) {
        if (!filled[i].bahanPangan) {
          throw new Error(`Baris ${i + 1}: bahan pangan wajib dipilih`);
        }
        if (!filled[i].recipeId) {
          throw new Error(`Baris ${i + 1}: resep wajib dipilih`);
        }
      }
      const payload = {
        nama,
        effectiveDate: form.effectiveDate,
        targetCostPerPorsi: form.targetCostPerPorsi === '' ? null : Number(form.targetCostPerPorsi),
        catatan: form.catatan.trim() || undefined,
        aktif: form.aktif,
        gambarBase64: gambarPhotos[0] || null,
        items: filled.map((i) => ({
          bahanPangan: i.bahanPangan,
          recipeId: i.recipeId,
          porsi: Number(i.porsi) || 1,
        })),
      };
      const url = editing ? `/api/menus/${editing.id}` : '/api/menus';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Menu diperbarui' : 'Menu ditambahkan');
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function removeMenu(row: MenuRow) {
    const hard = !row.aktif;
    const okConfirm = window.confirm(
      hard
        ? `Hapus permanen menu ${row.kode} — ${row.nama}?`
        : `Nonaktifkan menu ${row.kode} — ${row.nama}?`,
    );
    if (!okConfirm) return;
    try {
      const qs = hard ? '?hard=1' : '';
      const res = await fetch(`/api/menus/${row.id}${qs}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menghapus');
      toast.success(hard ? 'Menu dihapus' : 'Menu dinonaktifkan');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menghapus');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <UtensilsCrossed className="h-5 w-5" />
            Menu
          </h1>
          <p className="text-sm text-muted-foreground">
            Master menu untuk Rencana Produksi — identitas + isi per kelompok bahan pangan (resep).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/food-production/plan">
              <CalendarDays className="h-4 w-4 mr-1" />
              Rencana Produksi
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Muat ulang
          </Button>
          <Button size="sm" onClick={() => void openCreate()}>
            <Plus className="h-4 w-4 mr-1" />
            Tambah Menu
          </Button>
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3 font-medium w-14">Gambar</th>
              <th className="text-left p-3 font-medium">Kode</th>
              <th className="text-left p-3 font-medium">Nama Menu</th>
              <th className="text-left p-3 font-medium">Bahan pangan</th>
              <th className="text-left p-3 font-medium">Baris</th>
              <th className="text-left p-3 font-medium">Target biaya</th>
              <th className="text-left p-3 font-medium">Efektif</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-muted-foreground">Memuat…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="p-6 text-center text-muted-foreground">
                  Belum ada menu. Buat resep dulu, lalu susun menu.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-2">
                  {row.gambarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={row.gambarUrl}
                      alt={row.nama}
                      className="h-10 w-10 rounded object-cover border bg-muted"
                    />
                  ) : (
                    <div className="h-10 w-10 rounded border bg-muted/40" />
                  )}
                </td>
                <td className="p-3 font-mono text-xs">{row.kode}</td>
                <td className="p-3 font-medium">{row.nama}</td>
                <td className="p-3 text-xs">{menuBahanPanganSummary(row.items)}</td>
                <td className="p-3">{(row.items || []).length} baris</td>
                <td className="p-3">
                  {row.targetCostPerPorsi != null
                    ? `Rp ${Number(row.targetCostPerPorsi).toLocaleString('id-ID')}`
                    : '—'}
                </td>
                <td className="p-3 whitespace-nowrap">{row.effectiveDate || '—'}</td>
                <td className="p-3">{row.aktif ? 'Aktif' : 'Nonaktif'}</td>
                <td className="p-3 text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="Ubah">
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeMenu(row)}
                    title={row.aktif ? 'Nonaktifkan' : 'Hapus permanen'}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl w-[min(96vw,64rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Menu' : 'Tambah Menu'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Kode</Label>
              <Input
                value={form.kode}
                readOnly
                disabled
                className="font-mono bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                {editing ? 'Kode tidak dapat diubah' : 'Nomor item otomatis (MNU-0001, …)'}
              </p>
            </div>
            <div className="space-y-1">
              <Label>Target biaya / porsi</Label>
              <Input
                type="number"
                min={0}
                value={form.targetCostPerPorsi}
                onChange={(e) => setForm((f) => ({ ...f, targetCostPerPorsi: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
            <div className="space-y-1 sm:col-span-2" ref={namaWrapRef}>
              <Label>Nama Menu *</Label>
              <Input
                value={form.nama}
                autoComplete="off"
                placeholder="Ketik nama menu…"
                onChange={(e) => {
                  setForm((f) => ({ ...f, nama: e.target.value }));
                  setNamaSuggestOpen(true);
                  if (loadedFrom) setLoadedFrom(null);
                }}
                onFocus={() => {
                  if (!editing) setNamaSuggestOpen(true);
                }}
              />
              {!editing && namaSuggestOpen && namaSuggestions.length > 0 && (
                <ul className="mt-1 max-h-44 overflow-y-auto rounded-md border bg-white shadow-sm text-sm z-10 relative">
                  {namaSuggestions.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-muted/80"
                        onClick={() => applyFromExisting(r)}
                      >
                        <span className="font-medium">{r.nama}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{r.kode}</span>
                        <span className="block text-xs text-muted-foreground">
                          {(r.items || []).length} resep — klik untuk muat detail
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">
                Identitas menu. Ketik untuk cari &amp; muat dari menu lama; simpan wajib nama berbeda.
              </p>
              {loadedFrom && (
                <p className="text-xs text-amber-700">
                  Detail dimuat dari {loadedFrom.kode} ({loadedFrom.nama}). Ubah nama sebelum simpan
                  sebagai menu baru; jika sama persis, batalkan saja.
                </p>
              )}
              {!editing && exactNamaMatch && (
                <p className="text-xs text-destructive">
                  Nama sudah dipakai {exactNamaMatch.kode}. Ubah nama atau batalkan.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Tanggal efektif</Label>
              <Input
                type="date"
                value={form.effectiveDate}
                onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label>Catatan</Label>
              <Input
                value={form.catatan}
                onChange={(e) => setForm((f) => ({ ...f, catatan: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
            <div className="sm:col-span-2">
              <PhotoUploadField
                label="Gambar"
                hint="Opsional. Maks. 1 foto, otomatis dikompres sebelum disimpan."
                photos={gambarPhotos}
                onChange={setGambarPhotos}
                maxPhotos={1}
              />
            </div>
            {editing && (
              <label className="sm:col-span-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.aktif}
                  onChange={(e) => setForm((f) => ({ ...f, aktif: e.target.checked }))}
                />
                Aktif
              </label>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label>Isi menu</Label>
                <p className="text-xs text-muted-foreground">
                  Tiap baris: kelompok bahan pangan, lalu resep (detail bahan).
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setItems((prev) => [...prev, emptyItem()])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Baris
              </Button>
            </div>
            <div className="rounded-md border overflow-hidden">
              <div className="hidden sm:grid sm:grid-cols-12 gap-2 px-2 py-1.5 bg-muted/50 text-xs font-medium text-muted-foreground">
                <div className="sm:col-span-3">Bahan pangan</div>
                <div className="sm:col-span-6">Resep / detail bahan</div>
                <div className="sm:col-span-2">Porsi</div>
                <div className="sm:col-span-1" />
              </div>
              <div className="divide-y">
                {items.map((item, idx) => (
                  <div key={idx} className="grid gap-2 sm:grid-cols-12 items-center px-2 py-1.5">
                    <div className="sm:col-span-3">
                      <span className="sm:hidden text-[11px] text-muted-foreground">Bahan pangan</span>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                        value={item.bahanPangan}
                        aria-label={`Bahan pangan baris ${idx + 1}`}
                        onChange={(e) => {
                          const bp = e.target.value as '' | BahanPangan;
                          setItems((prev) => {
                            const next = prev.map((it, i) => (
                              i === idx ? { ...it, bahanPangan: bp } : it
                            ));
                            if (!bp || !next[idx]?.recipeId) return next;
                            return consolidateFormItems(next);
                          });
                        }}
                      >
                        <option value="">Pilih…</option>
                        {BAHAN_PANGAN_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sm:col-span-6">
                      <span className="sm:hidden text-[11px] text-muted-foreground">Resep</span>
                      <RecipeSearchSelect
                        value={item.recipeId}
                        recipes={recipes}
                        placeholder="Ketik kode / nama resep…"
                        onChange={(id) => {
                          if (!id) {
                            setItems((prev) => prev.map((it, i) => (
                              i === idx ? { ...it, recipeId: '' } : it
                            )));
                            return;
                          }
                          setItems((prev) => {
                            const bp = prev[idx]?.bahanPangan;
                            const existingIdx = prev.findIndex(
                              (it, i) =>
                                i !== idx
                                && it.recipeId === id
                                && it.bahanPangan
                                && it.bahanPangan === bp,
                            );
                            if (existingIdx >= 0) {
                              const addPorsi = Number(prev[idx]?.porsi) || 0;
                              const next = prev
                                .map((it, i) => {
                                  if (i !== existingIdx) return it;
                                  return {
                                    ...it,
                                    porsi: String((Number(it.porsi) || 0) + addPorsi),
                                  };
                                })
                                .filter((_, i) => i !== idx);
                              toast.message('Baris sama digabung — porsi dijumlahkan');
                              return next.length ? next : [emptyItem()];
                            }
                            return consolidateFormItems(
                              prev.map((it, i) => (
                                i === idx ? { ...it, recipeId: id } : it
                              )),
                            );
                          });
                        }}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <span className="sm:hidden text-[11px] text-muted-foreground">Porsi</span>
                      <Input
                        type="number"
                        min={1}
                        value={item.porsi}
                        aria-label={`Porsi baris ${idx + 1}`}
                        onChange={(e) => setItems((prev) => prev.map((it, i) => (
                          i === idx ? { ...it, porsi: e.target.value } : it
                        )))}
                      />
                    </div>
                    <div className="sm:col-span-1 flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={items.length <= 1}
                        aria-label={`Hapus baris ${idx + 1}`}
                        onClick={() => setItems((prev) => prev.filter((_, i) => i !== idx))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {recipes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada resep. Buat di Food Production → Resep.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void save()}
              disabled={saving || !normalizeNama(form.nama) || (!editing && !!exactNamaMatch)}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
