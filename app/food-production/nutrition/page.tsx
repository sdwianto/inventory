'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getUser } from '@/lib/auth-client';
import { Apple, RefreshCw, Search } from 'lucide-react';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface ProfileRow {
  productId: string;
  kode?: string;
  nama?: string;
  satuan?: string;
  tkpiCode?: string | null;
  usdaCode?: string | null;
  hasNutrition: boolean;
  nutrition?: {
    basis: string;
    gramsPerUnit?: number;
    bddPct?: number;
    tkpiCode?: string;
    usdaCode?: string;
    usdaNama?: string;
    energiKcal: number;
    proteinG: number;
    lemakG: number;
    karbohidratG: number;
    seratG?: number;
    natriumMg?: number;
    gulaG?: number;
  } | null;
}

interface TkpiHit {
  kode: string;
  nama: string;
  namaId?: string;
  energiKcal: number;
  proteinG: number;
  bddPct: number;
  kelompok?: string;
}

interface Analysis {
  scope: string;
  refLabel?: string;
  yieldPorsi: number;
  perPorsi: Record<string, number>;
  batch: Record<string, number>;
  missingProductIds: string[];
  warnings: string[];
  perPorsiAkgPct: Record<string, number>;
  akgProfile: string;
}

export default function NutritionPage() {
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<ProfileRow[]>([]);
  const [summary, setSummary] = useState({ total: 0, withNutrition: 0, missing: 0 });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [missingOnly, setMissingOnly] = useState(false);
  const [edit, setEdit] = useState<ProfileRow | null>(null);
  const [form, setForm] = useState({
    basis: 'PER_UNIT',
    gramsPerUnit: '100',
    energiKcal: '',
    proteinG: '',
    lemakG: '',
    karbohidratG: '',
    seratG: '',
    natriumMg: '',
    gulaG: '',
  });
  const [recipes, setRecipes] = useState<Array<{ id: string; kode: string; nama: string }>>([]);
  const [recipeId, setRecipeId] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [saving, setSaving] = useState(false);
  const [tkpiQ, setTkpiQ] = useState('');
  const [tkpiHits, setTkpiHits] = useState<TkpiHit[]>([]);
  const [usdaHits, setUsdaHits] = useState<TkpiHit[]>([]);
  const [tkpiBusy, setTkpiBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (missingOnly) qs.set('missing', '1');
      if (q) qs.set('q', q);
      const [pRes, rRes] = await Promise.all([
        fetch(`/api/nutrition-profiles?${qs}`, { headers: { ...actingTenantHeaders() } }),
        fetch('/api/recipes?aktif=1', { headers: { ...actingTenantHeaders() } }),
      ]);
      const pData = await pRes.json();
      const rData = await rRes.json();
      if (!pRes.ok) throw new Error(pData?.error || 'Gagal memuat gizi');
      setRows(Array.isArray(pData.items) ? pData.items : []);
      setSummary(pData.summary || { total: 0, withNutrition: 0, missing: 0 });
      setRecipes(Array.isArray(rData) ? rData : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat');
    } finally {
      setLoading(false);
    }
  }, [missingOnly, q]);

  useEffect(() => { void load(); }, [load]);

  function openEdit(row: ProfileRow) {
    setEdit(row);
    const n = row.nutrition;
    setForm({
      basis: n?.basis || 'PER_UNIT',
      gramsPerUnit: String(n?.gramsPerUnit ?? 100),
      energiKcal: n ? String(n.energiKcal) : '',
      proteinG: n ? String(n.proteinG) : '',
      lemakG: n ? String(n.lemakG) : '',
      karbohidratG: n ? String(n.karbohidratG) : '',
      seratG: n?.seratG != null ? String(n.seratG) : '',
      natriumMg: n?.natriumMg != null ? String(n.natriumMg) : '',
      gulaG: n?.gulaG != null ? String(n.gulaG) : '',
    });
  }

  async function searchTkpi(q: string) {
    setTkpiQ(q);
    if (q.trim().length < 2) {
      setTkpiHits([]);
      setUsdaHits([]);
      return;
    }
    setTkpiBusy(true);
    try {
      const res = await fetch(
        `/api/nutrition-profiles/tkpi?q=${encodeURIComponent(q.trim())}&limit=20`,
        { headers: { ...actingTenantHeaders() } },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal cari TKPI');
      setTkpiHits(Array.isArray(data.items) ? data.items : []);
      setUsdaHits(Array.isArray(data.usdaItems) ? data.usdaItems : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal cari TKPI');
    } finally {
      setTkpiBusy(false);
    }
  }

  async function applyTkpi(kode: string) {
    if (!edit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/nutrition-profiles/${edit.productId}/apply-tkpi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ tkpiCode: kode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal terapkan TKPI');
      toast.success(`Gizi dari TKPI ${kode} diterapkan`);
      setEdit(null);
      setTkpiHits([]);
      setUsdaHits([]);
      setTkpiQ('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal terapkan TKPI');
    } finally {
      setSaving(false);
    }
  }

  async function applyUsda(kode: string) {
    if (!edit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/nutrition-profiles/${edit.productId}/apply-usda`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ usdaCode: kode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal terapkan USDA');
      toast.success(`Gizi cadangan USDA ${kode} diterapkan`);
      setEdit(null);
      setTkpiHits([]);
      setUsdaHits([]);
      setTkpiQ('');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal terapkan USDA');
    } finally {
      setSaving(false);
    }
  }

  async function saveNutrition() {
    if (!edit) return;
    setSaving(true);
    try {
      const nutrition = {
        basis: form.basis,
        gramsPerUnit: form.basis === 'PER_100G' ? Number(form.gramsPerUnit) : undefined,
        energiKcal: Number(form.energiKcal),
        proteinG: Number(form.proteinG),
        lemakG: Number(form.lemakG),
        karbohidratG: Number(form.karbohidratG),
        seratG: form.seratG === '' ? 0 : Number(form.seratG),
        natriumMg: form.natriumMg === '' ? 0 : Number(form.natriumMg),
        gulaG: form.gulaG === '' ? 0 : Number(form.gulaG),
      };
      const res = await fetch(`/api/nutrition-profiles/${edit.productId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ nutrition }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal simpan');
      toast.success('Profil gizi tersimpan');
      setEdit(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal simpan');
    } finally {
      setSaving(false);
    }
  }

  async function analyzeRecipe() {
    if (!recipeId) {
      toast.error('Pilih resep');
      return;
    }
    try {
      const res = await fetch(
        `/api/nutrition-profiles/analyze?scope=recipe&id=${encodeURIComponent(recipeId)}&akg=PORSI_KECIL`,
        { headers: { ...actingTenantHeaders() } },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal analisis');
      setAnalysis(data as Analysis);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal analisis');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Apple className="h-5 w-5" />
            Analisis Gizi (MBG)
          </h1>
          <p className="text-sm text-muted-foreground">
            Profil gizi bahan (TKPI) → agregasi resep / menu / rencana / HSL · % AKG Permenkes
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
        </Button>
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <div>Total: <strong>{summary.total}</strong></div>
        <div>Ada gizi: <strong>{summary.withNutrition}</strong></div>
        <div className="text-amber-800">Belum: <strong>{summary.missing}</strong></div>
      </div>

      <div className="flex flex-wrap gap-2 items-end">
        <div className="space-y-1">
          <Label className="text-xs">Cari produk</Label>
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input className="h-9 pl-8 w-56" value={q} onChange={(e) => setQ(e.target.value)} placeholder="kode / nama" />
          </div>
        </div>
        <label className="text-xs flex items-center gap-2 pb-2">
          <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
          Hanya yang belum punya gizi
        </label>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">Produk</th>
              <th className="text-left p-3">Basis</th>
              <th className="text-right p-3">kkal</th>
              <th className="text-right p-3">Protein</th>
              <th className="text-right p-3">Lemak</th>
              <th className="text-right p-3">Karbo</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Tidak ada produk</td></tr>
            )}
            {rows.map((row) => (
              <tr key={row.productId} className="border-t">
                <td className="p-3">
                  <div>{row.nama}</div>
                  <div className="text-[11px] font-mono text-muted-foreground">
                    {row.kode} · {row.satuan}
                    {(row.tkpiCode || row.nutrition?.tkpiCode)
                      ? ` · TKPI ${row.tkpiCode || row.nutrition?.tkpiCode}`
                      : (row.usdaCode || row.nutrition?.usdaCode)
                        ? ` · USDA ${row.usdaCode || row.nutrition?.usdaCode}`
                        : ''}
                  </div>
                </td>
                <td className="p-3">{row.nutrition?.basis || '—'}</td>
                <td className="p-3 text-right">{row.nutrition?.energiKcal ?? '—'}</td>
                <td className="p-3 text-right">{row.nutrition?.proteinG ?? '—'}</td>
                <td className="p-3 text-right">{row.nutrition?.lemakG ?? '—'}</td>
                <td className="p-3 text-right">{row.nutrition?.karbohidratG ?? '—'}</td>
                <td className="p-3 text-right">
                  {canManage && (
                    <Button size="sm" variant="outline" onClick={() => openEdit(row)}>
                      {row.hasNutrition ? 'Edit' : 'Isi gizi'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border p-4 space-y-3">
        <h2 className="font-medium text-sm">Analisis resep</h2>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1 grow min-w-[14rem]">
            <Label className="text-xs">Resep</Label>
            <select
              className="w-full h-9 border rounded-md px-2 text-sm bg-white"
              value={recipeId}
              onChange={(e) => setRecipeId(e.target.value)}
            >
              <option value="">— Pilih —</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>{r.kode} · {r.nama}</option>
              ))}
            </select>
          </div>
          <Button size="sm" onClick={() => void analyzeRecipe()}>Hitung gizi / porsi</Button>
        </div>
        {analysis && (
          <div className="text-sm space-y-2">
            <div className="text-muted-foreground">
              {analysis.refLabel} · yield {analysis.yieldPorsi} porsi · AKG {analysis.akgProfile}
            </div>
            {!!analysis.warnings.length && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
                {analysis.warnings.join(' · ')}
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {(['energiKcal', 'proteinG', 'lemakG', 'karbohidratG'] as const).map((k) => (
                <div key={k} className="border rounded p-2">
                  <div className="text-[11px] text-muted-foreground">{k}</div>
                  <div className="font-medium">{analysis.perPorsi[k]} / porsi</div>
                  <div className="text-[11px]">{analysis.perPorsiAkgPct[k] ?? 0}% AKG harian</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!edit} onOpenChange={(o) => {
        if (!o) {
          setEdit(null);
          setTkpiHits([]);
          setUsdaHits([]);
          setTkpiQ('');
        }
      }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Gizi — {edit?.nama}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 border rounded-md p-3 bg-muted/30">
            <Label className="text-xs">Cari TKPI 2019, atau cadangan USDA bila tidak ada</Label>
            <Input
              className="h-9"
              placeholder="nama / kode (min. 2 huruf)"
              value={tkpiQ}
              onChange={(e) => void searchTkpi(e.target.value)}
            />
            {tkpiBusy && <p className="text-[11px] text-muted-foreground">Mencari…</p>}
            {tkpiHits.length > 0 && (
              <ul className="max-h-40 overflow-y-auto text-sm divide-y border rounded-md bg-white">
                {tkpiHits.map((hit) => (
                  <li key={hit.kode} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <div className="min-w-0">
                      <div className="font-mono text-[11px] text-muted-foreground">{hit.kode}</div>
                      <div className="truncate">{hit.nama}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {hit.energiKcal} kkal · P {hit.proteinG}g · BDD {hit.bddPct}%
                        {hit.kelompok ? ` · ${hit.kelompok}` : ''}
                      </div>
                    </div>
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => void applyTkpi(hit.kode)}>
                      Terapkan
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {usdaHits.length > 0 && (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-amber-900">Cadangan USDA SR</p>
                <ul className="max-h-36 overflow-y-auto text-sm divide-y border border-amber-200 rounded-md bg-amber-50/50">
                  {usdaHits.map((hit) => (
                    <li key={hit.kode} className="flex items-center justify-between gap-2 px-2 py-1.5">
                      <div className="min-w-0">
                        <div className="font-mono text-[11px] text-muted-foreground">{hit.kode}</div>
                        <div className="truncate">{hit.namaId || hit.nama}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {hit.energiKcal} kkal · P {hit.proteinG}g · USDA
                        </div>
                      </div>
                      <Button size="sm" variant="outline" disabled={saving} onClick={() => void applyUsda(hit.kode)}>
                        USDA
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 py-2">
            <div className="col-span-2 space-y-1">
              <Label>Basis</Label>
              <select
                className="w-full h-9 border rounded-md px-2 text-sm"
                value={form.basis}
                onChange={(e) => setForm((f) => ({ ...f, basis: e.target.value }))}
              >
                <option value="PER_UNIT">Per satuan stok</option>
                <option value="PER_100G">Per 100 g</option>
              </select>
            </div>
            {form.basis === 'PER_100G' && (
              <div className="col-span-2 space-y-1">
                <Label>Gram per 1 satuan stok</Label>
                <Input value={form.gramsPerUnit} onChange={(e) => setForm((f) => ({ ...f, gramsPerUnit: e.target.value }))} />
              </div>
            )}
            {([
              ['energiKcal', 'Energi (kkal)'],
              ['proteinG', 'Protein (g)'],
              ['lemakG', 'Lemak (g)'],
              ['karbohidratG', 'Karbohidrat (g)'],
              ['seratG', 'Serat (g)'],
              ['natriumMg', 'Natrium (mg)'],
              ['gulaG', 'Gula (g)'],
            ] as const).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label>{label}</Label>
                <Input
                  type="number"
                  value={form[key]}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdit(null)}>Batal</Button>
            <Button onClick={() => void saveNutrition()} disabled={saving}>
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
