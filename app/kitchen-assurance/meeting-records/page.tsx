'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  FileText, Link2, Plus, RefreshCw, Trash2, Upload, ExternalLink,
} from 'lucide-react';
import FoodSafetyBreadcrumb from '@/components/food-safety/FoodSafetyBreadcrumb';
import {
  MAX_MEETING_MATERIALS,
  MAX_MEETING_PHOTOS,
  MEETING_ACTION_STATUS_LABELS,
  MEETING_MATERIAL_FILE_EXTS,
  MEETING_MATERIAL_KIND_LABELS,
  MEETING_RECORD_STATUS_LABELS,
  maxBytesForMaterialExt,
  type MeetingActionItem,
  type MeetingActionItemStatus,
  type MeetingMaterial,
  type MeetingRecordStatus,
} from '@/lib/kitchen-assurance/meeting-record';
import { downloadMeetingRecordPdf } from '@/lib/kitchen-assurance/meeting-record-pdf';

function extFromFileName(name: string): string {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  const parts = base.split('.');
  if (parts.length < 2) return '';
  return parts.pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
}

interface TopicSuggest {
  id: string;
  nama: string;
  usageCount?: number;
}

interface MeetingRow {
  id: string;
  noDokumen: string;
  title: string;
  topicId: string;
  topicNama: string;
  meetingAt: string;
  location?: string;
  attendees?: string[];
  agenda?: string;
  notes?: string;
  actionItems?: MeetingActionItem[];
  photos?: string[];
  materials?: MeetingMaterial[];
  status: MeetingRecordStatus;
  actionOpenCount?: number;
  actionTotalCount?: number;
  photoCount?: number;
  materialCount?: number;
  createdByName?: string;
  kitchenNama?: string;
  kitchenId?: string;
}

const DAY_NAMES_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'] as const;

