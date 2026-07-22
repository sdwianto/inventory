'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import PhotoUploadField from '@/components/maintenance/PhotoUploadField';
import { Truck, Plus, RefreshCw, Eye, Trash2, Car } from 'lucide-react';
import {
  DIST_STATUS_LABELS,
  DIST_UI_STATUS_NEXT,
  DIST_UI_STATUS_NEXT_LABEL,
  loadingLabel,
  resolveDistLoadings,
  type DistributionStatus,
  type DistributionArmada,
  type DistributionLoading,
} from '@/lib/food-production/distribution';
import {
  KATEGORI_PORSI_OPTIONS,
  KATEGORI_PORSI_SHORT,
  compareJamKirim,
  type ServicePointDrop,
  type ServicePointPorsiByKategori,
} from '@/lib/food-production/service-point';
import { Input } from '@/components/ui/input';
import Link from 'next/link';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);
/** Manage + DRIVER — update status kirim/selesai. */
const STATUS_ROLES = new Set([...MANAGE_ROLES, 'DRIVER']);

interface ResultOpt {
  id: string;
  noDokumen: string;
  tanggal: string;
  productionPlanId?: string;
  productionPlanNo?: string;
  kitchenNama?: string;
  status: string;
  summary?: { actualPorsiTotal?: number };
}

interface SpOpt {
  id: string;
  kode?: string;
  nama: string;
  kapasitasPorsi?: number;
  jamKirim?: string;
  porsiByKategori?: ServicePointPorsiByKategori;
  drops?: ServicePointDrop[];
}

interface ArmadaOpt {
  id: string;
  kode: string;
  nama: string;
  platNomor?: string;
  kapasitasPorsi?: number;
  aktif?: boolean;
}

interface FleetDraft {
  key: string;
  armadaId: string;
  servicePointIds: string[];
}

interface LoadingDraft {
  key: string;
  urutan: number;
  label: string;
  jamStart: string;
  jamMax: string;
  fleets: FleetDraft[];
}

interface DistLine {
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  kapasitasPorsi?: number;
  jamKirim?: string;
  porsiByKategori?: ServicePointPorsiByKategori;
  armadaId?: string;
  menuId?: string;
  menuKode?: string;
  menuNama?: string;
  recipeId?: string;
  recipeKode?: string;
  recipeNama?: string;
  finishedGoodProductId?: string;
  finishedGoodKode?: string;
  finishedGoodNama?: string;
  qtyPorsi: number;
  qtyDikirim?: number;
  qtyDiterima?: number;
  qtyDikembalikan?: number;
  notes?: string;
}

interface DistHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  userName?: string;
  note?: string;
  movementQtyPorsi?: number;
  movementLineCount?: number;
  photoUrls?: string[];
  lineActuals?: Array<{
    servicePointId: string;
    servicePointNama?: string;
    qty?: number;
    qtyDiterima?: number;
    qtyDikembalikan?: number;
    notes?: string;
  }>;
}

interface DistRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  sourceType: 'PLAN' | 'RESULT';
  productionPlanId?: string;
  productionPlanNo?: string;
  productionResultId?: string;
  productionResultNo?: string;
  kitchenNama?: string;
  status: DistributionStatus;
  lines?: DistLine[];
  loadings?: DistributionLoading[];
  armadas?: DistributionArmada[];
  history?: DistHistoryEntry[];
  catatan?: string;
  summary?: {
    lineCount: number;
    qtyPorsiTotal: number;
    qtyDikirimTotal?: number;
    qtyDiterimaTotal?: number;
    qtyDikembalikanTotal?: number;
    servicePointCount: number;
    armadaCount?: number;
    loadingCount?: number;
  };
}

interface StatusLineQty {
  key: string;
  servicePointId: string;
  servicePointKode?: string;
  servicePointNama?: string;
  menuId?: string;
  recipeId?: string;
  finishedGoodProductId?: string;
  menuLabel: string;
  kapasitasPorsi?: number;
  qtyAlokasi: number;
  qtyDikirim: number;
  /** For Dikirim step: qty to ship. For Selesai: ignored in favor of diterima/kembali. */
  qty: number;
  qtyDiterima: number;
  qtyDikembalikan: number;
  note: string;
}

