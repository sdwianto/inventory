'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw, Scale } from 'lucide-react';
import type {
  ProductConversionReview,
  RecipeConversionReview,
  RecipeLineConversionStatus,
} from '@/lib/api/recipe-conversion-review';

type ReviewResponse = {
  strictRecipeConversion: boolean;
  summary: RecipeConversionReview['summary'];
  products: ProductConversionReview[];
};

type Filter = 'PROBLEM' | 'INVALID' | 'STALE' | 'ALL';

type EditState = {
  recipeBaseGrams: string;
  recipeBaseMl: string;
  isiPerKemasan: string;
  satuanIsi: string;
};

const STATUS_LABEL: Record<RecipeLineConversionStatus, string> = {
  OK: 'Valid',
  STALE: 'Perlu hitung ulang',
  INVALID: 'Konversi belum ada',
};

const STATUS_CLASS: Record<RecipeLineConversionStatus, string> = {
  OK: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  STALE: 'bg-amber-50 text-amber-800 border-amber-200',
  INVALID: 'bg-red-50 text-red-700 border-red-200',
};

const SOURCE_LABEL: Record<string, string> = {
  MASTER: 'Diisi manual',
  CONFIRMED_INFER: 'Tebakan nama (dikonfirmasi)',
};

const FACTOR_SOURCE_LABEL: Record<string, string> = {
  IDENTITY: 'sama',
  SI: 'SI',
  ISI: 'isi kemasan',
  MASTER: 'master',
  INFERRED: 'tebakan nama',
  NUTRITION: 'nutrisi 100 g',
  SPPG_STANDARD: 'standar SPPG',
};

function fmt(n: number | null | undefined, digits = 6): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: digits }).format(Number(n));
}

function editFrom(p: ProductConversionReview): EditState {
  return {
    recipeBaseGrams: p.recipeBaseGrams != null ? String(p.recipeBaseGrams) : '',
    recipeBaseMl: p.recipeBaseMl != null ? String(p.recipeBaseMl) : '',
    isiPerKemasan: p.isiPerKemasan != null ? String(p.isiPerKemasan) : '',
    satuanIsi: p.satuanIsi || '',
  };
}

