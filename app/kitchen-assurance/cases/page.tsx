'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { getActingKitchenId } from '@/lib/acting-kitchen-client';
import { FolderOpen, Plus, RefreshCw } from 'lucide-react';
import FoodSafetyBreadcrumb from '@/components/food-safety/FoodSafetyBreadcrumb';
import {
  KA_CASE_KIND_LABELS,
  KA_CASE_STATUS_LABELS,
  type KaCaseKind,
  type KaCaseStatus,
} from '@/lib/kitchen-assurance/safety-case';
import {
  KA_FOLLOW_UP_PRIORITY_LABELS,
  type KaFollowUpPriority,
} from '@/lib/kitchen-assurance/follow-up';
import { KA_PILLAR_LABELS, KA_PILLARS, type KaCategory } from '@/lib/kitchen-assurance/categories';

interface CaseRow {
  id: string;
  noDokumen: string;
  title: string;
  category: KaCategory;
  caseKind: KaCaseKind;
  status: KaCaseStatus;
  severity?: string;
  openFollowUps?: number;
  description?: string;
  photos?: string[];
  loggedAt?: string;
}

const DAY_NAMES_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'] as const;

function toDatetimeLocalValue(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatLogId(raw?: string | Date): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  const day = DAY_NAMES_ID[d.getDay()];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const CASE_CATEGORIES = [...KA_PILLARS];
const STATUS_FILTERS: Array<{ value: '' | KaCaseStatus; label: string }> = [
  { value: '', label: 'Semua' },
  { value: 'OPEN', label: 'Terbuka' },
  { value: 'IN_PROGRESS', label: 'Diproses' },
  { value: 'PENDING_VERIFY', label: 'Menunggu verifikasi' },
  { value: 'CLOSED', label: 'Ditutup' },
];

function pillarFromQuery(): '' | KaCategory {
  if (typeof window === 'undefined') return '';
  const raw = (new URLSearchParams(window.location.search).get('category') || '').toUpperCase();
  return (KA_PILLARS as readonly string[]).includes(raw) ? (raw as KaCategory) : '';
}

function statusFromQuery(): '' | KaCaseStatus {
  if (typeof window === 'undefined') return '';
  const raw = (new URLSearchParams(window.location.search).get('status') || '').toUpperCase();
  if (
    raw === 'OPEN' ||
    raw === 'IN_PROGRESS' ||
    raw === 'PENDING_VERIFY' ||
    raw === 'CLOSED' ||
    raw === 'CANCELLED'
  ) {
    return raw;
  }
  return '';
}

function batchIdFromQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('batchId') || '';
}