function toDatetimeLocalValue(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatMeetingAt(raw?: string | Date): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  const day = DAY_NAMES_ID[d.getDay()];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function emptyAction(): MeetingActionItem {
  return {
    id: `ai-${crypto.randomUUID()}`,
    text: '',
    picName: '',
    dueDate: '',
    status: 'OPEN',
  };
}

const ACCEPT_MATERIALS = MEETING_MATERIAL_FILE_EXTS.map((e) => `.${e}`).join(',');

export default function MeetingRecordsPage() {
  const [rows, setRows] = useState<MeetingRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'' | MeetingRecordStatus>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<MeetingRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [topicNama, setTopicNama] = useState('');
  const [topicSuggestOpen, setTopicSuggestOpen] = useState(false);
  const [topicSuggestions, setTopicSuggestions] = useState<TopicSuggest[]>([]);
  const topicWrapRef = useRef<HTMLDivElement | null>(null);
  const materialFileRef = useRef<HTMLInputElement | null>(null);

  const [form, setForm] = useState({
    title: '',
    meetingAt: toDatetimeLocalValue(),
    location: '',
    attendees: '',
    agenda: '',
    notes: '',
    status: 'DRAFT' as MeetingRecordStatus,
  });
  const [actionItems, setActionItems] = useState<MeetingActionItem[]>([]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [materials, setMaterials] = useState<MeetingMaterial[]>([]);
  const [linkDraft, setLinkDraft] = useState({ title: '', url: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const kitchenId = getActingKitchenId();
      if (kitchenId) params.set('kitchenId', kitchenId);
      if (statusFilter) params.set('status', statusFilter);
      if (q.trim()) params.set('q', q.trim());
      const qs = params.toString() ? `?${params}` : '';
      const res = await fetch(`/api/meeting-records${qs}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat meeting records');
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, q]);

  useEffect(() => {
    void load();
    const onKitchen = () => void load();
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  const canEditFinalDocs = useMemo(() => {
    const role = String(getUser()?.role || '').toUpperCase();
    return role === 'ADMIN' || role === 'OWNER' || role === 'MASTER';
  }, [open]);

  const formReadOnly = Boolean(editing?.status === 'FINAL' && !canEditFinalDocs);

  useEffect(() => {
    if (!topicSuggestOpen) return;
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (topicNama.trim()) params.set('q', topicNama.trim());
        const qs = params.toString() ? `?${params}` : '';
        const res = await fetch(`/api/meeting-topics${qs}`, { headers: actingTenantHeaders() });
        const data = await res.json();
        if (!res.ok) return;
        setTopicSuggestions(Array.isArray(data) ? data : []);
      } catch {
        /* ignore suggest errors */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [topicNama, topicSuggestOpen]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!topicWrapRef.current?.contains(e.target as Node)) setTopicSuggestOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const filteredTopicSuggestions = useMemo(() => {
    const key = topicNama.trim().toLowerCase();
    if (!key) return topicSuggestions.slice(0, 8);
    return topicSuggestions
      .filter((t) => t.nama.toLowerCase().includes(key))
      .slice(0, 8);
  }, [topicNama, topicSuggestions]);

  function resetForm() {
    setEditing(null);
    setTopicNama('');
    setForm({
      title: '',
      meetingAt: toDatetimeLocalValue(),
      location: '',
      attendees: '',
      agenda: '',
      notes: '',
      status: 'DRAFT',
    });
    setActionItems([]);
    setPhotos([]);
    setMaterials([]);
    setLinkDraft({ title: '', url: '' });
  }

  function openCreate() {
    resetForm();
    setOpen(true);
  }

  async function openEdit(row: MeetingRow) {
    try {
      const res = await fetch(`/api/meeting-records/${row.id}`, { headers: actingTenantHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal memuat detail');
      const full = data as MeetingRow;
      setEditing(full);
      setTopicNama(full.topicNama || '');
      setForm({
        title: full.title || '',
        meetingAt: full.meetingAt ? toDatetimeLocalValue(new Date(full.meetingAt)) : toDatetimeLocalValue(),
        location: full.location || '',
        attendees: (full.attendees || []).join('\n'),
        agenda: full.agenda || '',
        notes: full.notes || '',
        status: full.status || 'DRAFT',
      });
      setActionItems(
        (full.actionItems || []).map((a) => ({
          ...a,
          dueDate: a.dueDate || '',
        })),
      );
      setPhotos(full.photos || []);
      setMaterials(full.materials || []);
      setLinkDraft({ title: '', url: '' });
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  async function save() {
    if (saving) return;
    if (formReadOnly) {
      toast.error('Dokumen FINAL hanya bisa diubah oleh Admin/Owner');
      return;
    }
    if (!topicNama.trim()) {
      toast.error('Kategori / Topik Meeting wajib diisi');
      return;
    }
    if (!form.title.trim()) {
      toast.error('Judul pertemuan wajib diisi');
      return;
    }
    setSaving(true);
    try {
      const kitchenId = getActingKitchenId();
      const payload = {
        topicNama: topicNama.trim(),
        title: form.title.trim(),
        meetingAt: form.meetingAt ? new Date(form.meetingAt).toISOString() : new Date().toISOString(),
        location: form.location.trim() || undefined,
        attendees: form.attendees,
        agenda: form.agenda.trim() || undefined,
        notes: form.notes.trim() || undefined,
        status: form.status,
        actionItems: actionItems
          .filter((a) => a.text.trim())
          .map((a) => ({
            id: a.id,
            text: a.text.trim(),
            picName: a.picName.trim(),
            dueDate: a.dueDate || undefined,
            status: a.status,
          })),
        photos,
        materials,
        kitchenId: kitchenId || undefined,
      };

      const url = editing ? `/api/meeting-records/${editing.id}` : '/api/meeting-records';
      const res = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
      toast.success(editing ? `MoM ${data.noDokumen} diperbarui` : `MoM ${data.noDokumen} dibuat`);
      setOpen(false);
      resetForm();
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function exportPdf(row: MeetingRow) {
    try {
      let full = row;
      if (!row.actionItems || !row.materials) {
        const res = await fetch(`/api/meeting-records/${row.id}`, { headers: actingTenantHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Gagal memuat detail');
        full = data as MeetingRow;
      }
      await downloadMeetingRecordPdf({
        noDokumen: full.noDokumen,
        title: full.title,
        topicNama: full.topicNama,
        meetingAt: full.meetingAt,
        location: full.location,
        attendees: full.attendees,
        agenda: full.agenda,
        notes: full.notes,
        actionItems: full.actionItems,
        materials: full.materials,
        photos: full.photos,
        status: full.status,
        createdByName: full.createdByName,
        kitchenNama: full.kitchenNama,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal export PDF');
    }
  }

  function updateAction(idx: number, patch: Partial<MeetingActionItem>) {
    setActionItems((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  async function onMaterialFiles(files: FileList | null) {
    if (!files?.length) return;
    const remaining = MAX_MEETING_MATERIALS - materials.length;
    if (remaining <= 0) {
      toast.error(`Maksimal ${MAX_MEETING_MATERIALS} bahan meeting`);
      return;
    }
    const picked = Array.from(files).slice(0, remaining);
    const next: MeetingMaterial[] = [...materials];
    for (const file of picked) {
      const ext = extFromFileName(file.name);
      if (!MEETING_MATERIAL_FILE_EXTS.includes(ext as typeof MEETING_MATERIAL_FILE_EXTS[number])) {
        toast.error(`Format tidak didukung: ${file.name}`);
        continue;
      }
      const maxBytes = maxBytesForMaterialExt(ext);
      if (file.size > maxBytes) {
        toast.error(`${file.name} terlalu besar (max ${formatBytes(maxBytes)})`);
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('Gagal baca file'));
          reader.readAsDataURL(file);
        });
        next.push({
          id: `mat-${crypto.randomUUID()}`,
          kind: 'FILE',
          title: file.name,
          url: dataUrl,
          mimeType: file.type || undefined,
          sizeBytes: file.size,
          originalName: file.name,
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Gagal baca ${file.name}`);
      }
    }
    setMaterials(next);
    if (materialFileRef.current) materialFileRef.current.value = '';
  }

  function addLinkMaterial() {
    const url = linkDraft.url.trim();
    if (!url) {
      toast.error('URL link wajib diisi');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      toast.error('Link harus diawali http:// atau https://');
      return;
    }
    if (materials.length >= MAX_MEETING_MATERIALS) {
      toast.error(`Maksimal ${MAX_MEETING_MATERIALS} bahan meeting`);
      return;
    }
    setMaterials((prev) => [
      ...prev,
      {
        id: `mat-${crypto.randomUUID()}`,
        kind: 'LINK',
        title: linkDraft.title.trim() || url,
        url,
      },
    ]);
    setLinkDraft({ title: '', url: '' });
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FoodSafetyBreadcrumb items={[{ label: 'Meeting Record' }]} />
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            <FileText className="h-5 w-5" />
            Meeting Record
          </h1>
          <p className="text-sm text-muted-foreground">
            Notulen / MoM keamanan pangan — topik, action item, bahan meeting, dan foto bukti.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1 h-4 w-4" />
            MoM baru
          </Button>
        </div>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      <div className="flex flex-wrap items-center gap-2">
        {([
          { value: '' as const, label: 'Semua' },
          { value: 'DRAFT' as const, label: 'Draft' },
          { value: 'FINAL' as const, label: 'Final' },
        ]).map((s) => (
          <Button
            key={s.label}
            size="sm"
            variant={statusFilter === s.value ? 'default' : 'outline'}
            onClick={() => setStatusFilter(s.value)}
          >
            {s.label}
          </Button>
        ))}
        <input
          className="ml-2 min-w-[180px] flex-1 rounded-md border px-2 py-1.5 text-sm"
          placeholder="Cari judul / no / topik…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left">
            <tr>
              <th className="px-3 py-2">No</th>
              <th className="px-3 py-2">Waktu</th>
              <th className="px-3 py-2">Topik</th>
              <th className="px-3 py-2">Judul</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Bahan</th>
              <th className="px-3 py-2">Foto</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{r.noDokumen}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                  {formatMeetingAt(r.meetingAt)}
                </td>
                <td className="px-3 py-2">{r.topicNama}</td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2 text-xs">
                  {r.actionOpenCount ?? 0}/{r.actionTotalCount ?? 0} open
                </td>
                <td className="px-3 py-2 text-xs">{r.materialCount ?? r.materials?.length ?? 0}</td>
                <td className="px-3 py-2 text-xs">{r.photoCount ?? r.photos?.length ?? 0}</td>
                <td className="px-3 py-2">{MEETING_RECORD_STATUS_LABELS[r.status]}</td>
                <td className="px-3 py-2 text-right space-x-1 whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => void openEdit(r)}>
                    {r.status === 'FINAL' ? 'Lihat' : 'Edit'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void exportPdf(r)}>PDF</Button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  Belum ada meeting record
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={(v) => { if (!v) { setOpen(false); resetForm(); } else setOpen(true); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `${formReadOnly ? 'Lihat' : 'Edit'} ${editing.noDokumen}`
                : 'MoM baru'}
            </DialogTitle>
            <DialogDescription>
              {formReadOnly
                ? 'Dokumen FINAL — hanya Admin/Owner yang dapat mengubah.'
                : 'Isi notulen, action item, bahan meeting (file/link), dan foto bukti.'}
            </DialogDescription>
          </DialogHeader>

          <fieldset disabled={formReadOnly} className="space-y-3 disabled:opacity-90">
            <div ref={topicWrapRef} className="relative">
              <Label>Kategori / Topik Meeting *</Label>
              <input
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={topicNama}
                autoComplete="off"
                placeholder="Ketik topik… (pilih saran atau buat baru)"
                onChange={(e) => {
                  setTopicNama(e.target.value);
                  setTopicSuggestOpen(true);
                }}
                onFocus={() => setTopicSuggestOpen(true)}
              />
              {topicSuggestOpen && filteredTopicSuggestions.length > 0 && !formReadOnly && (
                <ul className="absolute z-20 mt-1 max-h-44 w-full overflow-y-auto rounded-md border bg-white shadow-sm text-sm">
                  {filteredTopicSuggestions.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-muted/80"
                        onClick={() => {
                          setTopicNama(t.nama);
                          setTopicSuggestOpen(false);
                        }}
                      >
                        <span className="font-medium">{t.nama}</span>
                        {t.usageCount != null && (
                          <span className="ml-2 text-xs text-muted-foreground">dipakai {t.usageCount}×</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Ketik baru → otomatis tersimpan ke master topik saat MoM disimpan.
              </p>
            </div>

            <div>
              <Label>Judul pertemuan *</Label>
              <input
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <Label>Tanggal / waktu</Label>
                <input
                  type="datetime-local"
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={form.meetingAt}
                  onChange={(e) => setForm((f) => ({ ...f, meetingAt: e.target.value }))}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatMeetingAt(form.meetingAt ? new Date(form.meetingAt) : undefined)}
                </p>
              </div>
              <div>
                <Label>Status</Label>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                  value={form.status}
                  onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as MeetingRecordStatus }))}
                >
                  <option value="DRAFT">Draft</option>
                  <option value="FINAL">Final</option>
                </select>
              </div>
            </div>

            <div>
              <Label>Lokasi</Label>
              <input
                className="mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
              />
            </div>

            <div>
              <Label>Peserta</Label>
              <Textarea
                placeholder="Satu nama per baris, atau pisah koma"
                value={form.attendees}
                onChange={(e) => setForm((f) => ({ ...f, attendees: e.target.value }))}
              />
            </div>

            <div>
              <Label>Agenda</Label>
              <Textarea
                value={form.agenda}
                onChange={(e) => setForm((f) => ({ ...f, agenda: e.target.value }))}
              />
            </div>

            <div>
              <Label>Notulen / Keputusan</Label>
              <Textarea
                className="mt-1 min-h-[220px]"
                rows={12}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>

            {/* Action items */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Action items</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setActionItems((prev) => [...prev, emptyAction()])}
                >
                  <Plus className="mr-1 h-3 w-3" /> Baris
                </Button>
              </div>
              {actionItems.map((a, idx) => (
                <div key={a.id} className="grid grid-cols-1 gap-2 rounded border bg-muted/20 p-2 sm:grid-cols-12">
                  <div className="sm:col-span-5">
                    <input
                      className="w-full rounded-md border px-2 py-1 text-sm"
                      placeholder="Deskripsi *"
                      value={a.text}
                      onChange={(e) => updateAction(idx, { text: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <input
                      className="w-full rounded-md border px-2 py-1 text-sm"
                      placeholder="PIC"
                      value={a.picName}
                      onChange={(e) => updateAction(idx, { picName: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <input
                      type="date"
                      className="w-full rounded-md border px-2 py-1 text-sm"
                      value={a.dueDate || ''}
                      onChange={(e) => updateAction(idx, { dueDate: e.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <select
                      className="w-full rounded-md border px-2 py-1 text-sm"
                      value={a.status}
                      onChange={(e) => updateAction(idx, { status: e.target.value as MeetingActionItemStatus })}
                    >
                      {Object.entries(MEETING_ACTION_STATUS_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex sm:col-span-1 sm:justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setActionItems((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              {!actionItems.length && (
                <p className="text-xs text-muted-foreground">Belum ada action item.</p>
              )}
            </div>

            {/* Materials */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="text-sm font-medium">
                  Bahan meeting ({materials.length}/{MAX_MEETING_MATERIALS})
                </Label>
                <div className="flex gap-2">
                  <input
                    ref={materialFileRef}
                    type="file"
                    className="hidden"
                    accept={ACCEPT_MATERIALS}
                    multiple
                    onChange={(e) => void onMaterialFiles(e.target.files)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={materials.length >= MAX_MEETING_MATERIALS}
                    onClick={() => materialFileRef.current?.click()}
                  >
                    <Upload className="mr-1 h-3 w-3" /> Upload file
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                PDF, Word, Excel, PPT, gambar, video pendek (mp4/webm). Atau tempel link YouTube/web.
              </p>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-5">
                <input
                  className="rounded-md border px-2 py-1.5 text-sm sm:col-span-2"
                  placeholder="Judul link (opsional)"
                  value={linkDraft.title}
                  onChange={(e) => setLinkDraft((d) => ({ ...d, title: e.target.value }))}
                />
                <input
                  className="rounded-md border px-2 py-1.5 text-sm sm:col-span-2"
                  placeholder="https://…"
                  value={linkDraft.url}
                  onChange={(e) => setLinkDraft((d) => ({ ...d, url: e.target.value }))}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={materials.length >= MAX_MEETING_MATERIALS}
                  onClick={addLinkMaterial}
                >
                  <Link2 className="mr-1 h-3 w-3" /> Link
                </Button>
              </div>

              <ul className="space-y-1">
                {materials.map((m, idx) => (
                  <li key={m.id} className="flex items-start justify-between gap-2 rounded border bg-white px-2 py-1.5 text-sm">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{m.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {MEETING_MATERIAL_KIND_LABELS[m.kind]}
                        {m.kind === 'FILE' && m.sizeBytes != null ? ` · ${formatBytes(m.sizeBytes)}` : ''}
                        {m.kind === 'LINK' ? (
                          <a
                            href={m.url}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 inline-flex items-center text-blue-700 hover:underline"
                          >
                            buka <ExternalLink className="ml-0.5 h-3 w-3" />
                          </a>
                        ) : m.url.startsWith('/api/media/') || m.url.startsWith('http') ? (
                          <a
                            href={m.url}
                            target="_blank"
                            rel="noreferrer"
                            className="ml-2 inline-flex items-center text-blue-700 hover:underline"
                          >
                            unduh <ExternalLink className="ml-0.5 h-3 w-3" />
                          </a>
                        ) : (
                          <span className="ml-2">siap diunggah</span>
                        )}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setMaterials((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>

            <PhotoUploadField
              label="Foto bukti"
              hint={`Maksimal ${MAX_MEETING_PHOTOS} foto. Klik untuk perbesar.`}
              photos={photos}
              onChange={setPhotos}
              maxPhotos={MAX_MEETING_PHOTOS}
              disabled={formReadOnly}
            />
          </fieldset>

          <DialogFooter className="gap-2">
            {editing && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void exportPdf({
                  ...editing,
                  title: form.title,
                  topicNama,
                  meetingAt: form.meetingAt ? new Date(form.meetingAt).toISOString() : editing.meetingAt,
                  location: form.location,
                  attendees: form.attendees.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
                  agenda: form.agenda,
                  notes: form.notes,
                  status: form.status,
                  actionItems: actionItems.filter((a) => a.text.trim()),
                  materials,
                  photos,
                })}
              >
                Export PDF
              </Button>
            )}
            <Button variant="outline" onClick={() => { setOpen(false); resetForm(); }}>
              {formReadOnly ? 'Tutup' : 'Batal'}
            </Button>
            {!formReadOnly && (
              <Button onClick={() => void save()} disabled={saving || !form.title.trim() || !topicNama.trim()}>
                {saving ? 'Menyimpan…' : 'Simpan'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