export default function RecipeConversionReviewPage() {
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('PROBLEM');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/recipe-conversion/review?includeOk=1', {
        headers: { ...actingTenantHeaders() },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Gagal memuat review konversi');
      setData(json as ReviewResponse);
      setEdits({});
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat review konversi');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.products || []).filter((p) => {
      if (filter === 'PROBLEM' && p.status === 'OK') return false;
      if (filter === 'INVALID' && p.status !== 'INVALID') return false;
      if (filter === 'STALE' && p.status !== 'STALE') return false;
      if (!needle) return true;
      return p.nama.toLowerCase().includes(needle) || p.kode.toLowerCase().includes(needle);
    });
  }, [data, filter, q]);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save(p: ProductConversionReview, confirmInferred: boolean) {
    const e = edits[p.productId] || editFrom(p);
    const body: Record<string, unknown> = {
      recipeBaseGrams: e.recipeBaseGrams.trim() === '' ? null : Number(e.recipeBaseGrams),
      recipeBaseMl: e.recipeBaseMl.trim() === '' ? null : Number(e.recipeBaseMl),
      isiPerKemasan: e.isiPerKemasan.trim() === '' ? null : Number(e.isiPerKemasan),
      satuanIsi: e.satuanIsi.trim() || null,
    };
    if (confirmInferred) body.confirmInferred = true;
    setSaving(p.productId);
    try {
      const res = await fetch(`/api/recipe-conversion/products/${encodeURIComponent(p.productId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Gagal menyimpan konversi');
      toast.success(`Konversi ${p.kode || p.nama} disimpan. Jalankan migrasi hitung ulang agar resep ikut diperbarui.`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Gagal menyimpan konversi');
    } finally {
      setSaving(null);
    }
  }

  function setEdit(p: ProductConversionReview, patch: Partial<EditState>) {
    setEdits((prev) => ({ ...prev, [p.productId]: { ...(prev[p.productId] || editFrom(p)), ...patch } }));
  }

  const s = data?.summary;

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/food-production/recipe" className="text-xs text-muted-foreground inline-flex items-center gap-1 hover:underline">
            <ArrowLeft className="h-3 w-3" /> Resep
          </Link>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Scale className="h-5 w-5" />
            Review Konversi Resep
          </h1>
          <p className="text-sm text-muted-foreground">
            Faktor satuan dapur → satuan stok per bahan. Mode ketat hanya memakai nilai master
            (tanpa tebakan nama yang belum dikonfirmasi dan tanpa cadangan nutrisi 100 g).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="h-4 w-4 mr-1" /> Muat ulang
        </Button>
      </div>

      {data && (
        <div className="text-xs rounded border px-3 py-2 bg-slate-50">
          Mode konversi ketat:{' '}
          <strong className={data.strictRecipeConversion ? 'text-emerald-700' : 'text-amber-800'}>
            {data.strictRecipeConversion ? 'aktif' : 'belum aktif'}
          </strong>
          {!data.strictRecipeConversion && ' — simpan resep masih boleh memakai faktor cadangan.'}
        </div>
      )}

      {s && (
        <div className="flex flex-wrap gap-4 text-sm">
          <div>Resep: <strong>{s.recipes}</strong></div>
          <div>Baris: <strong>{s.lines}</strong></div>
          <div className="text-emerald-700">Valid: <strong>{s.okLines}</strong></div>
          <div className="text-amber-800">Perlu hitung ulang: <strong>{s.staleLines}</strong></div>
          <div className="text-red-700">Konversi belum ada: <strong>{s.invalidLines}</strong></div>
          <div className="text-muted-foreground">Snapshot faktor cadangan: <strong>{s.fallbackLines}</strong></div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <select
          className="h-9 border rounded-md px-2 text-sm bg-white"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="PROBLEM">Bermasalah</option>
          <option value="INVALID">Konversi belum ada</option>
          <option value="STALE">Perlu hitung ulang</option>
          <option value="ALL">Semua bahan kemasan</option>
        </select>
        <Input className="h-9 w-64" placeholder="Cari kode / nama" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-xs text-muted-foreground">{rows.length} bahan</span>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 w-6" />
              <th className="text-left p-2">Bahan</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Gram / basis</th>
              <th className="text-left p-2">Ml / basis</th>
              <th className="text-left p-2">Isi per kemasan</th>
              <th className="text-left p-2">Sumber</th>
              <th className="text-right p-2">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Tidak ada bahan pada filter ini</td></tr>
            )}
            {!loading && rows.map((p) => {
              const e = edits[p.productId] || editFrom(p);
              const expanded = open.has(p.productId);
              const inferredLabel = [
                p.inferred.grams != null ? `${fmt(p.inferred.grams)} g` : '',
                p.inferred.ml != null ? `${fmt(p.inferred.ml)} ml` : '',
              ].filter(Boolean).join(' / ');
              return (
                <Fragment key={p.productId}>
                  <tr className="border-t align-top">
                    <td className="p-2">
                      <button type="button" onClick={() => toggle(p.productId)} aria-label="Detail baris resep">
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="p-2">
                      <div>{p.nama}</div>
                      <div className="text-[11px] font-mono text-muted-foreground">
                        {p.kode} · basis {p.satuan || '—'} · {p.lines.length} baris resep
                      </div>
                      {p.nutritionGramsPerUnit != null && (
                        <div className="text-[11px] text-muted-foreground">
                          Nutrisi: {fmt(p.nutritionGramsPerUnit)} g/unit (tidak dipakai mode ketat)
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${STATUS_CLASS[p.status]}`}>
                        {STATUS_LABEL[p.status]}
                      </span>
                    </td>
                    <td className="p-2">
                      <Input
                        className="h-8 w-28"
                        type="number"
                        min={0}
                        step="any"
                        value={e.recipeBaseGrams}
                        onChange={(ev) => setEdit(p, { recipeBaseGrams: ev.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        className="h-8 w-28"
                        type="number"
                        min={0}
                        step="any"
                        value={e.recipeBaseMl}
                        onChange={(ev) => setEdit(p, { recipeBaseMl: ev.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <div className="flex gap-1">
                        <Input
                          className="h-8 w-16"
                          type="number"
                          min={0}
                          step="any"
                          placeholder="10"
                          value={e.isiPerKemasan}
                          onChange={(ev) => setEdit(p, { isiPerKemasan: ev.target.value })}
                        />
                        <Input
                          className="h-8 w-24"
                          placeholder="SACHET"
                          value={e.satuanIsi}
                          onChange={(ev) => setEdit(p, { satuanIsi: ev.target.value.toUpperCase() })}
                        />
                      </div>
                    </td>
                    <td className="p-2 text-xs">
                      <div>{p.recipeBridgeSource ? SOURCE_LABEL[p.recipeBridgeSource] || p.recipeBridgeSource : 'Belum ditetapkan'}</div>
                      {inferredLabel && (
                        <div className="text-muted-foreground">Tebakan nama: {inferredLabel}</div>
                      )}
                    </td>
                    <td className="p-2 text-right space-y-1">
                      <Button size="sm" onClick={() => void save(p, false)} disabled={saving === p.productId}>
                        Simpan
                      </Button>
                      {inferredLabel && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="block ml-auto"
                          onClick={() => void save(p, true)}
                          disabled={saving === p.productId}
                        >
                          Konfirmasi tebakan
                        </Button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="bg-slate-50/60">
                      <td />
                      <td colSpan={7} className="p-2">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted-foreground">
                              <th className="text-left p-1">Resep</th>
                              <th className="text-left p-1">Satuan dapur</th>
                              <th className="text-right p-1">Faktor tersimpan</th>
                              <th className="text-right p-1">Faktor ketat</th>
                              <th className="text-right p-1">Qty basis besar (lama → baru)</th>
                              <th className="text-left p-1">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.lines.map((l) => (
                              <tr key={`${l.recipeId}-${l.lineIndex}`} className="border-t">
                                <td className="p-1">
                                  {l.recipeKode} — {l.recipeNama}
                                  {!l.recipeAktif && <span className="text-muted-foreground"> (nonaktif)</span>}
                                  {l.cutover && <span className="text-amber-800"> · cutover</span>}
                                </td>
                                <td className="p-1">{l.satuan || '—'} → {l.baseSatuan || '—'}</td>
                                <td className="p-1 text-right">
                                  {fmt(l.before.factorToBase)}
                                  {l.before.factorSource && (
                                    <span className="text-muted-foreground"> ({FACTOR_SOURCE_LABEL[l.before.factorSource] || l.before.factorSource})</span>
                                  )}
                                </td>
                                <td className="p-1 text-right">
                                  {l.after ? fmt(l.after.factorToBase) : '—'}
                                </td>
                                <td className="p-1 text-right">
                                  {fmt(l.before.qtyBaseBesar, 4)} → {l.after ? fmt(l.after.qtyBaseBesar, 4) : '—'}
                                </td>
                                <td className="p-1">
                                  <span className={`inline-block rounded border px-1.5 ${STATUS_CLASS[l.status]}`}>
                                    {STATUS_LABEL[l.status]}
                                  </span>
                                  {l.error && <div className="text-red-700 mt-0.5">{l.error}</div>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