export default function KaCasesPage() {
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'' | KaCaseStatus>('');
  const [pillarFilter, setPillarFilter] = useState<'' | KaCategory>('');
  const [batchIdFilter, setBatchIdFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [fuFor, setFuFor] = useState<CaseRow | null>(null);
  const [fuSaving, setFuSaving] = useState(false);
  const [form, setForm] = useState({
    title: '',
    category: 'FOOD' as KaCategory,
    caseKind: 'OTHER' as KaCaseKind,
    description: '',
    severity: 'MEDIUM',
    loggedAt: toDatetimeLocalValue(),
  });
  const [photos, setPhotos] = useState<string[]>([]);
  const [fuForm, setFuForm] = useState({
    title: '',
    description: '',
    priority: 'MEDIUM' as KaFollowUpPriority,
    ownerName: '',
    dueAt: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const params = new URLSearchParams();
      if (kitchenId) params.set('kitchenId', kitchenId);
      if (statusFilter) params.set('status', statusFilter);
      if (pillarFilter) params.set('category', pillarFilter);
      if (batchIdFilter) params.set('batchId', batchIdFilter);
      const q = params.toString() ? `?${params}` : '';
      const res = await fetch(`/api/ka-safety-cases${q}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat cases');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, pillarFilter, batchIdFilter]);

  useEffect(() => {
    const fromQuery = pillarFromQuery();
    if (fromQuery) setPillarFilter(fromQuery);
    const st = statusFromQuery();
    if (st) setStatusFilter(st);
    const bid = batchIdFromQuery();
    if (bid) setBatchIdFilter(bid);
  }, []);

  useEffect(() => {
    void load();
    const onKitchen = () => void load();
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  async function createCase() {
    try {
      const kitchenId = getActingKitchenId();
      if (!kitchenId) {
        toast.error('Pilih dapur (Kitchen Scope) terlebih dahulu');
        return;
      }
      const loggedAtIso = form.loggedAt
        ? new Date(form.loggedAt).toISOString()
        : new Date().toISOString();
      const res = await fetch('/api/ka-safety-cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          title: form.title,
          category: form.category,
          caseKind: form.caseKind,
          description: form.description || undefined,
          severity: form.severity,
          kitchenId,
          loggedAt: loggedAtIso,
          photos,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal membuat case');
      toast.success(`Issue ${data.noDokumen} dibuat`);
      setOpen(false);
      setForm({
        title: '',
        category: 'FOOD',
        caseKind: 'OTHER',
        description: '',
        severity: 'MEDIUM',
        loggedAt: toDatetimeLocalValue(),
      });
      setPhotos([]);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  async function patchStatus(id: string, status: KaCaseStatus) {
    try {
      const res = await fetch(`/api/ka-safety-cases/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal update');
      toast.success(`Status → ${KA_CASE_STATUS_LABELS[status]}`);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  function openFollowUpDialog(row: CaseRow) {
    setFuFor(row);
    setFuForm({
      title: `Follow-up: ${row.title}`,
      description: '',
      priority: 'MEDIUM',
      ownerName: '',
      dueAt: '',
    });
  }

  async function createFollowUp() {
    if (!fuFor || fuSaving) return;
    setFuSaving(true);
    try {
      const res = await fetch(`/api/ka-safety-cases/${fuFor.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          createFollowUp: {
            title: fuForm.title,
            description: fuForm.description || undefined,
            priority: fuForm.priority,
            ownerName: fuForm.ownerName || undefined,
            dueAt: fuForm.dueAt || undefined,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal buat follow-up');
      toast.success('Follow-up dibuat');
      setFuFor(null);
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setFuSaving(false);
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FoodSafetyBreadcrumb
            items={[
              { href: '/kitchen-assurance/temuan', label: 'Temuan & perbaikan' },
              { label: 'Daftar issue' },
            ]}
          />
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            <FolderOpen className="h-5 w-5" />
            Daftar issue
          </h1>
          <p className="text-sm text-muted-foreground">
            Catat masalah keamanan pangan. Lanjut ke tugas perbaikan (follow-up) bila perlu, lalu tutup setelah selesai.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setForm((f) => ({ ...f, loggedAt: toDatetimeLocalValue() }));
              setPhotos([]);
              setOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            Issue baru
          </Button>
        </div>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {batchIdFilter ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          Difilter batch <code className="text-xs">{batchIdFilter.slice(0, 12)}…</code>
          <Button
            size="sm"
            variant="link"
            className="ml-2 h-auto p-0"
            onClick={() => {
              setBatchIdFilter('');
              if (typeof window !== 'undefined') {
                const url = new URL(window.location.href);
                url.searchParams.delete('batchId');
                window.history.replaceState({}, '', `${url.pathname}${url.search}`);
              }
            }}
          >
            Hapus filter
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((s) => (
          <Button
            key={s.label}
            size="sm"
            variant={statusFilter === s.value ? 'default' : 'outline'}
            onClick={() => setStatusFilter(s.value)}
          >
            {s.label}
          </Button>
        ))}
        <span className="mx-1 self-center text-muted-foreground">|</span>
        <Button
          size="sm"
          variant={pillarFilter === '' ? 'default' : 'outline'}
          onClick={() => setPillarFilter('')}
        >
          Semua pilar
        </Button>
        {KA_PILLARS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={pillarFilter === p ? 'default' : 'outline'}
            onClick={() => setPillarFilter(p)}
          >
            {KA_PILLAR_LABELS[p]}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">No</th>
              <th className="px-3 py-2">Log</th>
              <th className="px-3 py-2">Judul</th>
              <th className="px-3 py-2">Kategori</th>
              <th className="px-3 py-2">Jenis</th>
              <th className="px-3 py-2">Foto</th>
              <th className="px-3 py-2">FU terbuka</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{r.noDokumen}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {formatLogId(r.loggedAt)}
                </td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2">{KA_PILLAR_LABELS[r.category as keyof typeof KA_PILLAR_LABELS] || r.category}</td>
                <td className="px-3 py-2">{KA_CASE_KIND_LABELS[r.caseKind]}</td>
                <td className="px-3 py-2 text-xs">{r.photos?.length || 0}</td>
                <td className="px-3 py-2">
                  {(r.openFollowUps || 0) > 0 ? (
                    <Link
                      href={`/kitchen-assurance/follow-up?caseId=${encodeURIComponent(r.id)}`}
                      className="text-blue-700 hover:underline"
                    >
                      {r.openFollowUps}
                    </Link>
                  ) : (
                    '0'
                  )}
                </td>
                <td className="px-3 py-2">{KA_CASE_STATUS_LABELS[r.status]}</td>
                <td className="px-3 py-2 text-right space-x-1">
                  {r.status === 'OPEN' && (
                    <Button size="sm" variant="ghost" onClick={() => void patchStatus(r.id, 'IN_PROGRESS')}>
                      Proses
                    </Button>
                  )}
                  {(r.status === 'OPEN' || r.status === 'IN_PROGRESS' || r.status === 'PENDING_VERIFY') && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(r.openFollowUps || 0) > 0}
                        title={
                          (r.openFollowUps || 0) > 0
                            ? 'Sudah ada follow-up aktif — buka dari kolom FU'
                            : undefined
                        }
                        onClick={() => openFollowUpDialog(r)}
                      >
                        + Follow Up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={(r.openFollowUps || 0) > 0}
                        title={(r.openFollowUps || 0) > 0 ? 'Selesaikan & verifikasi follow-up dulu' : undefined}
                        onClick={() => void patchStatus(r.id, 'CLOSED')}
                      >
                        Tutup
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  Belum ada issue
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Issue baru</DialogTitle>
            <DialogDescription>
              Catat issue operasional dapur dengan log waktu dan foto bukti (opsional, maks 3).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Log hari / tanggal / jam</Label>
              <input
                type="datetime-local"
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.loggedAt}
                onChange={(e) => setForm((f) => ({ ...f, loggedAt: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {formatLogId(form.loggedAt ? new Date(form.loggedAt) : undefined)}
              </p>
            </div>
            <div>
              <Label>Judul</Label>
              <input
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Kategori</Label>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={form.category}
                  onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as KaCategory }))}
                >
                  {CASE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{KA_PILLAR_LABELS[c]}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Jenis</Label>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={form.caseKind}
                  onChange={(e) => setForm((f) => ({ ...f, caseKind: e.target.value as KaCaseKind }))}
                >
                  {Object.entries(KA_CASE_KIND_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <Label>Deskripsi</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <PhotoUploadField
              label="Foto bukti"
              hint="Maksimal 3 foto. Gambar oversized otomatis di-resize/kompres."
              photos={photos}
              onChange={setPhotos}
              maxPhotos={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void createCase()} disabled={!form.title.trim()}>Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fuFor} onOpenChange={(v) => !v && setFuFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Follow Up — {fuFor?.noDokumen}</DialogTitle>
            <DialogDescription>
              Buat tugas tindak lanjut untuk issue ini (owner, prioritas, due date).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Judul tugas</Label>
              <input
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={fuForm.title}
                onChange={(e) => setFuForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div>
              <Label>Deskripsi</Label>
              <Textarea
                value={fuForm.description}
                onChange={(e) => setFuForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Priority</Label>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={fuForm.priority}
                  onChange={(e) => setFuForm((f) => ({ ...f, priority: e.target.value as KaFollowUpPriority }))}
                >
                  {Object.entries(KA_FOLLOW_UP_PRIORITY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Owner</Label>
                <input
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={fuForm.ownerName}
                  onChange={(e) => setFuForm((f) => ({ ...f, ownerName: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Due date</Label>
              <input
                type="date"
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={fuForm.dueAt}
                onChange={(e) => setFuForm((f) => ({ ...f, dueAt: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFuFor(null)}>Batal</Button>
            <Button
              onClick={() => void createFollowUp()}
              disabled={!fuForm.title.trim() || fuSaving}
            >
              {fuSaving ? 'Menyimpan…' : 'Buat Follow Up'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
