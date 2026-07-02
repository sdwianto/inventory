'use client';

import type { JsonObject } from '@/types/json';
import { str, asObject, asArray, num } from '@/types/json';
import type { SessionUser } from '@/types/auth';
import type { MaintenancePriority, MaintenanceRequestStatus } from '@/types/maintenance';
import { useEffect, useMemo, useState, Suspense } from 'react';
import { useCursorList } from '@/lib/hooks/use-cursor-list';
import AppShell from '@/components/AppShell';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/format';
import { getUser } from '@/lib/auth-client';
import { fetchJson } from '@/lib/fetch-json';
import {
  useAssets,
  useInvalidateMaintenance,
} from '@/lib/hooks/use-maintenance';
import {
  EMPTY_WR,
  WR_APPROVE_ROLES,
  WR_CREATE_ROLES,
  WR_PRIORITY_LABELS,
  WR_PRIORITY_STYLE,
  WR_PROGRESS_ROLES,
  WR_STATUS_LABELS,
  WR_STATUS_STYLE,
  RESOLUTION_TYPE_LABELS,
  WR_SOURCE_LABELS,
} from '@/lib/maintenance/constants';
import {
  Wrench, Plus, Send, CheckCircle2, XCircle, Play, Flag, Lock, RefreshCw, ImageIcon,
  ShoppingBag, ArrowUpFromLine, HardHat,
} from 'lucide-react';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import ServiceOrderDialog from '@/components/maintenance/ServiceOrderDialog';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';

function MaintenancePermintaanPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const invalidate = useInvalidateMaintenance();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<JsonObject>(EMPTY_WR);
  const [editing, setEditing] = useState<JsonObject | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [completeNote, setCompleteNote] = useState('');
  const [photosCache, setPhotosCache] = useState<Record<string, string[]>>({});
  const [serviceWr, setServiceWr] = useState<JsonObject | null>(null);

  const wrUrl = useMemo(
    () => (statusFilter ? `/api/maintenance-requests?status=${encodeURIComponent(statusFilter)}` : '/api/maintenance-requests'),
    [statusFilter],
  );
  const {
    items: list,
    loading: listLoading,
    hasMore,
    loadMore,
    loadingMore,
    error,
    reload,
  } = useCursorList<JsonObject>(wrUrl, { limit: 100 });
  const { data: assets = [] } = useAssets({ enabled: showForm || list.length > 0 });

  const canCreate = WR_CREATE_ROLES.includes(String(user?.role || '') as typeof WR_CREATE_ROLES[number])
    || user?.role === 'MASTER';
  const canApprove = WR_APPROVE_ROLES.includes(String(user?.role || '') as typeof WR_APPROVE_ROLES[number])
    || user?.role === 'MASTER';
  const canProgress = WR_PROGRESS_ROLES.includes(String(user?.role || '') as typeof WR_PROGRESS_ROLES[number])
    || user?.role === 'MASTER';

  useEffect(() => {
    setUser(getUser());
  }, []);

  const activeAssets = assets.filter((a) => str(a.status) !== 'DISPOSED');

  const openNew = () => {
    setEditing(null);
    setForm({
      ...EMPTY_WR,
      assetId: activeAssets[0]?.id ? str(activeAssets[0].id) : '',
      photos: [],
    });
    setShowForm(true);
  };

  const openEdit = async (row: JsonObject) => {
    try {
      const full = await fetchJson<JsonObject>(`/api/maintenance-requests/${str(row.id)}`);
      setEditing(full);
      setForm({
        assetId: str(full.assetId),
        priority: str(full.priority, 'MEDIUM'),
        judul: str(full.judul),
        deskripsi: str(full.deskripsi),
        photos: asArray(full.photos).map(String),
      });
      setShowForm(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat permintaan');
    }
  };

  const loadPhotos = async (id: string) => {
    if (photosCache[id]) return photosCache[id];
    const full = await fetchJson<JsonObject>(`/api/maintenance-requests/${id}`);
    const photos = asArray(full.photos).map(String);
    setPhotosCache((prev) => ({ ...prev, [id]: photos }));
    return photos;
  };

  const wrPhotos = asArray(form.photos).map(String);
  const setWrPhotos = (photos: string[]) => setForm({ ...form, photos });

  const save = async () => {
    if (!str(form.assetId)) { toast.error('Pilih aset'); return; }
    if (!str(form.judul).trim()) { toast.error('Judul wajib diisi'); return; }
    setSaving(true);
    try {
      const url = editing ? `/api/maintenance-requests/${str(editing.id)}` : '/api/maintenance-requests';
      await fetchJson(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetId: form.assetId,
          priority: form.priority,
          judul: form.judul,
          deskripsi: form.deskripsi,
          photos: wrPhotos,
        }),
      });
      toast.success(editing ? 'Permintaan diperbarui' : 'Permintaan dibuat');
      setShowForm(false);
      invalidate();
      void reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    }
    setSaving(false);
  };

  const action = async (id: string, actionType: string, extra: JsonObject = {}) => {
    try {
      await fetchJson(`/api/maintenance-requests/${id}/${actionType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extra),
      });
      const labels: Record<string, string> = {
        'request-approval': 'Diajukan ke admin',
        approve: 'Permintaan disetujui',
        reject: 'Permintaan ditolak',
        start: 'Pekerjaan dimulai',
        complete: 'Pekerjaan selesai',
        close: 'Permintaan ditutup',
        cancel: 'Permintaan dibatalkan',
      };
      toast.success(labels[actionType] || 'Berhasil');
      invalidate();
      void reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  };

  const renderActions = (row: JsonObject) => {
    const status = str(row.status);
    const id = str(row.id);
    const isOwner = str(asObject(row.createdBy).userId) === str(user?.id);

    if (status === 'DRAFT' && canCreate && isOwner) {
      return (
        <>
          <Button size="sm" variant="outline" className="h-8" onClick={() => openEdit(row)}>
            Edit
          </Button>
          <Button size="sm" className="h-8 bg-blue-600 hover:bg-blue-700" onClick={() => void action(id, 'request-approval')}>
            <Send className="w-3.5 h-3.5 mr-1" /> Ajukan
          </Button>
        </>
      );
    }

    if (status === 'PENDING_APPROVAL' && canApprove) {
      return (
        <>
          <Button size="sm" className="h-8 bg-green-600 hover:bg-green-700" onClick={() => void action(id, 'approve')}>
            <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Setujui
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-red-700 border-red-200"
            onClick={() => void action(id, 'reject', { reason: 'Ditolak admin' })}
          >
            <XCircle className="w-3.5 h-3.5 mr-1" /> Tolak
          </Button>
        </>
      );
    }

    if (status === 'APPROVED' && canProgress) {
      return (
        <Button size="sm" className="h-8" onClick={() => void action(id, 'start')}>
          <Play className="w-3.5 h-3.5 mr-1" /> Mulai Kerja
        </Button>
      );
    }

    if (status === 'IN_PROGRESS' && canProgress) {
      return (
        <Button
          size="sm"
          className="h-8 bg-indigo-600 hover:bg-indigo-700"
          onClick={() => {
            setExpandedId(id);
            setCompleteNote('');
          }}
        >
          <Flag className="w-3.5 h-3.5 mr-1" /> Selesai
        </Button>
      );
    }

    if (status === 'COMPLETED' && canApprove) {
      return (
        <Button size="sm" className="h-8" onClick={() => void action(id, 'close')}>
          <Lock className="w-3.5 h-3.5 mr-1" /> Tutup
        </Button>
      );
    }

    return null;
  };

  const renderResolution = (row: JsonObject) => {
    const status = str(row.status);
    const resolutionType = str(row.resolutionType);
    const showActions = ['APPROVED', 'IN_PROGRESS'].includes(status) && canProgress && !resolutionType;
    const showLinks = resolutionType && ['APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED'].includes(status);

    if (!showActions && !showLinks) return null;

    if (showLinks) {
      const label = RESOLUTION_TYPE_LABELS[resolutionType] || resolutionType;
      return (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm space-y-1">
          <p className="font-medium text-slate-700">Penyelesaian: {label}</p>
          {str(row.linkedPoNo) && (
            <p>
              PO:{' '}
              <Link href="/pembelian-po" className="text-orange-600 hover:underline font-mono">
                {str(row.linkedPoNo)}
              </Link>
            </p>
          )}
          {str(row.linkedGrnNo) && (
            <p>
              GRN:{' '}
              <Link href="/penerimaan" className="text-orange-600 hover:underline font-mono">
                {str(row.linkedGrnNo)}
              </Link>
            </p>
          )}
          {str(row.linkedReleaseNo) && (
            <p>
              Release:{' '}
              <Link href="/stok/release" className="text-orange-600 hover:underline font-mono">
                {str(row.linkedReleaseNo)}
              </Link>
            </p>
          )}
          {str(row.linkedServiceOrderNo) && (
            <p>Service Order: <span className="font-mono">{str(row.linkedServiceOrderNo)}</span></p>
          )}
          {str(row.autoClosedBy) && status === 'CLOSED' && (
            <p className="text-xs text-slate-500">Ditutup otomatis setelah {str(row.autoClosedBy)}</p>
          )}
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-orange-200 bg-orange-50/50 px-3 py-3 space-y-2">
        <p className="text-sm font-medium text-slate-700">Tindaklanjut maintenance</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 bg-white"
            onClick={() => router.push(`/pembelian-po?wrId=${str(row.id)}`)}
          >
            <ShoppingBag className="w-3.5 h-3.5 mr-1" /> PO Vendor
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 bg-white"
            onClick={() => router.push(`/stok/release?wrId=${str(row.id)}`)}
          >
            <ArrowUpFromLine className="w-3.5 h-3.5 mr-1" /> Release Stok
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 bg-white"
            onClick={() => setServiceWr(row)}
          >
            <HardHat className="w-3.5 h-3.5 mr-1" /> Jasa Perbaikan
          </Button>
        </div>
      </div>
    );
  };

  return (
    <AppShell>
      <div className="p-4 md:p-6 space-y-4">
        <OperationalScopeBar />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Wrench className="w-6 h-6" /> Permintaan Maintenance
            </h1>
            <p className="text-sm text-slate-500">
              Laporkan kerusakan aset → approval admin → siap ditindaklanjuti (PO / jasa / spare part).
            </p>
          </div>
          {canCreate && (
            <Button onClick={openNew} className="bg-orange-500 hover:bg-orange-600" disabled={!activeAssets.length}>
              <Plus className="w-4 h-4 mr-1" /> Buat Permintaan
            </Button>
          )}
        </div>

        {!activeAssets.length && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Belum ada aset terdaftar. Tambahkan aset di menu Register Aset terlebih dahulu.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Select value={statusFilter || 'ALL'} onValueChange={(v) => setStatusFilter(v === 'ALL' ? '' : v)}>
            <SelectTrigger className="w-[200px]"><SelectValue placeholder="Filter status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Semua status</SelectItem>
              {Object.entries(WR_STATUS_LABELS).map(([k, label]) => (
                <SelectItem key={k} value={k}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void reload()} disabled={listLoading}>
            <RefreshCw className={`w-4 h-4 ${listLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 flex flex-wrap items-center justify-between gap-2">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => void reload()}>Coba lagi</Button>
          </div>
        )}

        <div className="space-y-3">
          {listLoading && !list.length && (
            <div className="text-sm text-slate-500 py-8 text-center">Memuat permintaan…</div>
          )}
          {!listLoading && list.length === 0 && (
            <div className="rounded-lg border bg-white p-8 text-center text-slate-500">
              Belum ada permintaan maintenance
            </div>
          )}
          {list.map((row) => {
            const status = str(row.status, 'DRAFT') as MaintenanceRequestStatus;
            const priority = str(row.priority, 'MEDIUM') as MaintenancePriority;
            const isOpen = expandedId === str(row.id);
            return (
              <div key={str(row.id)} className="rounded-lg border bg-white p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-500">{str(row.noWR)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${WR_STATUS_STYLE[status]}`}>
                        {WR_STATUS_LABELS[status]}
                      </span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${WR_PRIORITY_STYLE[priority]}`}>
                        {WR_PRIORITY_LABELS[priority]}
                      </span>
                      {str(row.sourceType) === 'PREVENTIVE' && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-violet-100 text-violet-800">
                          {WR_SOURCE_LABELS.PREVENTIVE}
                          {str(row.noSchedule) ? ` · ${str(row.noSchedule)}` : ''}
                        </span>
                      )}
                    </div>
                    <h3 className="font-semibold text-base">{str(row.judul)}</h3>
                    <p className="text-sm text-slate-600">
                      Aset: <strong>{str(row.assetKode)}</strong> — {str(row.assetNama)}
                      {str(row.assetLokasi) ? ` · ${str(row.assetLokasi)}` : ''}
                    </p>
                    {str(row.deskripsi) && (
                      <p className="text-sm text-slate-500">{str(row.deskripsi)}</p>
                    )}
                    <p className="text-xs text-slate-400">
                      Dibuat {formatDateTime(str(row.createdAt))} · {str(asObject(row.createdBy).userName, '—')}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">{renderActions(row)}</div>
                </div>

                {isOpen && (
                  <div className="border-t pt-3 space-y-2">
                    <Label>Catatan penyelesaian</Label>
                    <Textarea value={completeNote} onChange={(e) => setCompleteNote(e.target.value)} rows={2} />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          void action(str(row.id), 'complete', { catatanPenyelesaian: completeNote });
                          setExpandedId(null);
                        }}
                      >
                        Konfirmasi Selesai
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setExpandedId(null)}>Batal</Button>
                    </div>
                  </div>
                )}

                {str(row.rejectReason) && status === 'REJECTED' && (
                  <p className="text-sm text-red-600">Alasan ditolak: {str(row.rejectReason)}</p>
                )}
                {str(row.catatanPenyelesaian) && (
                  <p className="text-sm text-green-700 bg-green-50 rounded px-2 py-1">
                    Penyelesaian: {str(row.catatanPenyelesaian)}
                  </p>
                )}
                {renderResolution(row)}
                {num(row.photoCount) > 0 && (
                  <div className="space-y-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => void loadPhotos(str(row.id))}
                    >
                      <ImageIcon className="w-3.5 h-3.5 mr-1" />
                      Lihat {num(row.photoCount)} foto
                    </Button>
                    {photosCache[str(row.id)]?.length ? (
                      <div className="flex flex-wrap gap-2">
                        {photosCache[str(row.id)].map((src, i) => (
                          <a
                            key={`${str(row.id)}-photo-${i}`}
                            href={src}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block w-20 h-20 rounded-lg border overflow-hidden hover:ring-2 hover:ring-orange-400"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={src} alt={`Foto ${i + 1}`} className="w-full h-full object-cover" />
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
          {hasMore && (
            <div className="pt-2 text-center">
              <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? 'Memuat…' : `Muat lebih (${list.length} ditampilkan)`}
              </Button>
            </div>
          )}
        </div>

        <Dialog open={showForm} onOpenChange={setShowForm}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? 'Edit Permintaan' : 'Permintaan Maintenance Baru'}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 py-2">
              <div>
                <Label>Aset *</Label>
                <Select value={str(form.assetId)} onValueChange={(v) => setForm({ ...form, assetId: v })}>
                  <SelectTrigger><SelectValue placeholder="Pilih aset" /></SelectTrigger>
                  <SelectContent>
                    {activeAssets.map((a) => (
                      <SelectItem key={str(a.id)} value={str(a.id)}>
                        {str(a.kode)} — {str(a.nama)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Prioritas</Label>
                <Select value={str(form.priority, 'MEDIUM')} onValueChange={(v) => setForm({ ...form, priority: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(WR_PRIORITY_LABELS).map(([k, label]) => (
                      <SelectItem key={k} value={k}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Judul *</Label>
                <Input value={str(form.judul)} onChange={(e) => setForm({ ...form, judul: e.target.value })} />
              </div>
              <div>
                <Label>Deskripsi masalah</Label>
                <Textarea
                  value={str(form.deskripsi)}
                  onChange={(e) => setForm({ ...form, deskripsi: e.target.value })}
                  rows={3}
                  placeholder="Gejala, kondisi, kebutuhan perbaikan..."
                />
              </div>
              <PhotoUploadField
                label="Foto kondisi / kerusakan"
                hint="Opsional. Maks. 5 foto, otomatis dikompres."
                photos={wrPhotos}
                onChange={setWrPhotos}
                maxPhotos={5}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowForm(false)}>Batal</Button>
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? 'Menyimpan...' : editing ? 'Simpan' : 'Simpan Draft'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ServiceOrderDialog
          open={!!serviceWr}
          onOpenChange={(open) => { if (!open) setServiceWr(null); }}
          wr={serviceWr}
          onSuccess={() => {
            invalidate();
            void reload();
          }}
        />
      </div>
    </AppShell>
  );
}

export default function MaintenancePermintaanPage() {
  return (
    <Suspense
      fallback={(
        <AppShell>
          <div className="p-6 text-sm text-slate-500">Memuat permintaan maintenance…</div>
        </AppShell>
      )}
    >
      <MaintenancePermintaanPageContent />
    </Suspense>
  );
}
