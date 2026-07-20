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
import { getUser } from '@/lib/auth-client';
import { SquareCheck, Plus, RefreshCw } from 'lucide-react';
import {
  KA_FOLLOW_UP_PRIORITY_LABELS,
  KA_FOLLOW_UP_STATUS_LABELS,
  type KaFollowUpPriority,
  type KaFollowUpStatus,
} from '@/lib/kitchen-assurance/follow-up';
import { KA_PILLAR_LABELS, type KaPillar } from '@/lib/kitchen-assurance/categories';

interface FuRow {
  id: string;
  noDokumen: string;
  title: string;
  status: KaFollowUpStatus;
  priority: KaFollowUpPriority;
  ownerName?: string;
  safetyCaseId?: string;
  safetyCaseNo?: string;
  category?: KaPillar;
  evidenceMedia?: string[];
  evidenceNote?: string;
  dueAt?: string;
}

interface IssueOption {
  id: string;
  noDokumen: string;
  title: string;
  status: string;
  openFollowUps?: number;
}

const MANAGE = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

function caseIdFromQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('caseId') || '';
}

function statusFromQuery(): '' | KaFollowUpStatus {
  if (typeof window === 'undefined') return 'OPEN';
  const params = new URLSearchParams(window.location.search);
  if (params.has('caseId')) return ''; // show OPEN+DONE when deep-linked from Cases
  if (!params.has('status')) return 'OPEN';
  const raw = (params.get('status') || '').toUpperCase();
  if (raw === 'OPEN' || raw === 'DONE' || raw === 'VERIFIED' || raw === 'CANCELLED') return raw;
  return '';
}