function DistributionPageContent() {
  const searchParams = useSearchParams();
  const { canManage, canUpdateStatus } = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return {
      canManage: MANAGE_ROLES.has(role),
      canUpdateStatus: STATUS_ROLES.has(role),
    };
  }, []);

  const [rows, setRows] = useState<DistRow[]>([]);
  const [results, setResults] = useState<ResultOpt[]>([]);
  const [points, setPoints] = useState<SpOpt[]>([]);
  const [armadas, setArmadas] = useState<ArmadaOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<DistRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [statusTarget, setStatusTarget] = useState<{ row: DistRow; next: DistributionStatus } | null>(null);
  const [statusPhotos, setStatusPhotos] = useState<string[]>([]);
  const [statusLineQtys, setStatusLineQtys] = useState<StatusLineQty[]>([]);
  const [statusSaving, setStatusSaving] = useState(false);
  const [resultId, setResultId] = useState('');
  const [loadingDrafts, setLoadingDrafts] = useState<LoadingDraft[]>([]);
  const [createNote, setCreateNote] = useState('');
  const [saving, setSaving] = useState(false);
  const deepLinkHandled = useRef<string | null>(null);

  const pointsById = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const armadasById = useMemo(() => new Map(armadas.map((a) => [a.id, a])), [armadas]);

  /** Semua titik aktif, urut Jam Makan (untuk checkbox di tiap armada). */
  const sortedPoints = useMemo(
    () => [...points].sort((a, b) => {
      const byJam = compareJamKirim(a.jamKirim, b.jamKirim);
      if (byJam !== 0) return byJam;
      return a.nama.localeCompare(b.nama, 'id');
    }),
    [points],
  );

  const assignedPointIds = useMemo(
    () => new Set(loadingDrafts.flatMap((L) => L.fleets.flatMap((f) => f.servicePointIds))),
    [loadingDrafts],
  );

  const selectedPointIds = useMemo(
    () => [...assignedPointIds],
    [assignedPointIds],
  );

  function kategoriSummaryForPoints(ids: string[]): ServicePointPorsiByKategori {
    return ids.reduce<ServicePointPorsiByKategori>((acc, id) => {
      const map = pointsById.get(id)?.porsiByKategori;
      if (!map) return acc;
      for (const opt of KATEGORI_PORSI_OPTIONS) {
        const n = Number(map[opt.value]) || 0;
        if (n > 0) acc[opt.value] = (Number(acc[opt.value]) || 0) + n;
      }
      return acc;
    }, {});
  }

  function formatKategoriShort(map: ServicePointPorsiByKategori | undefined): string {
    if (!map) return '—';
    const parts = KATEGORI_PORSI_OPTIONS
      .map((o) => {
        const n = Number(map[o.value]) || 0;
        if (!(n > 0)) return null;
        const short = KATEGORI_PORSI_SHORT[o.value] || o.label;
        return `${short} : ${n.toLocaleString('id-ID')}`;
      })
      .filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }

  /**
   * HSL tidak muncul di packing baru bila:
   * - pernah Diterima (COMPLETED / ada di history), atau
   * - masih punya DST aktif (bukan Dikembalikan).
   */
  const blockedResultIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of rows) {
      if (!d.productionResultId) continue;
      if (d.status !== 'CANCELLED') {
        ids.add(d.productionResultId);
        continue;
      }
      // Di cabang ini status sudah CANCELLED — cek jejak pernah selesai/diterima di history.
      const everReceived = (d.history || []).some((h) => h.toStatus === 'COMPLETED');
      if (everReceived) ids.add(d.productionResultId);
    }
    return ids;
  }, [rows]);

  const availableResults = useMemo(
    () => results.filter((r) => !blockedResultIds.has(r.id)),
    [results, blockedResultIds],
  );

  function defaultQtyForStatus(line: DistLine, next: DistributionStatus): number {
    if (next === 'PROCESSING') return Number(line.qtyDikirim ?? line.qtyPorsi) || 0;
    if (next === 'COMPLETED') return Number(line.qtyDiterima ?? line.qtyDikirim ?? line.qtyPorsi) || 0;
    return Number(line.qtyDikembalikan ?? line.qtyDiterima ?? line.qtyDikirim ?? line.qtyPorsi) || 0;
  }

  function buildStatusLineQtys(row: DistRow, next: DistributionStatus): StatusLineQty[] {
    return (row.lines || []).map((line, idx) => {
      const qtyDikirim = Number(line.qtyDikirim ?? line.qtyPorsi) || 0;
      const qtyDiterima = next === 'COMPLETED'
        ? (line.qtyDiterima != null ? Number(line.qtyDiterima) : qtyDikirim)
        : Number(line.qtyDiterima) || 0;
      const qtyDikembalikan = next === 'COMPLETED'
        ? (line.qtyDikembalikan != null ? Number(line.qtyDikembalikan) : 0)
        : Number(line.qtyDikembalikan) || 0;
      return {
        key: `${line.servicePointId}|${line.menuId || ''}|${line.recipeId || ''}|${line.finishedGoodProductId || ''}|${idx}`,
        servicePointId: line.servicePointId,
        servicePointKode: line.servicePointKode,
        servicePointNama: line.servicePointNama,
        menuId: line.menuId,
        recipeId: line.recipeId,
        finishedGoodProductId: line.finishedGoodProductId,
        menuLabel:
          line.finishedGoodNama
          || line.menuNama
          || line.recipeNama
          || line.finishedGoodKode
          || line.menuKode
          || line.recipeKode
          || '—',
        kapasitasPorsi: line.kapasitasPorsi,
        qtyAlokasi: Number(line.qtyPorsi) || 0,
        qtyDikirim,
        qty: defaultQtyForStatus(line, next),
        qtyDiterima,
        qtyDikembalikan,
        note: line.notes || '',
      };
    });
  }

  async function openStatusDialog(row: DistRow, next: DistributionStatus) {
    setStatusPhotos([]);
    let full = row;
    if (!row.lines?.length) {
      try {
        const res = await fetch(`/api/distribution-orders/${row.id}`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        });
        const data = await res.json();
        if (res.ok) full = data as DistRow;
      } catch {
        /* use row as-is */
      }
    }
    setStatusTarget({ row: full, next });
    setStatusLineQtys(buildStatusLineQtys(full, next));
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hdr = { ...actingTenantHeaders(), ...actingKitchenHeaders() };
      const [dRes, rRes, sRes, aRes] = await Promise.all([
        fetch('/api/distribution-orders', { headers: hdr }),
        fetch('/api/production-results?status=COMPLETED', { headers: hdr }),
        fetch('/api/service-points?aktif=1', { headers: hdr }),
        fetch('/api/armadas?aktif=1', { headers: hdr }),
      ]);
      const dData = await dRes.json();
      const rData = await rRes.json();
      const sData = await sRes.json();
      const aData = await aRes.json();
      if (!dRes.ok) throw new Error(dData?.error || 'Gagal memuat');
      setRows(Array.isArray(dData) ? dData : []);
      setResults(Array.isArray(rData) ? rData : []);
      setPoints(Array.isArray(sData) ? sData : []);
      setArmadas(Array.isArray(aData) ? aData : []);
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

  useEffect(() => {
    const fromPlan = searchParams.get('productionPlanId');
    const fromResult = searchParams.get('productionResultId');
    const key = fromResult ? `R:${fromResult}` : fromPlan ? `P:${fromPlan}` : null;
    if (!key) return;
    if (deepLinkHandled.current === key) return;
    if (loading) return;

    if (fromResult) {
      deepLinkHandled.current = key;
      if (blockedResultIds.has(fromResult)) {
        toast.message('HSL ini sudah / sedang diproses distribusi — tidak perlu packing ulang');
        return;
      }
      setResultId(fromResult);
      setOpen(true);
      return;
    }
    if (!fromPlan) return;

    const hsl = results.find(
      (r) => r.productionPlanId === fromPlan && r.status === 'COMPLETED' && !blockedResultIds.has(r.id),
    );
    deepLinkHandled.current = key;
    if (hsl) {
      setResultId(hsl.id);
      setOpen(true);
      toast.message(`Distribusi dari HSL ${hsl.noDokumen}`);
    } else {
      toast.message('Belum ada HSL siap packing untuk rencana ini — selesaikan Hasil Produksi dulu');
    }
  }, [searchParams, results, loading, blockedResultIds]);

  // Clear selected HSL if it becomes unavailable.
  useEffect(() => {
    if (resultId && blockedResultIds.has(resultId)) {
      setResultId('');
    }
  }, [resultId, blockedResultIds]);

  function addLoadingDraft() {
    const urutan = loadingDrafts.length + 1;
    const defaults = urutan === 1
      ? { jamStart: '06:30', jamMax: '07:00' }
      : urutan === 2
        ? { jamStart: '07:30', jamMax: '08:00' }
        : { jamStart: '08:30', jamMax: '09:00' };
    setLoadingDrafts((prev) => [
      ...prev,
      {
        key: `load-${Date.now()}`,
        urutan,
        label: loadingLabel(urutan),
        jamStart: defaults.jamStart,
        jamMax: defaults.jamMax,
        fleets: [],
      },
    ]);
  }

  function updateLoadingDraft(key: string, patch: Partial<LoadingDraft>) {
    setLoadingDrafts((prev) => prev.map((L) => (L.key === key ? { ...L, ...patch } : L)));
  }

  function removeLoadingDraft(key: string) {
    setLoadingDrafts((prev) => prev
      .filter((L) => L.key !== key)
      .map((L, i) => ({ ...L, urutan: i + 1, label: L.label || loadingLabel(i + 1) })));
  }

  function addFleetToLoading(loadingKey: string) {
    const loading = loadingDrafts.find((L) => L.key === loadingKey);
    // Armada boleh dipakai ulang di loading lain; unik hanya dalam satu gelombang.
    const usedInLoading = new Set((loading?.fleets || []).map((f) => f.armadaId));
    const pick = armadas.find((a) => !usedInLoading.has(a.id));
    if (!pick) {
      toast.message(armadas.length
        ? 'Semua armada sudah dipakai di loading ini'
        : 'Belum ada armada — buat di menu Armada dulu');
      return;
    }
    setLoadingDrafts((prev) => prev.map((L) => {
      if (L.key !== loadingKey) return L;
      return {
        ...L,
        fleets: [
          ...L.fleets,
          {
            key: `${pick.id}-${Date.now()}`,
            armadaId: pick.id,
            servicePointIds: [],
          },
        ],
      };
    }));
  }

  function setFleetArmada(loadingKey: string, fleetKey: string, armadaId: string) {
    setLoadingDrafts((prev) => prev.map((L) => {
      if (L.key !== loadingKey) return L;
      return {
        ...L,
        fleets: L.fleets.map((f) => (f.key === fleetKey ? { ...f, armadaId } : f)),
      };
    }));
  }

  function toggleFleetPoint(loadingKey: string, fleetKey: string, spId: string) {
    setLoadingDrafts((prev) => prev.map((L) => ({
      ...L,
      fleets: L.fleets.map((f) => {
        const isTarget = L.key === loadingKey && f.key === fleetKey;
        if (!isTarget) {
          return { ...f, servicePointIds: f.servicePointIds.filter((id) => id !== spId) };
        }
        const has = f.servicePointIds.includes(spId);
        return {
          ...f,
          servicePointIds: has
            ? f.servicePointIds.filter((id) => id !== spId)
            : [...f.servicePointIds, spId],
        };
      }),
    })));
  }

  function removeFleetFromLoading(loadingKey: string, fleetKey: string) {
    setLoadingDrafts((prev) => prev.map((L) => (
      L.key === loadingKey
        ? { ...L, fleets: L.fleets.filter((f) => f.key !== fleetKey) }
        : L
    )));
  }

  function resetCreateForm() {
    setResultId('');
    setLoadingDrafts([]);
    setCreateNote('');
  }

  async function create() {
    if (!resultId) {
      toast.error('Pilih hasil produksi');
      return;
    }
    if (!armadas.length) {
      toast.error('Buat Armada Kendaraan dulu sebelum packing');
      return;
    }

    const drafts = loadingDrafts.map((L) => ({
      ...L,
      fleets: L.fleets.filter((f) => f.armadaId && f.servicePointIds.length > 0),
    })).filter((L) => L.fleets.length > 0);

    if (!drafts.length) {
      toast.error('Tambah Loading → pilih Armada → centang minimal satu titik');
      return;
    }
    if (drafts.some((L) => !L.jamStart || !L.jamMax)) {
      toast.error('Setiap loading wajib punya jam start & maksimal');
      return;
    }

    const servicePointIds = [...new Set(
      drafts.flatMap((L) => L.fleets.flatMap((f) => f.servicePointIds)),
    )];
    const allFleets = drafts.flatMap((L) => L.fleets);

    setSaving(true);
    try {
      const res = await fetch('/api/distribution-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          sourceType: 'RESULT',
          productionResultId: resultId,
          servicePointIds,
          loadings: drafts.map((L, idx) => ({
            urutan: idx + 1,
            label: L.label || loadingLabel(idx + 1),
            jamStart: L.jamStart,
            jamMax: L.jamMax,
            armadas: L.fleets.map((f) => ({
              armadaId: f.armadaId,
              servicePointIds: [...f.servicePointIds].sort((a, b) => {
                const pa = pointsById.get(a);
                const pb = pointsById.get(b);
                return compareJamKirim(pa?.jamKirim, pb?.jamKirim)
                  || String(pa?.nama || a).localeCompare(String(pb?.nama || b), 'id');
              }),
            })),
          })),
          catatan: createNote.trim() || undefined,
          allocate: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      toast.success(
        `DST ${data.noDokumen} · ${data.summary?.qtyPorsiTotal || 0} porsi · `
        + `${data.summary?.loadingCount || drafts.length} loading · `
        + `${data.summary?.armadaCount || allFleets.length} armada`,
      );
      setOpen(false);
      resetCreateForm();
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(row: DistRow) {
    setDetailLoading(true);
    setDetail(row);
    try {
      const res = await fetch(`/api/distribution-orders/${row.id}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat detail');
      setDetail(data as DistRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat detail');
    } finally {
      setDetailLoading(false);
    }
  }

  async function submitStatus() {
    if (!statusTarget) return;
    const { row, next } = statusTarget;
    if (next === 'COMPLETED') {
      for (const line of statusLineQtys) {
        if (!Number.isFinite(line.qtyDiterima) || line.qtyDiterima < 0) {
          toast.error('Qty diterima harus ≥ 0');
          return;
        }
        if (!Number.isFinite(line.qtyDikembalikan) || line.qtyDikembalikan < 0) {
          toast.error('Qty dikembalikan harus ≥ 0');
          return;
        }
        const sum = Number(line.qtyDiterima) + Number(line.qtyDikembalikan);
        if (Math.abs(sum - Number(line.qtyDikirim)) > 0.0001) {
          toast.error(
            `${line.servicePointNama || 'Titik'}: diterima + dikembalikan harus = dikirim (${line.qtyDikirim})`,
          );
          return;
        }
      }
    } else {
      for (const line of statusLineQtys) {
        if (!Number.isFinite(line.qty) || line.qty < 0) {
          toast.error('Qty per titik harus ≥ 0');
          return;
        }
      }
    }
    setStatusSaving(true);
    try {
      const res = await fetch(`/api/distribution-orders/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          status: next,
          photos: statusPhotos.length ? statusPhotos : undefined,
          lineActuals: statusLineQtys.map((l) => (
            next === 'COMPLETED'
              ? {
                servicePointId: l.servicePointId,
                menuId: l.menuId,
                recipeId: l.recipeId,
                finishedGoodProductId: l.finishedGoodProductId,
                qtyDiterima: l.qtyDiterima,
                qtyDikembalikan: l.qtyDikembalikan,
                notes: l.note,
              }
              : {
                servicePointId: l.servicePointId,
                menuId: l.menuId,
                recipeId: l.recipeId,
                finishedGoodProductId: l.finishedGoodProductId,
                qty: l.qty,
                notes: l.note,
              }
          )),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      const moved = next === 'COMPLETED'
        ? statusLineQtys.reduce((s, l) => s + Number(l.qtyDiterima) + Number(l.qtyDikembalikan), 0)
        : statusLineQtys.reduce((s, l) => s + (Number(l.qty) || 0), 0);
      toast.success(`Status → ${DIST_STATUS_LABELS[next]} · ${moved} porsi`);
      setStatusTarget(null);
      setStatusPhotos([]);
      setStatusLineQtys([]);
      await load();
      if (detail?.id === row.id) setDetail(data as DistRow);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setStatusSaving(false);
    }
  }

  async function cancelDraft(row: DistRow) {
    if (row.status !== 'DRAFT' && row.status !== 'SUBMITTED' && row.status !== 'APPROVED') {
      toast.error('Hanya packing Disiapkan yang bisa dibatalkan');
      return;
    }
    const okConfirm = window.confirm(`Batalkan packing ${row.noDokumen}?`);
    if (!okConfirm) return;
    try {
      const res = await fetch(`/api/distribution-orders/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal');
      toast.success('Packing dibatalkan');
      if (detail?.id === row.id) setDetail(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <OperationalScopeBar />
      <KitchenScopeBar />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Jadwal Pengiriman
          </h1>
          <p className="text-sm text-muted-foreground">
            Packing dari HSL — loading → armada → rute jam makan (PK/PB) → kirim / selesai per titik
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" /> Muat
          </Button>
          {canManage && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Jadwal baru
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-3">No DST</th>
              <th className="text-left p-3">Sumber</th>
              <th className="text-left p-3">Dapur</th>
              <th className="text-left p-3">Tanggal</th>
              <th className="text-right p-3">Porsi</th>
              <th className="text-left p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Memuat…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Belum ada distribusi</td></tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-t hover:bg-muted/40 cursor-pointer"
                onClick={() => void openDetail(row)}
              >
                <td className="p-3 font-mono text-xs text-primary hover:underline">{row.noDokumen}</td>
                <td className="p-3 text-xs">
                  {row.sourceType === 'RESULT' ? 'HSL' : 'RPN'}{' '}
                  {row.productionResultNo || row.productionPlanNo}
                  {row.summary?.servicePointCount != null && (
                    <span className="text-muted-foreground"> · {row.summary.servicePointCount} titik</span>
                  )}
                </td>
                <td className="p-3">{row.kitchenNama || '—'}</td>
                <td className="p-3">{row.tanggal}</td>
                <td className="p-3 text-right">
                  {row.summary?.qtyDiterimaTotal
                    ? `${row.summary.qtyDiterimaTotal} diterima`
                    : row.summary?.qtyDikirimTotal
                      ? `${row.summary.qtyDikirimTotal} dikirim`
                      : (row.summary?.qtyPorsiTotal ?? '—')}
                </td>
                <td className="p-3">{DIST_STATUS_LABELS[row.status]}</td>
                <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex flex-wrap gap-1 justify-end">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      title="Detail"
                      onClick={() => void openDetail(row)}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                    {canUpdateStatus && DIST_UI_STATUS_NEXT[row.status] && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void openStatusDialog(row, DIST_UI_STATUS_NEXT[row.status] as DistributionStatus)}
                      >
                        {DIST_UI_STATUS_NEXT_LABEL[row.status] || 'Lanjut'}
                      </Button>
                    )}
                    {canManage && (row.status === 'DRAFT' || row.status === 'SUBMITTED' || row.status === 'APPROVED') && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Batalkan packing"
                        onClick={() => void cancelDraft(row)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {detail?.noDokumen} — {detail ? DIST_STATUS_LABELS[detail.status] : ''}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="text-muted-foreground">
                Sumber {detail.sourceType === 'RESULT' ? 'HSL' : 'RPN'}{' '}
                <span className="font-mono text-foreground">
                  {detail.productionResultNo || detail.productionPlanNo || '—'}
                </span>
                {' · '}{detail.tanggal} · {detail.kitchenNama || '—'}
                {detail.summary && (
                  <>
                    {' · '}{detail.summary.qtyPorsiTotal} porsi
                    {' · '}{detail.summary.servicePointCount} titik
                  </>
                )}
              </div>
              {detail.catatan && (
                <p className="text-xs text-muted-foreground border rounded-md p-2">{detail.catatan}</p>
              )}
              {detailLoading ? (
                <p className="text-muted-foreground py-4 text-center">Memuat detail…</p>
              ) : (
                <div className="space-y-3">
                  {(() => {
                    const loadings = resolveDistLoadings(detail);
                    if (!loadings.length) return null;
                    return (
                      <div className="space-y-3 rounded-md border bg-slate-50/60 p-3">
                        <p className="text-sm font-semibold">
                          Jadwal pengiriman
                          {detail.tanggal ? (
                            <span className="font-normal text-muted-foreground">
                              {' · '}
                              {new Date(`${detail.tanggal}T00:00:00`).toLocaleDateString('id-ID', {
                                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
                              })}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-[11px] text-muted-foreground">Berdasarkan urutan Jam Makan</p>
                        {loadings.map((L) => (
                          <div key={`load-${L.urutan}`} className="space-y-2 border-t pt-2 first:border-t-0 first:pt-0">
                            <div className="font-medium text-sm">
                              {L.label || loadingLabel(L.urutan)}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Start loading {L.jamStart.replace(':', '.')}
                              {' · '}
                              Maksimal loading {L.jamMax.replace(':', '.')}
                            </div>
                            {L.armadas.map((armada) => (
                              <div
                                key={`${L.urutan}-${armada.armadaId}`}
                                className="rounded-md border bg-white p-2.5 space-y-1.5"
                              >
                                <div className="font-medium text-sm flex items-center gap-1.5">
                                  <Car className="h-3.5 w-3.5" />
                                  Armada {armada.armadaNama || armada.armadaKode || armada.armadaId}
                                  {armada.platNomor ? (
                                    <span className="font-mono text-xs text-muted-foreground font-normal">
                                      ({armada.platNomor})
                                    </span>
                                  ) : null}
                                </div>
                                <div className="text-xs">
                                  Total pengiriman: <strong>{armada.qtyPorsiTotal}</strong>
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {formatKategoriShort(armada.porsiByKategori)}
                                </div>
                                <ol className="text-xs space-y-1 list-decimal list-inside">
                                  {armada.stops.map((stop) => (
                                    <li key={`${armada.armadaId}-${stop.servicePointId}`}>
                                      <span className="font-mono">
                                        {(stop.jamKirim || '—:—').replace(':', '.')}
                                      </span>
                                      {' : '}
                                      {stop.servicePointNama || stop.servicePointId}
                                      {' : '}
                                      <span className="tabular-nums font-medium">{stop.qtyPorsi}</span>
                                      {stop.porsiByKategori && (
                                        <span className="text-muted-foreground">
                                          {' '}({formatKategoriShort(stop.porsiByKategori)})
                                        </span>
                                      )}
                                      {!!stop.drops?.length && (
                                        <ul className="ml-5 mt-0.5 space-y-0.5 list-none text-muted-foreground">
                                          {stop.drops.map((d) => (
                                            <li key={d.dropId}>
                                              → {(d.jamKirim || '—:—').replace(':', '.')} {d.label}
                                              {' : '}{d.qtyPorsi}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div className="rounded-md border overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2">Titik layanan</th>
                          <th className="text-left p-2">Jam</th>
                          <th className="text-left p-2">Menu</th>
                          <th className="text-right p-2">Kapasitas</th>
                          <th className="text-right p-2">Alokasi</th>
                          <th className="text-right p-2">Dikirim</th>
                          <th className="text-right p-2">Diterima</th>
                          <th className="text-right p-2">Kembali</th>
                          <th className="text-left p-2">Komentar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detail.lines || []).length === 0 && (
                          <tr>
                            <td colSpan={9} className="p-4 text-center text-muted-foreground">
                              Tidak ada baris alokasi
                            </td>
                          </tr>
                        )}
                        {(detail.lines || []).map((line, idx) => (
                          <tr key={`${line.servicePointId}-${idx}`} className="border-t">
                            <td className="p-2">
                              <div className="font-medium">
                                {line.servicePointNama || line.servicePointId}
                              </div>
                              {line.servicePointKode && (
                                <div className="text-xs font-mono text-muted-foreground">
                                  {line.servicePointKode}
                                </div>
                              )}
                            </td>
                            <td className="p-2 font-mono text-xs tabular-nums">
                              {line.jamKirim || '—'}
                            </td>
                            <td className="p-2">
                              {line.finishedGoodNama || line.menuNama || '—'}
                              {(line.finishedGoodKode || line.menuKode) && (
                                <div className="text-xs font-mono text-muted-foreground">
                                  {line.finishedGoodKode || line.menuKode}
                                </div>
                              )}
                            </td>
                            <td className="p-2 text-right text-muted-foreground">
                              {line.kapasitasPorsi ?? '—'}
                            </td>
                            <td className="p-2 text-right font-medium">{line.qtyPorsi}</td>
                            <td className="p-2 text-right">{line.qtyDikirim ?? '—'}</td>
                            <td className="p-2 text-right">{line.qtyDiterima ?? '—'}</td>
                            <td className="p-2 text-right">{line.qtyDikembalikan ?? '—'}</td>
                            <td className="p-2 text-muted-foreground max-w-[12rem] truncate" title={line.notes || ''}>
                              {line.notes || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {(detail.history || []).length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Riwayat</p>
                  <ul className="text-xs space-y-2 max-h-48 overflow-y-auto border rounded-md p-2">
                    {(detail.history || []).map((h, i) => (
                      <li key={i} className="space-y-1">
                        <div className="flex gap-2">
                          <span className="text-muted-foreground shrink-0">
                            {h.at ? new Date(h.at).toLocaleString('id-ID') : '—'}
                          </span>
                          <span>
                            {h.fromStatus
                              ? `${DIST_STATUS_LABELS[h.fromStatus as DistributionStatus] || h.fromStatus} → `
                              : ''}
                            {DIST_STATUS_LABELS[h.toStatus as DistributionStatus] || h.toStatus || '—'}
                            {h.userName ? ` · ${h.userName}` : ''}
                            {h.movementQtyPorsi != null ? ` · ${h.movementQtyPorsi} porsi` : ''}
                            {h.note ? ` — ${h.note}` : ''}
                          </span>
                        </div>
                        {!!h.lineActuals?.length && (
                          <div className="pl-1 text-[11px] text-muted-foreground space-y-0.5">
                            {h.lineActuals.map((la, li) => (
                              <div key={`${i}-la-${li}`}>
                                {la.servicePointNama || la.servicePointId}:{' '}
                                {la.qtyDiterima != null || la.qtyDikembalikan != null
                                  ? `terima ${la.qtyDiterima ?? 0} / kembali ${la.qtyDikembalikan ?? 0}`
                                  : `${la.qty ?? 0} porsi`}
                                {la.notes ? ` — ${la.notes}` : ''}
                              </div>
                            ))}
                          </div>
                        )}
                        {!!h.photoUrls?.length && (
                          <div className="flex flex-wrap gap-1 pl-1">
                            {h.photoUrls.map((src, pi) => (
                              <a
                                key={`${i}-${pi}`}
                                href={src}
                                target="_blank"
                                rel="noreferrer"
                                className="block w-14 h-14 rounded border overflow-hidden bg-muted"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={src} alt={`Foto ${pi + 1}`} className="w-full h-full object-cover" />
                              </a>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <DialogFooter className="gap-2 sm:gap-0">
                {canUpdateStatus && DIST_UI_STATUS_NEXT[detail.status] && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void openStatusDialog(detail, DIST_UI_STATUS_NEXT[detail.status] as DistributionStatus)}
                  >
                    {DIST_UI_STATUS_NEXT_LABEL[detail.status] || 'Lanjut'}
                  </Button>
                )}
                {canManage && (detail.status === 'DRAFT' || detail.status === 'SUBMITTED' || detail.status === 'APPROVED') && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void cancelDraft(detail)}
                  >
                    <Trash2 className="h-4 w-4 mr-1" /> Batalkan
                  </Button>
                )}
                <Button type="button" variant="outline" onClick={() => setDetail(null)}>
                  Tutup
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!statusTarget}
        onOpenChange={(o) => {
          if (!o) {
            setStatusTarget(null);
            setStatusPhotos([]);
            setStatusLineQtys([]);
          }
        }}
      >
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {statusTarget ? `Ubah status ke ${DIST_STATUS_LABELS[statusTarget.next]}` : 'Ubah status'}
            </DialogTitle>
          </DialogHeader>
          {statusTarget && (
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-md border bg-muted/30 p-3 space-y-1">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">No DST</span>
                  <span className="font-mono">{statusTarget.row.noDokumen}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">
                    {statusTarget.next === 'COMPLETED' ? 'Total selesai' : 'Total dikirim'}
                  </span>
                  <span className="font-medium">
                    {statusTarget.next === 'COMPLETED'
                      ? statusLineQtys.reduce(
                        (s, l) => s + Number(l.qtyDiterima || 0) + Number(l.qtyDikembalikan || 0),
                        0,
                      )
                      : statusLineQtys.reduce((s, l) => s + (Number(l.qty) || 0), 0)
                    }{' '}
                    porsi
                  </span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Status</span>
                  <span>
                    {DIST_STATUS_LABELS[statusTarget.row.status]} → {DIST_STATUS_LABELS[statusTarget.next]}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>
                  {statusTarget.next === 'COMPLETED'
                    ? 'Selesaikan per titik: diterima + dikembalikan (= dikirim)'
                    : 'Qty dikirim & komentar per titik'}
                </Label>
                <div className="rounded-md border overflow-x-auto">
                  {statusTarget.next === 'COMPLETED' ? (
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2 min-w-[9rem]">Titik</th>
                          <th className="text-right p-2">Dikirim</th>
                          <th className="text-right p-2">Diterima</th>
                          <th className="text-right p-2">Dikembalikan</th>
                          <th className="text-left p-2 min-w-[12rem]">Komentar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusLineQtys.map((line) => {
                          const sum = Number(line.qtyDiterima || 0) + Number(line.qtyDikembalikan || 0);
                          const ok = Math.abs(sum - Number(line.qtyDikirim)) < 0.0001;
                          return (
                            <tr key={line.key} className="border-t align-top">
                              <td className="p-2">
                                <div className="font-medium">
                                  {line.servicePointNama || line.servicePointId}
                                </div>
                                <div className="text-muted-foreground">
                                  {line.servicePointKode ? `${line.servicePointKode} · ` : ''}
                                  {line.menuLabel}
                                </div>
                                {!ok && (
                                  <div className="text-[10px] text-destructive mt-0.5">
                                    Jumlah {sum} ≠ dikirim {line.qtyDikirim}
                                  </div>
                                )}
                              </td>
                              <td className="p-2 text-right font-medium">{line.qtyDikirim}</td>
                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  className="w-20 h-8 border rounded-md px-2 text-right"
                                  value={line.qtyDiterima}
                                  disabled={statusSaving}
                                  onChange={(e) => {
                                    const raw = Number(e.target.value);
                                    const qtyDiterima = Number.isFinite(raw)
                                      ? Math.max(0, Math.min(raw, line.qtyDikirim))
                                      : 0;
                                    setStatusLineQtys((prev) =>
                                      prev.map((p) =>
                                        p.key === line.key
                                          ? {
                                            ...p,
                                            qtyDiterima,
                                            qtyDikembalikan: Math.max(0, line.qtyDikirim - qtyDiterima),
                                          }
                                          : p,
                                      ),
                                    );
                                  }}
                                />
                              </td>
                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  className="w-20 h-8 border rounded-md px-2 text-right"
                                  value={line.qtyDikembalikan}
                                  disabled={statusSaving}
                                  onChange={(e) => {
                                    const raw = Number(e.target.value);
                                    const qtyDikembalikan = Number.isFinite(raw)
                                      ? Math.max(0, Math.min(raw, line.qtyDikirim))
                                      : 0;
                                    setStatusLineQtys((prev) =>
                                      prev.map((p) =>
                                        p.key === line.key
                                          ? {
                                            ...p,
                                            qtyDikembalikan,
                                            qtyDiterima: Math.max(0, line.qtyDikirim - qtyDikembalikan),
                                          }
                                          : p,
                                      ),
                                    );
                                  }}
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  className="w-full min-w-[10rem] h-8 border rounded-md px-2"
                                  value={line.note}
                                  disabled={statusSaving}
                                  placeholder="Catatan titik…"
                                  onChange={(e) => {
                                    const note = e.target.value;
                                    setStatusLineQtys((prev) =>
                                      prev.map((p) => (p.key === line.key ? { ...p, note } : p)),
                                    );
                                  }}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2 min-w-[9rem]">Titik</th>
                          <th className="text-right p-2">Kapasitas</th>
                          <th className="text-right p-2">Alokasi</th>
                          <th className="text-right p-2">Dikirim</th>
                          <th className="text-left p-2 min-w-[12rem]">Komentar</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statusLineQtys.map((line) => (
                          <tr key={line.key} className="border-t align-top">
                            <td className="p-2">
                              <div className="font-medium">
                                {line.servicePointNama || line.servicePointId}
                              </div>
                              <div className="text-muted-foreground">
                                {line.servicePointKode ? `${line.servicePointKode} · ` : ''}
                                {line.menuLabel}
                              </div>
                            </td>
                            <td className="p-2 text-right text-muted-foreground">
                              {line.kapasitasPorsi ?? '—'}
                            </td>
                            <td className="p-2 text-right">{line.qtyAlokasi}</td>
                            <td className="p-2 text-right">
                              <input
                                type="number"
                                min={0}
                                step={1}
                                className="w-20 h-8 border rounded-md px-2 text-right"
                                value={line.qty}
                                disabled={statusSaving}
                                onChange={(e) => {
                                  const qty = Number(e.target.value);
                                  setStatusLineQtys((prev) =>
                                    prev.map((p) =>
                                      p.key === line.key
                                        ? { ...p, qty: Number.isFinite(qty) ? qty : 0 }
                                        : p,
                                    ),
                                  );
                                }}
                              />
                            </td>
                            <td className="p-2">
                              <input
                                type="text"
                                className="w-full min-w-[10rem] h-8 border rounded-md px-2"
                                value={line.note}
                                disabled={statusSaving}
                                placeholder="Catatan titik…"
                                onChange={(e) => {
                                  const note = e.target.value;
                                  setStatusLineQtys((prev) =>
                                    prev.map((p) => (p.key === line.key ? { ...p, note } : p)),
                                  );
                                }}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {statusTarget.next === 'COMPLETED'
                    ? 'Per titik: isi berapa yang diterima dan berapa yang dikembalikan. Jumlah keduanya harus sama dengan qty dikirim. Setelah semua titik selesai, status jadi Selesai.'
                    : 'Isi qty yang dikirim ke masing-masing titik. Retur hanya dicatat saat penyelesaian per titik.'}
                </p>
              </div>

              <PhotoUploadField
                label="Foto bukti"
                hint="Opsional. Maks. 3 foto, otomatis dikompres sebelum disimpan."
                photos={statusPhotos}
                onChange={setStatusPhotos}
                maxPhotos={3}
                disabled={statusSaving}
              />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStatusTarget(null)}>
              Batal
            </Button>
            <Button
              type="button"
              onClick={() => void submitStatus()}
              disabled={statusSaving}
            >
              {statusSaving
                ? 'Menyimpan…'
                : statusTarget?.next === 'COMPLETED'
                  ? 'Selesaikan distribusi'
                  : statusTarget
                    ? DIST_STATUS_LABELS[statusTarget.next]
                    : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetCreateForm();
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Jadwal Pengiriman baru</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Hasil produksi (HSL)</Label>
              <select
                className="w-full h-10 border rounded-md px-2 text-sm"
                value={resultId}
                onChange={(e) => setResultId(e.target.value)}
              >
                <option value="">— Pilih HSL —</option>
                {availableResults.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.noDokumen} · {r.tanggal} · {r.kitchenNama || ''}
                  </option>
                ))}
              </select>
              {availableResults.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Tidak ada HSL siap packing — HSL yang masih aktif / sudah diterima tidak ditampilkan.
                </p>
              )}
            </div>

            <p className="text-xs text-muted-foreground rounded-md border bg-muted/30 px-3 py-2">
              Urutan: <strong>1) Gelombang Loading</strong>
              {' → '}
              <strong>2) Armada</strong>
              {' → '}
              <strong>3) Titik distribusi</strong> (checkbox, urut Jam Makan)
            </p>

            {!armadas.length && (
              <p className="text-xs text-amber-700">
                Belum ada armada aktif.{' '}
                <Link href="/food-production/armada" className="underline underline-offset-2">
                  Buat armada
                </Link>
                {' '}dulu.
              </p>
            )}
            {!sortedPoints.length && (
              <p className="text-xs text-amber-700">
                Belum ada titik aktif — buat di Titik Layanan (isi Jam Makan).
              </p>
            )}

            {/* 1. Gelombang Loading */}
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label className="text-sm font-semibold">1. Gelombang Loading</Label>
                <Button type="button" variant="outline" size="sm" onClick={addLoadingDraft}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Tambah loading
                </Button>
              </div>
              {!loadingDrafts.length && (
                <p className="text-[11px] text-muted-foreground">
                  Tambah Loading pertama / kedua, isi jam start & maksimal loading.
                </p>
              )}

              <div className="space-y-3">
                {loadingDrafts.map((L) => (
                  <div key={L.key} className="rounded-md border bg-slate-50/40 p-3 space-y-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1 flex-1 min-w-[8rem]">
                        <Label className="text-xs">Label</Label>
                        <Input
                          value={L.label}
                          onChange={(e) => updateLoadingDraft(L.key, { label: e.target.value })}
                          placeholder={loadingLabel(L.urutan)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Start loading</Label>
                        <Input
                          type="time"
                          value={L.jamStart}
                          onChange={(e) => updateLoadingDraft(L.key, { jamStart: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Maks loading</Label>
                        <Input
                          type="time"
                          value={L.jamMax}
                          onChange={(e) => updateLoadingDraft(L.key, { jamMax: e.target.value })}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => removeLoadingDraft(L.key)}
                      >
                        Hapus
                      </Button>
                    </div>

                    {/* 2. Armada */}
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs font-semibold flex items-center gap-1">
                        <Car className="h-3.5 w-3.5" /> 2. Pilih Armada
                      </Label>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!armadas.length}
                        onClick={() => addFleetToLoading(L.key)}
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" /> Armada
                      </Button>
                    </div>

                    <div className="space-y-2">
                      {!L.fleets.length && (
                        <p className="text-[11px] text-muted-foreground">
                          Pilih armada untuk loading ini, lalu centang titik di langkah 3.
                        </p>
                      )}
                      {L.fleets.map((fleet) => {
                        const armada = armadasById.get(fleet.armadaId);
                        const kat = kategoriSummaryForPoints(fleet.servicePointIds);
                        const totalKat = Object.values(kat).reduce((s, n) => s + (Number(n) || 0), 0);
                        const routeStops = [...fleet.servicePointIds].sort((a, b) => {
                          const pa = pointsById.get(a);
                          const pb = pointsById.get(b);
                          return compareJamKirim(pa?.jamKirim, pb?.jamKirim)
                            || String(pa?.nama || a).localeCompare(String(pb?.nama || b), 'id');
                        });
                        // Unik armada hanya dalam loading yang sama (boleh dipakai lagi di loading lain).
                        const usedInThisLoading = new Set(
                          L.fleets
                            .filter((f) => f.key !== fleet.key)
                            .map((f) => f.armadaId),
                        );
                        return (
                          <div key={fleet.key} className="rounded border bg-white p-2.5 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <select
                                className="h-9 border rounded-md px-2 text-sm flex-1 min-w-[12rem]"
                                value={fleet.armadaId}
                                onChange={(e) => setFleetArmada(L.key, fleet.key, e.target.value)}
                              >
                                {armadas.map((a) => (
                                  <option
                                    key={a.id}
                                    value={a.id}
                                    disabled={usedInThisLoading.has(a.id)}
                                  >
                                    {a.kode} · {a.nama}{a.platNomor ? ` (${a.platNomor})` : ''}
                                  </option>
                                ))}
                              </select>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-destructive"
                                onClick={() => removeFleetFromLoading(L.key, fleet.key)}
                              >
                                Hapus
                              </Button>
                            </div>

                            {/* 3. Titik distribusi */}
                            <div className="space-y-1">
                              <Label className="text-xs font-semibold">
                                3. Titik distribusi (urut Jam Makan)
                              </Label>
                              <p className="text-[10px] text-muted-foreground">
                                Centang satu atau lebih titik untuk armada ini.
                                Titik yang sudah dipakai armada lain dinonaktifkan.
                              </p>
                              <div className="max-h-40 overflow-y-auto border rounded-md">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/40 sticky top-0">
                                    <tr>
                                      <th className="p-1.5 w-7" />
                                      <th className="text-left p-1.5 font-medium whitespace-nowrap">Jam</th>
                                      <th className="text-left p-1.5 font-medium">Titik</th>
                                      <th className="text-right p-1.5 font-medium whitespace-nowrap">Porsi / Kategori</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sortedPoints.length === 0 && (
                                      <tr>
                                        <td colSpan={4} className="p-2 text-muted-foreground">
                                          Belum ada titik
                                        </td>
                                      </tr>
                                    )}
                                    {sortedPoints.map((p) => {
                                      const checked = fleet.servicePointIds.includes(p.id);
                                      const takenElsewhere = !checked && assignedPointIds.has(p.id);
                                      const katLine = formatKategoriShort(p.porsiByKategori);
                                      return (
                                        <tr
                                          key={`${fleet.key}-${p.id}`}
                                          className={`border-t ${takenElsewhere ? 'opacity-40' : ''}`}
                                        >
                                          <td className="p-1.5 align-top">
                                            <input
                                              type="checkbox"
                                              checked={checked}
                                              disabled={takenElsewhere}
                                              onChange={() => toggleFleetPoint(L.key, fleet.key, p.id)}
                                            />
                                          </td>
                                          <td className="p-1.5 font-mono tabular-nums whitespace-nowrap align-top">
                                            {p.jamKirim || '—:—'}
                                          </td>
                                          <td className="p-1.5 align-top">
                                            <div className="font-medium">
                                              {p.kode ? `${p.kode} · ` : ''}{p.nama}
                                            </div>
                                            {(p.drops || []).length > 0 && (
                                              <div className="text-[10px] text-muted-foreground">
                                                {(p.drops || []).map((d) => (
                                                  `→ ${(d.jamKirim || '—:—').replace(':', '.')} ${d.label}`
                                                )).join(' · ')}
                                              </div>
                                            )}
                                          </td>
                                          <td className="p-1.5 text-right align-top">
                                            <div className="tabular-nums font-medium">
                                              {p.kapasitasPorsi ?? '—'}
                                            </div>
                                            <div className="text-[10px] text-muted-foreground leading-snug">
                                              {katLine !== '—' ? `(${katLine})` : 'belum ada kategori'}
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            {fleet.servicePointIds.length > 0 && (
                              <div className="text-[11px] rounded border border-dashed px-2 py-1.5">
                                Total: <strong>{totalKat || fleet.servicePointIds.length}</strong>
                                {' · '}
                                {formatKategoriShort(kat)}
                                <div className="text-[10px] text-muted-foreground mt-0.5">
                                  Rute: {routeStops.map((id, i) => {
                                    const p = pointsById.get(id);
                                    return `${i + 1}. ${(p?.jamKirim || '').replace(':', '.') || '—'} ${p?.nama || id}`;
                                  }).join(' → ')}
                                </div>
                                {armada?.kapasitasPorsi != null && (
                                  <div className="text-[10px] text-muted-foreground">
                                    Kapasitas armada: {armada.kapasitasPorsi.toLocaleString('id-ID')}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label>Komentar / Catatan disiapkan</Label>
              <Textarea
                value={createNote}
                onChange={(e) => setCreateNote(e.target.value)}
                rows={2}
                placeholder="Contoh: packing pagi, prioritas sekolah, instruksi driver, dll."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button
              onClick={() => void create()}
              disabled={
                saving
                || !resultId
                || availableResults.length === 0
                || selectedPointIds.length === 0
              }
            >
              {saving ? 'Menyimpan…' : 'Buat jadwal'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DistributionPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat distribusi…</div>}>
      <DistributionPageContent />
    </Suspense>
  );
}