export default function KaFollowUpPage() {
  const [rows, setRows] = useState<FuRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [caseId, setCaseId] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | KaFollowUpStatus>('OPEN');
  const [open, setOpen] = useState(false);
  const [evidenceFor, setEvidenceFor] = useState<FuRow | null>(null);
  const [evidencePhotos, setEvidencePhotos] = useState<string[]>([]);
  const [evidenceNote, setEvidenceNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [issueOptions, setIssueOptions] = useState<IssueOption[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'MEDIUM' as KaFollowUpPriority,
    ownerName: '',
    dueAt: '',
    safetyCaseId: '',
  });
  const canVerify = MANAGE.has(getUser()?.role || '');
  const caseHasActiveFu =
    !!caseId && rows.some((r) => r.safetyCaseId === caseId && (r.status === 'OPEN' || r.status === 'DONE'));

  useEffect(() => {
    setCaseId(caseIdFromQuery());
    setStatusFilter(statusFromQuery());
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const kitchenId = getActingKitchenId();
      const params = new URLSearchParams();
      if (kitchenId) params.set('kitchenId', kitchenId);
      if (statusFilter) params.set('status', statusFilter);
      if (caseId) params.set('caseId', caseId);
      const q = params.toString() ? `?${params}` : '';
      const res = await fetch(`/api/ka-follow-ups${q}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat follow-up');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, caseId]);

  useEffect(() => {
    void load();
    const onKitchen = () => void load();
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  async function loadIssueOptions(): Promise<IssueOption[]> {
    setLoadingIssues(true);
    try {
      const kitchenId = getActingKitchenId();
      const params = new URLSearchParams();
      if (kitchenId) params.set('kitchenId', kitchenId);
      const q = params.toString() ? `?${params}` : '';
      const res = await fetch(`/api/ka-safety-cases${q}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat issue');
      const list = (Array.isArray(data) ? data : []) as IssueOption[];
      // Hanya issue terbuka yang belum punya FU aktif
      const eligible = list.filter(
        (c) =>
          (c.status === 'OPEN' || c.status === 'IN_PROGRESS' || c.status === 'PENDING_VERIFY') &&
          !(c.openFollowUps && c.openFollowUps > 0),
      );
      setIssueOptions(eligible);
      return eligible;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat issue');
      setIssueOptions([]);
      return [];
    } finally {
      setLoadingIssues(false);
    }
  }

  async function createFu() {
    if (saving) return;
    const safetyCaseId = form.safetyCaseId.trim();
    if (!safetyCaseId) {
      toast.error('Pilih Issue sumber terlebih dahulu');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ka-follow-ups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          title: form.title,
          description: form.description || undefined,
          priority: form.priority,
          ownerName: form.ownerName || undefined,
          dueAt: form.dueAt || undefined,
          safetyCaseId,
          kitchenId: getActingKitchenId() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal membuat');
      toast.success(`Follow-up ${data.noDokumen} dibuat`);
      setOpen(false);
      setForm({ title: '', description: '', priority: 'MEDIUM', ownerName: '', dueAt: '', safetyCaseId: '' });
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function patchStatus(
    row: FuRow,
    status: KaFollowUpStatus,
    evidenceMedia?: string[],
    note?: string,
  ) {
    try {
      const body: Record<string, unknown> = { status };
      if (evidenceMedia) body.evidenceMedia = evidenceMedia;
      if (note != null) body.evidenceNote = note.trim() || undefined;
      const res = await fetch(`/api/ka-follow-ups/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal update');
      toast.success(`Status → ${KA_FOLLOW_UP_STATUS_LABELS[status]}`);
      setEvidenceFor(null);
      setEvidencePhotos([]);
      setEvidenceNote('');
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  function openDoneDialog(row: FuRow) {
    setEvidenceFor(row);
    setEvidencePhotos(row.evidenceMedia || []);
    setEvidenceNote(row.evidenceNote || '');
  }

  async function openCreate() {
    setOpen(true);
    const eligible = await loadIssueOptions();
    const preselect = caseId && eligible.some((c) => c.id === caseId) ? caseId : '';
    const issue = eligible.find((c) => c.id === preselect);
    setForm({
      title: issue ? `Follow-up: ${issue.title}` : '',
      description: '',
      priority: 'MEDIUM',
      ownerName: '',
      dueAt: '',
      safetyCaseId: preselect,
    });
  }

  function onSelectIssue(id: string) {
    const issue = issueOptions.find((c) => c.id === id);
    setForm((f) => ({
      ...f,
      safetyCaseId: id,
      title: f.title.trim() && !f.title.startsWith('Follow-up:')
        ? f.title
        : issue
          ? `Follow-up: ${issue.title}`
          : f.title,
    }));
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <SquareCheck className="h-5 w-5" />
            Follow Up
          </h1>
          <p className="text-sm text-muted-foreground">
            Task operasional dari Issue: owner, due date, evidence, verify — bukan CAPA.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={openCreate}
            disabled={caseHasActiveFu}
            title={
              caseHasActiveFu
                ? 'Issue ini sudah punya follow-up aktif — jangan buat lagi'
                : undefined
            }
          >
            <Plus className="mr-1 h-4 w-4" />
            Task baru
          </Button>
        </div>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {caseId && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-slate-50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Filter Issue:</span>
          <code className="text-xs">{caseId.slice(0, 8)}…</code>
          <Link href="/kitchen-assurance/cases" className="text-blue-700 hover:underline">
            Semua issue
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setCaseId('');
              const url = new URL(window.location.href);
              url.searchParams.delete('caseId');
              window.history.replaceState({}, '', url.pathname + (url.search || ''));
            }}
          >
            Hapus filter
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {(['', 'OPEN', 'DONE', 'VERIFIED', 'CANCELLED'] as const).map((s) => (
          <Button
            key={s || 'all'}
            size="sm"
            variant={statusFilter === s ? 'default' : 'outline'}
            onClick={() => setStatusFilter(s)}
          >
            {s ? KA_FOLLOW_UP_STATUS_LABELS[s] : 'Semua'}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">No</th>
              <th className="px-3 py-2">Judul</th>
              <th className="px-3 py-2">Pilar</th>
              <th className="px-3 py-2">Priority</th>
              <th className="px-3 py-2">Owner</th>
              <th className="px-3 py-2">Issue</th>
              <th className="px-3 py-2">Due</th>
              <th className="px-3 py-2">Evidence</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{r.noDokumen}</td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2 text-xs">
                  {r.category ? KA_PILLAR_LABELS[r.category] || r.category : '—'}
                </td>
                <td className="px-3 py-2">{KA_FOLLOW_UP_PRIORITY_LABELS[r.priority]}</td>
                <td className="px-3 py-2">{r.ownerName || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {r.safetyCaseNo ? (
                    <Link href="/kitchen-assurance/cases" className="text-blue-700 hover:underline">
                      {r.safetyCaseNo}
                    </Link>
                  ) : '—'}
                </td>
                <td className="px-3 py-2 text-xs">{r.dueAt ? String(r.dueAt).slice(0, 10) : '—'}</td>
                <td className="px-3 py-2 text-xs">{r.evidenceMedia?.length || 0} foto</td>
                <td className="px-3 py-2">{KA_FOLLOW_UP_STATUS_LABELS[r.status]}</td>
                <td className="px-3 py-2 text-right space-x-1">
                  {r.status === 'OPEN' && (
                    <Button size="sm" variant="outline" onClick={() => openDoneDialog(r)}>
                      Selesai + evidence
                    </Button>
                  )}
                  {r.status === 'DONE' && canVerify && (
                    <Button
                      size="sm"
                      onClick={() => void patchStatus(r, 'VERIFIED', r.evidenceMedia)}
                    >
                      Verifikasi
                    </Button>
                  )}
                  {(r.status === 'OPEN' || r.status === 'DONE') && canVerify && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (!confirm(`Batalkan follow-up ${r.noDokumen}?`)) return;
                        void patchStatus(r, 'CANCELLED', r.evidenceMedia);
                      }}
                    >
                      Batalkan
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                  Belum ada follow-up
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Follow-up baru</DialogTitle>
            <DialogDescription>
              Wajib tertaut ke Issue. Task operasional: owner, prioritas, due date — bukan CAPA.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Issue sumber *</Label>
              <select
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.safetyCaseId}
                disabled={loadingIssues}
                onChange={(e) => onSelectIssue(e.target.value)}
              >
                <option value="">
                  {loadingIssues ? 'Memuat issue…' : '— Pilih issue —'}
                </option>
                {issueOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.noDokumen} — {c.title}
                  </option>
                ))}
              </select>
              {!loadingIssues && !issueOptions.length && (
                <p className="mt-1 text-xs text-amber-700">
                  Tidak ada issue yang bisa dibuatkan follow-up.{' '}
                  <Link href="/kitchen-assurance/cases" className="underline">
                    Buat Issue dulu
                  </Link>
                  .
                </p>
              )}
            </div>
            <div>
              <Label>Judul</Label>
              <input
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div>
              <Label>Deskripsi</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Priority</Label>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as KaFollowUpPriority }))}
                >
                  {Object.entries(KA_FOLLOW_UP_PRIORITY_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Owner (nama)</Label>
                <input
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={form.ownerName}
                  onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Due date</Label>
              <input
                type="date"
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.dueAt}
                onChange={(e) => setForm((f) => ({ ...f, dueAt: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void createFu()}
              disabled={!form.title.trim() || !form.safetyCaseId || saving || loadingIssues}
            >
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!evidenceFor} onOpenChange={(v) => !v && setEvidenceFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Evidence — {evidenceFor?.noDokumen}</DialogTitle>
            <DialogDescription>
              Upload minimal 1 foto bukti sebelum menandai follow-up selesai.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <PhotoUploadField
              label="Foto evidence"
              hint="Wajib minimal 1 foto sebelum menandai selesai"
              photos={evidencePhotos}
              onChange={setEvidencePhotos}
              maxPhotos={5}
            />
            <div>
              <Label>Komentar / keterangan</Label>
              <Textarea
                className="mt-1"
                placeholder="Catatan singkat tentang perbaikan yang sudah dilakukan…"
                value={evidenceNote}
                onChange={(e) => setEvidenceNote(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEvidenceFor(null);
                setEvidenceNote('');
              }}
            >
              Batal
            </Button>
            <Button
              disabled={!evidencePhotos.length || !evidenceFor}
              onClick={() =>
                evidenceFor && void patchStatus(evidenceFor, 'DONE', evidencePhotos, evidenceNote)
              }
            >
              Tandai selesai
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
