'use client';

import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import PlanDateStrip from '@/components/food-production/PlanDateStrip';
import RencanaKebutuhanDocument, {
  RENCANA_KEBUTUHAN_PRINT_ID,
} from '@/components/food-production/RencanaKebutuhanDocument';
import PrintPortal from '@/components/PrintPortal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders, getActingKitchenId } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { useConfirm } from '@/components/ConfirmProvider';
import { useRouter, useSearchParams } from 'next/navigation';
import { addDays, format } from 'date-fns';
import {
  CalendarDays, Plus, Pencil, RefreshCw, Trash2, History,
  ArrowUpFromLine, Factory, ClipboardList, Truck, ChevronDown, ChevronRight,
  PanelLeftClose, PanelLeftOpen, ShoppingBag,
  UtensilsCrossed, FileText, Printer, Combine,
} from 'lucide-react';
import { ISSUE_ELIGIBLE_PLAN_STATUSES } from '@/lib/food-production/material-issue';
import {
  ceilProcurementQty,
  MRP_ELIGIBLE_PLAN_STATUSES,
  procurementQtyStep,
} from '@/lib/food-production/material-requirement';
import { normalizeRecipeSatuan } from '@/lib/food-production/recipe-uom';
import {
  KATEGORI_PORSI_OPTIONS,
  PLAN_STATUS_LABELS,
  RECIPE_NEED_BUFFER_PCT,
  CONSOLIDATE_ELIGIBLE_STATUSES,
  kategoriPorsiListLabel,
  getRecipeBufferPct,
  isPlanEditable,
  canEditPlanMaterials,
  materialOverrideKey,
  normalizeKategoriPorsiList,
  summarizePlanLines,
  mergeProductionPlanLines,
  totalTargetPorsi,
  consolidateBlockedReason,
  cookDateFromPlanTanggal,
  procureDateFromPlanTanggal,
  type KategoriPorsi,
  type PlanMaterialOverride,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import {
  emptyPortionTargets,
  type PortionTargetMap,
} from '@/lib/food-production/portion-target';
import { suggestAkgProfileForCategories } from '@/lib/food-production/nutrition';
import {
  dateKey,
  formatPlanDateLabel,
  monthRangeIso,
  PLAN_STATUS_BADGE,
} from '@/lib/food-production/plan-calendar';
import {
  buildRencanaKebutuhanLines,
  recipeIngredientNeeds,
  recipeYieldOneWarning,
  type RencanaKebutuhanLine,
} from '@/lib/food-production/rencana-kebutuhan';
import { printDocument } from '@/lib/doc-print';
import { formatNumber } from '@/lib/format';
import {
  parseQtyInput,
  shouldSnapSpinnerStep,
  stepQtyFromSpinner,
} from '@/lib/qty-spinner';
import { cn } from '@/lib/utils';

const MANAGE_ROLES = new Set(['ADMIN', 'OWNER', 'SUPERVISOR', 'MASTER']);

interface KitchenOpt {
  id: string;
  nama: string;
  aktif?: boolean;
}

interface MenuOpt {
  id: string;
  kode: string;
  nama: string;
  aktif?: boolean;
  items?: Array<{
    recipeId: string;
    recipeKode?: string;
    recipeNama?: string;
    porsi: number;
  }>;
}

interface RecipeOpt {
  id: string;
  kode: string;
  nama: string;
  yieldQty?: number;
  wastePct?: number;
  aktif?: boolean;
  lines?: Array<{
    productId: string;
    productKode?: string;
    productNama?: string;
    qty: number;
    qtyBesar?: number;
    pctKecil?: number;
    qtyKecil?: number;
    satuan?: string;
    qtyBaseBesar?: number;
    qtyBaseKecil?: number;
    factorToBase?: number;
    baseSatuan?: string;
  }>;
}

interface PlanLineForm {
  recipeId: string;
  kategoriPorsiList: KategoriPorsi[];
  targetPorsi: string;
}

interface PlanHistoryEntry {
  at?: string;
  fromStatus?: string | null;
  toStatus?: string;
  userName?: string;
  note?: string;
}

interface PlanRow {
  id: string;
  noDokumen: string;
  tanggal: string;
  kitchenId: string;
  kitchenNama?: string;
  kitchenWarehouseKode?: string;
  kategoriPorsi?: KategoriPorsi;
  kategoriPorsiList?: KategoriPorsi[];
  status: ProductionPlanStatus;
  totalTargetPorsi?: number;
  catatan?: string;
  history?: PlanHistoryEntry[];
  materialOverrides?: PlanMaterialOverride[];
  recipeBufferPct?: Record<string, number>;
  lines: Array<{
    recipeId?: string;
    recipeKode?: string;
    recipeNama?: string;
    menuId?: string;
    targetPorsi: number;
    menuKode?: string;
    menuNama?: string;
    kategoriPorsiList?: KategoriPorsi[];
  }>;
}

interface MaterialReadiness {
  materialsReady: boolean;
  shortageCount: number;
  lineCount: number;
  linkedPo?: { id: string; noPO: string; status: string } | null;
  issueCompleted?: boolean;
  completedIssueNo?: string | null;
  resultCompleted?: boolean;
  completedResultNo?: string | null;
  openResult?: { id: string; noDokumen: string; status: string } | null;
  openIssue?: { id: string; noDokumen: string; status: string } | null;
  shortageLines?: Array<{
    productId: string;
    productKode?: string;
    productNama?: string;
    qtyGross?: number;
    qtyOnHand?: number;
    qtyNet?: number;
    satuan?: string;
    stockWarehouseKode?: string;
  }>;
  loading?: boolean;
  error?: string;
}

const emptyLine = (kategoriPorsiList: KategoriPorsi[] = []): PlanLineForm => ({
  recipeId: '',
  kategoriPorsiList,
  targetPorsi: '0',
});

function formatEstKcal(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '0';
  if (n >= 10) return Math.round(n).toLocaleString('id-ID');
  return n.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function unionKategoriFromLines(lines: PlanLineForm[]): KategoriPorsi[] {
  const seen = new Set<KategoriPorsi>();
  for (const line of lines) {
    for (const kp of line.kategoriPorsiList || []) seen.add(kp);
  }
  return KATEGORI_PORSI_OPTIONS.map((o) => o.value).filter((v) => seen.has(v));
}

function kategoriDropdownLabel(list: KategoriPorsi[]): string {
  if (!list.length) return '— Pilih kategori —';
  if (list.length === 1) {
    return KATEGORI_PORSI_OPTIONS.find((o) => o.value === list[0])?.label || list[0];
  }
  return `${list.length} kategori`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const STATUS_NEXT: Partial<Record<ProductionPlanStatus, ProductionPlanStatus>> = {
  DRAFT: 'SUBMITTED',
  SUBMITTED: 'APPROVED',
  APPROVED: 'PROCESSING',
  PROCESSING: 'COMPLETED',
};

const STATUS_NEXT_LABEL: Partial<Record<ProductionPlanStatus, string>> = {
  DRAFT: 'Ajukan',
  SUBMITTED: 'Setujui',
  APPROVED: 'Diproses',
  PROCESSING: 'Selesai',
};

export default function FoodProductionPlanPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Memuat rencana…</div>}>
      <FoodProductionPlanPageContent />
    </Suspense>
  );
}

function FoodProductionPlanPageContent() {
  const confirm = useConfirm();
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkHandled = useRef<string | null>(null);
  const deepLinkFetching = useRef<string | null>(null);
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE_ROLES.has(role);
  }, []);

  const [rows, setRows] = useState<PlanRow[]>([]);
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [menus, setMenus] = useState<MenuOpt[]>([]);
  const [recipesById, setRecipesById] = useState<Record<string, RecipeOpt>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState<PlanRow | null>(null);
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [filterStatus, setFilterStatus] = useState('');
  const [month, setMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string>(() => today());
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Expand menu line → show child recipes (like AppShell side-menu groups). */
  const [expandedMenuKeys, setExpandedMenuKeys] = useState<Record<string, boolean>>({});
  /** Expand recipe → show ingredient needs. */
  const [expandedRecipeKeys, setExpandedRecipeKeys] = useState<Record<string, boolean>>({});
  /** productId → stok per gudang (diisi saat expand resep). */
  const [stockByProductId, setStockByProductId] = useState<Record<string, {
    GKERING: number;
    GBASAH: number;
  }>>({});
  const [stockFetchPending, setStockFetchPending] = useState<Record<string, boolean>>({});
  const [readinessById, setReadinessById] = useState<Record<string, MaterialReadiness>>({});
  const [procuringId, setProcuringId] = useState<string | null>(null);
  const [refreshingProcureId, setRefreshingProcureId] = useState<string | null>(null);
  const [regeneratingMrpId, setRegeneratingMrpId] = useState<string | null>(null);
  /** Draft input qty kebutuhan: planId::recipeId::productId → string */
  const [qtyOverrideDraft, setQtyOverrideDraft] = useState<Record<string, string>>({});
  const [savingOverrideKey, setSavingOverrideKey] = useState<string | null>(null);
  const [savingBufferKey, setSavingBufferKey] = useState<string | null>(null);
  /** Panel Kategori Porsi — collapse agar Rencana Menu lebih lebar. */
  const [portionPanelOpen, setPortionPanelOpen] = useState(true);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [needsPrinting, setNeedsPrinting] = useState(false);
  const [consolidateOpen, setConsolidateOpen] = useState(false);
  const [consolidateIds, setConsolidateIds] = useState<string[]>([]);
  const [consolidating, setConsolidating] = useState(false);
  const [needsDoc, setNeedsDoc] = useState<{
    tanggal: string;
    kitchenLabel: string;
    planNos: string[];
    lines: RencanaKebutuhanLine[];
  } | null>(null);
  const [shortageDetailOpen, setShortageDetailOpen] = useState(false);
  const [shortageDetail, setShortageDetail] = useState<{
    noDokumen: string;
    count: number;
    lines: NonNullable<MaterialReadiness['shortageLines']>;
  } | null>(null);
  const [form, setForm] = useState({
    tanggal: today(),
    kitchenId: '',
    catatan: '',
  });
  const [lines, setLines] = useState<PlanLineForm[]>([emptyLine()]);
  const [portionTargets, setPortionTargets] = useState<PortionTargetMap>(() => emptyPortionTargets());
  const [portionDraft, setPortionDraft] = useState<Record<KategoriPorsi, string>>(() => ({
    PORSI_BESAR: '0',
    PORSI_KECIL: '0',
    POSYANDU_BUMIL_BUSUI: '0',
    POSYANDU_BALITA: '0',
  }));
  const [savingPortion, setSavingPortion] = useState(false);
  const [kitchenScopeTick, setKitchenScopeTick] = useState(0);
  /** Acuan porsi untuk tanggal/dapur di dialog (bisa beda dari panel kiri). */
  const [dialogTargets, setDialogTargets] = useState<PortionTargetMap>(() => emptyPortionTargets());
  /** Acuan per tanggal+dapur rencana — jangan pakai filter sidebar untuk kartu RPN lain. */
  const [acuanByPlanKey, setAcuanByPlanKey] = useState<Record<string, PortionTargetMap>>({});
  const acuanFetchedRef = useRef<Set<string>>(new Set());
  const [planAkgProfile, setPlanAkgProfile] = useState('PORSI_KECIL');
  type AkgPerPorsi = {
    energiKcal: number;
    proteinG: number;
    lemakG?: number;
    karbohidratG?: number;
  };
  const [draftAkg, setDraftAkg] = useState<{
    perPorsi: AkgPerPorsi;
    perPorsiAkgPct: { energiKcal?: number; proteinG?: number };
    yieldPorsi: number;
    warnings: string[];
    lineEstimates: Array<{
      index: number;
      recipeId?: string | null;
      perPorsi?: AkgPerPorsi | null;
      perPorsiAkgPct?: { energiKcal?: number; proteinG?: number } | null;
      missingProductIds?: string[];
    }>;
  } | null>(null);
  const [draftAkgLoading, setDraftAkgLoading] = useState(false);
  /** Cached Est. AKG for expanded plan rows (list view). */
  const [planAkgById, setPlanAkgById] = useState<Record<string, {
    perPorsi: AkgPerPorsi;
    perPorsiAkgPct: { energiKcal?: number; proteinG?: number };
    warnings: string[];
    lineEstimates: Array<{
      recipeId?: string | null;
      perPorsi?: AkgPerPorsi | null;
      perPorsiAkgPct?: { energiKcal?: number; proteinG?: number } | null;
    }>;
  }>>({});

  const scopeKitchenId = useMemo(
    () => getActingKitchenId() || kitchens[0]?.id || '',
    [kitchens, kitchenScopeTick],
  );

  const draftPorsiDescription = useMemo(() => {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const line of lines) {
      for (const kp of line.kategoriPorsiList || []) {
        if (seen.has(kp)) continue;
        seen.add(kp);
        const label = KATEGORI_PORSI_OPTIONS.find((o) => o.value === kp)?.label || kp;
        const acuan = dialogTargets[kp as KategoriPorsi] ?? 0;
        parts.push(`${label} ${Number(acuan).toLocaleString('id-ID')}`);
      }
    }
    const total = lines.reduce((s, l) => s + (Number(l.targetPorsi) || 0), 0);
    return { parts, total };
  }, [lines, dialogTargets]);

  // Auto-pilih target MBG bila semua baris satu keluarga porsi.
  useEffect(() => {
    if (!open) return;
    const suggested = suggestAkgProfileForCategories(lines.map((l) => l.kategoriPorsiList));
    if (suggested === 'PORSI_KECIL' || suggested === 'PORSI_BESAR') {
      setPlanAkgProfile(suggested);
    }
  }, [open, lines]);

  useEffect(() => {
    if (!open) return;
    const payload = lines
      .filter((l) => l.recipeId && (Number(l.targetPorsi) || 0) > 0)
      .map((l) => ({
        recipeId: l.recipeId,
        targetPorsi: Number(l.targetPorsi) || 0,
        kategoriPorsiList: l.kategoriPorsiList,
      }));
    if (!payload.length) {
      setDraftAkg(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      setDraftAkgLoading(true);
      void (async () => {
        try {
          const res = await fetch('/api/nutrition-profiles/analyze-draft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
            body: JSON.stringify({
              akg: planAkgProfile,
              lines: payload,
              acuanByKategori: dialogTargets,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || 'Gagal hitung est. AKG');
          if (cancelled) return;
          setDraftAkg({
            perPorsi: {
              energiKcal: Number(data.perPorsi?.energiKcal) || 0,
              proteinG: Number(data.perPorsi?.proteinG) || 0,
              lemakG: Number(data.perPorsi?.lemakG) || 0,
              karbohidratG: Number(data.perPorsi?.karbohidratG) || 0,
            },
            perPorsiAkgPct: {
              energiKcal: Number(data.perPorsiAkgPct?.energiKcal) || 0,
              proteinG: Number(data.perPorsiAkgPct?.proteinG) || 0,
            },
            yieldPorsi: Number(data.yieldPorsi) || 0,
            warnings: Array.isArray(data.warnings) ? data.warnings : [],
            lineEstimates: Array.isArray(data.lineEstimates) ? data.lineEstimates : [],
          });
        } catch {
          if (!cancelled) setDraftAkg(null);
        } finally {
          if (!cancelled) setDraftAkgLoading(false);
        }
      })();
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, lines, planAkgProfile, dialogTargets]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Bulan aktif + buffer strip tanggal (±10 hari) agar navigasi horizontal tetap punya data.
      const monthRange = monthRangeIso(month);
      const from = format(addDays(new Date(`${monthRange.from}T12:00:00`), -10), 'yyyy-MM-dd');
      const to = format(addDays(new Date(`${monthRange.to}T12:00:00`), 10), 'yyyy-MM-dd');
      const params = new URLSearchParams({ from, to });
      if (filterStatus) params.set('status', filterStatus);
      const [pRes, kRes, mRes, rRes] = await Promise.all([
        fetch(`/api/production-plans?${params}`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        }),
        fetch('/api/kitchens?aktif=1', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/menus', { headers: { ...actingTenantHeaders() } }),
        fetch('/api/recipes', { headers: { ...actingTenantHeaders() } }),
      ]);
      const pData = await pRes.json();
      const kData = await kRes.json();
      const mData = await mRes.json();
      const rData = await rRes.json();
      if (!pRes.ok) throw new Error(pData?.error || 'Gagal memuat rencana');
      setRows(Array.isArray(pData) ? pData : []);
      setKitchens(Array.isArray(kData) ? kData : []);
      setMenus(Array.isArray(mData) ? mData : []);
      const recipeMap: Record<string, RecipeOpt> = {};
      if (Array.isArray(rData)) {
        for (const r of rData as RecipeOpt[]) {
          if (r?.id) recipeMap[r.id] = r;
        }
      }
      setRecipesById(recipeMap);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat rencana');
    } finally {
      setLoading(false);
    }
  }, [month, filterStatus]);

  const refreshRecipes = useCallback(async () => {
    try {
      const rRes = await fetch('/api/recipes', { headers: { ...actingTenantHeaders() } });
      const rData = await rRes.json();
      if (!rRes.ok) return;
      const recipeMap: Record<string, RecipeOpt> = {};
      if (Array.isArray(rData)) {
        for (const r of rData as RecipeOpt[]) {
          if (r?.id) recipeMap[r.id] = r;
        }
      }
      setRecipesById(recipeMap);
    } catch {
      /* biarkan resep yang sudah ter-load */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKitchen = () => { void load(); };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, [load]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') void refreshRecipes();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refreshRecipes]);

  // Deep-link dari Laporan / Hasil: buka tanggal RPN terkait + expand baris.
  useEffect(() => {
    const planId = (searchParams.get('productionPlanId') || searchParams.get('highlight') || '').trim();
    if (!planId || loading) return;
    if (deepLinkHandled.current === planId) return;

    const focusPlan = (hit: PlanRow) => {
      deepLinkHandled.current = planId;
      const tgl = dateKey(hit.tanggal);
      setShowAll(false);
      setSelectedDate(tgl);
      const d = new Date(`${tgl}T12:00:00`);
      if (!Number.isNaN(d.getTime())) {
        setMonth((prev) => {
          const same =
            prev.getFullYear() === d.getFullYear() && prev.getMonth() === d.getMonth();
          return same ? prev : d;
        });
      }
      setExpandedId(hit.id);
      if (ISSUE_ELIGIBLE_PLAN_STATUSES.has(hit.status)) {
        void fetchReadiness(hit.id);
      }
    };

    const hit = rows.find((r) => r.id === planId);
    if (hit) {
      focusPlan(hit);
      return;
    }

    // RPN di luar bulan yang sedang dimuat — fetch by id lalu pindah kalender.
    if (deepLinkFetching.current === planId) return;
    deepLinkFetching.current = planId;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/production-plans/${encodeURIComponent(planId)}`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          deepLinkHandled.current = planId;
          toast.error(data?.error || 'Rencana tidak ditemukan');
          return;
        }
        focusPlan(data as PlanRow);
      } catch {
        if (!cancelled) {
          deepLinkHandled.current = planId;
          toast.error('Gagal membuka rencana');
        }
      } finally {
        if (deepLinkFetching.current === planId) deepLinkFetching.current = null;
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deep-link once per planId after load
  }, [searchParams, rows, loading]);

  const activeRecipes = useMemo(
    () => Object.values(recipesById).filter((r) => r.aktif !== false),
    [recipesById],
  );

  const filteredList = useMemo(() => {
    let list = rows;
    if (!showAll && selectedDate) {
      list = list.filter((r) => dateKey(r.tanggal) === selectedDate);
    }
    if (filterStatus !== 'CANCELLED') {
      list = list.filter((r) => r.status !== 'CANCELLED');
    }
    // Terbaru di atas: tanggal desc, lalu noDokumen desc (RPN…002 di atas …001).
    return [...list].sort((a, b) => {
      const d = String(b.tanggal).localeCompare(String(a.tanggal));
      if (d !== 0) return d;
      return String(b.noDokumen).localeCompare(String(a.noDokumen));
    });
  }, [rows, selectedDate, showAll, filterStatus]);

  const listTitle = showAll || !selectedDate
    ? 'Semua rencana bulan ini'
    : `Rencana Menu ${format(new Date(`${selectedDate}T12:00:00`), 'd-M-yyyy')}`;

  const loadPortionTargets = useCallback(async (tanggal: string, kitchenId: string) => {
    if (!tanggal || !kitchenId) {
      const empty = emptyPortionTargets();
      setPortionTargets(empty);
      setPortionDraft({
        PORSI_BESAR: '0',
        PORSI_KECIL: '0',
        POSYANDU_BUMIL_BUSUI: '0',
        POSYANDU_BALITA: '0',
      });
      return;
    }
    try {
      const qs = new URLSearchParams({ tanggal, kitchenId });
      const res = await fetch(`/api/portion-targets?${qs}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal memuat acuan porsi');
      const targets = {
        ...emptyPortionTargets(),
        ...(data?.targets || {}),
      } as PortionTargetMap;
      setPortionTargets(targets);
      const key = `${dateKey(tanggal)}::${kitchenId}`;
      acuanFetchedRef.current.add(key);
      setAcuanByPlanKey((prev) => ({ ...prev, [key]: targets }));
      setPortionDraft({
        PORSI_BESAR: String(targets.PORSI_BESAR ?? 0),
        PORSI_KECIL: String(targets.PORSI_KECIL ?? 0),
        POSYANDU_BUMIL_BUSUI: String(targets.POSYANDU_BUMIL_BUSUI ?? 0),
        POSYANDU_BALITA: String(targets.POSYANDU_BALITA ?? 0),
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat acuan porsi');
    }
  }, []);

  useEffect(() => {
    void loadPortionTargets(selectedDate, scopeKitchenId);
  }, [loadPortionTargets, selectedDate, scopeKitchenId]);

  function planAcuanKey(tanggal: string, kitchenId: string) {
    return `${dateKey(tanggal)}::${kitchenId}`;
  }

  const ensurePlanAcuan = useCallback(async (tanggal: string, kitchenId: string) => {
    const tgl = dateKey(tanggal);
    const kid = String(kitchenId || '').trim();
    if (!tgl || !kid) return;
    const key = `${tgl}::${kid}`;
    if (acuanFetchedRef.current.has(key)) return;
    acuanFetchedRef.current.add(key);
    try {
      const qs = new URLSearchParams({ tanggal: tgl, kitchenId: kid });
      const res = await fetch(`/api/portion-targets?${qs}`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) {
        acuanFetchedRef.current.delete(key);
        return;
      }
      const targets = {
        ...emptyPortionTargets(),
        ...(data?.targets || {}),
      } as PortionTargetMap;
      setAcuanByPlanKey((prev) => ({ ...prev, [key]: targets }));
    } catch {
      acuanFetchedRef.current.delete(key);
    }
  }, []);

  useEffect(() => {
    const seen = new Set<string>();
    for (const row of rows) {
      const kid = String(row.kitchenId || '').trim();
      const tgl = dateKey(row.tanggal);
      if (!kid || !tgl) continue;
      const key = `${tgl}::${kid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      void ensurePlanAcuan(row.tanggal, kid);
    }
  }, [rows, ensurePlanAcuan]);

  function acuanForPlan(row: Pick<PlanRow, 'tanggal' | 'kitchenId'>): PortionTargetMap {
    const key = planAcuanKey(row.tanggal, row.kitchenId);
    if (acuanByPlanKey[key]) return acuanByPlanKey[key];
    if (row.kitchenId === scopeKitchenId && dateKey(row.tanggal) === selectedDate) {
      return portionTargets;
    }
    return emptyPortionTargets();
  }

  useEffect(() => {
    const onKitchen = () => {
      setKitchenScopeTick((n) => n + 1);
    };
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, []);

  async function savePortionTargets(next?: PortionTargetMap) {
    if (!canManage) return;
    if (!selectedDate) {
      toast.error('Pilih tanggal dulu');
      return;
    }
    if (!scopeKitchenId) {
      toast.error('Pilih dapur di scope bar dulu');
      return;
    }
    const targets = next || {
      PORSI_BESAR: Math.max(0, Math.floor(Number(portionDraft.PORSI_BESAR) || 0)),
      PORSI_KECIL: Math.max(0, Math.floor(Number(portionDraft.PORSI_KECIL) || 0)),
      POSYANDU_BUMIL_BUSUI: Math.max(0, Math.floor(Number(portionDraft.POSYANDU_BUMIL_BUSUI) || 0)),
      POSYANDU_BALITA: Math.max(0, Math.floor(Number(portionDraft.POSYANDU_BALITA) || 0)),
    };
    setSavingPortion(true);
    try {
      const res = await fetch('/api/portion-targets', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...actingTenantHeaders(),
          ...actingKitchenHeaders(),
        },
        body: JSON.stringify({
          tanggal: selectedDate,
          kitchenId: scopeKitchenId,
          targets,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan acuan porsi');
      const saved = {
        ...emptyPortionTargets(),
        ...(data?.targets || targets),
      } as PortionTargetMap;
      setPortionTargets(saved);
      const key = `${dateKey(selectedDate)}::${scopeKitchenId}`;
      acuanFetchedRef.current.add(key);
      setAcuanByPlanKey((prev) => ({ ...prev, [key]: saved }));
      setPortionDraft({
        PORSI_BESAR: String(saved.PORSI_BESAR ?? 0),
        PORSI_KECIL: String(saved.PORSI_KECIL ?? 0),
        POSYANDU_BUMIL_BUSUI: String(saved.POSYANDU_BUMIL_BUSUI ?? 0),
        POSYANDU_BALITA: String(saved.POSYANDU_BALITA ?? 0),
      });
      toast.success('Acuan kategori porsi disimpan');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan acuan porsi');
    } finally {
      setSavingPortion(false);
    }
  }

  function porsiAcuanFor(kp: KategoriPorsi, map: PortionTargetMap = dialogTargets): number {
    return Math.max(0, Math.floor(Number(map[kp]) || 0));
  }

  function sumPorsiFromKategori(
    list: KategoriPorsi[],
    map: PortionTargetMap = dialogTargets,
  ): number {
    return list.reduce((sum, kp) => sum + porsiAcuanFor(kp, map), 0);
  }

  function toggleLineKategoriPorsi(idx: number, kp: KategoriPorsi, checked: boolean) {
    const line = lines[idx];
    if (!line) return;
    const next = checked
      ? KATEGORI_PORSI_OPTIONS.map((o) => o.value).filter(
        (v) => v === kp || line.kategoriPorsiList.includes(v),
      )
      : line.kategoriPorsiList.filter((v) => v !== kp);
    const n = sumPorsiFromKategori(next);
    if (next.length > 0 && n <= 0) {
      toast.message('Isi acuan porsi di panel Kategori Porsi untuk tanggal ini');
    }
    setLines((prev) => prev.map((l, i) => (
      i === idx ? { ...l, kategoriPorsiList: next, targetPorsi: String(n || 0) } : l
    )));
  }

  useEffect(() => {
    if (!open) return;
    const kitchenId = form.kitchenId || scopeKitchenId;
    const tanggal = form.tanggal;
    if (!tanggal || !kitchenId) {
      setDialogTargets(emptyPortionTargets());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const qs = new URLSearchParams({ tanggal, kitchenId });
        const res = await fetch(`/api/portion-targets?${qs}`, {
          headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
        });
        const data = await res.json();
        if (!res.ok || cancelled) return;
        const targets = {
          ...emptyPortionTargets(),
          ...(data?.targets || {}),
        } as PortionTargetMap;
        setDialogTargets(targets);
      } catch {
        if (!cancelled) setDialogTargets(emptyPortionTargets());
      }
    })();
    return () => { cancelled = true; };
  }, [open, form.tanggal, form.kitchenId, scopeKitchenId]);

  function handleSelectDate(date: Date) {
    setSelectedDate(dateKey(date));
    setShowAll(false);
    setExpandedId(null);
  }

  function openCreate(date?: Date | string) {
    const tanggal = date
      ? (typeof date === 'string' ? dateKey(date) : format(date, 'yyyy-MM-dd'))
      : (selectedDate || today());
    const kitchenId = scopeKitchenId || kitchens[0]?.id || '';
    setEditing(null);
    setForm({
      tanggal,
      kitchenId,
      catatan: '',
    });
    setLines([emptyLine()]);
    setOpen(true);
  }

  function canEditMaterialsForRow(row: PlanRow): boolean {
    if (!canManage) return false;
    const linkedPoStatus = readinessById[row.id]?.linkedPo?.status;
    return canEditPlanMaterials(row.status, linkedPoStatus);
  }

  function poReviewUrl(poId: string, edit = false): string {
    const q = new URLSearchParams({ highlight: poId });
    if (edit) q.set('edit', '1');
    return `/pembelian-po?${q.toString()}`;
  }

  function openEdit(row: PlanRow) {
    if (!isPlanEditable(row.status)) {
      toast.error(`Status ${PLAN_STATUS_LABELS[row.status]} tidak dapat diubah`);
      return;
    }
    setEditing(row);
    const planKp = row.kategoriPorsiList?.length
      ? row.kategoriPorsiList
      : (row.kategoriPorsi ? [row.kategoriPorsi] : []);
    setForm({
      tanggal: row.tanggal || today(),
      kitchenId: row.kitchenId,
      catatan: row.catatan || '',
    });
    const formLines: PlanLineForm[] = [];
    for (const l of row.lines || []) {
      const lineKp = l.kategoriPorsiList?.length ? l.kategoriPorsiList : planKp;
      if (l.recipeId) {
        formLines.push({
          recipeId: l.recipeId,
          kategoriPorsiList: lineKp,
          targetPorsi: String(l.targetPorsi),
        });
        continue;
      }
      // Legacy menu → pecah ke baris resep agar form tetap recipe-first
      if (l.menuId) {
        const children = menuChildren(l.menuId);
        if (children.length) {
          for (const child of children) {
            formLines.push({
              recipeId: child.recipeId,
              kategoriPorsiList: lineKp,
              targetPorsi: String(Math.max(
                1,
                Math.round((Number(l.targetPorsi) || 0) * (Number(child.porsi) || 1)),
              )),
            });
          }
        }
      }
    }
    setLines(formLines.length ? formLines : [emptyLine(planKp)]);
    setOpen(true);
  }

  async function save() {
    const validLines = lines.filter((l) => l.recipeId);
    if (!validLines.length) {
      toast.error('Minimal satu baris resep');
      return;
    }
    const missingKp = validLines.some((l) => !l.kategoriPorsiList.length);
    if (missingKp) {
      toast.error('Setiap baris resep wajib punya minimal satu kategori porsi');
      return;
    }
    const kategoriPorsiList = unionKategoriFromLines(validLines);
    const kpOk = normalizeKategoriPorsiList(kategoriPorsiList);
    if ('error' in kpOk) {
      toast.error(kpOk.error);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        tanggal: form.tanggal,
        kitchenId: form.kitchenId,
        kategoriPorsiList: kpOk,
        catatan: form.catatan.trim() || undefined,
        lines: validLines.map((l) => ({
          recipeId: l.recipeId,
          kategoriPorsiList: l.kategoriPorsiList,
          targetPorsi: Number(l.targetPorsi) || 0,
        })),
      };
      const url = editing ? `/api/production-plans/${editing.id}` : '/api/production-plans';
      const method = editing ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      toast.success(editing ? 'Rencana diperbarui' : `Rencana ${data.noDokumen || ''} dibuat`);
      if (editing?.id) {
        setPlanAkgById((prev) => {
          const next = { ...prev };
          delete next[editing.id];
          return next;
        });
      }
      setOpen(false);
      if (payload.tanggal) {
        setSelectedDate(payload.tanggal);
        setShowAll(false);
      }
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSaving(false);
    }
  }

  async function fetchReadiness(planId: string) {
    setReadinessById((prev) => ({
      ...prev,
      [planId]: { ...(prev[planId] || { materialsReady: false, shortageCount: 0, lineCount: 0 }), loading: true },
    }));
    try {
      const res = await fetch(`/api/production-plans/${planId}/material-readiness`, {
        headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal cek kesiapan bahan');
      setReadinessById((prev) => ({
        ...prev,
        [planId]: {
          materialsReady: Boolean(data.materialsReady),
          shortageCount: Number(data.shortageCount || 0),
          lineCount: Number(data.lineCount || 0),
          linkedPo: data.linkedPo || null,
          issueCompleted: Boolean(data.issueCompleted),
          completedIssueNo: data.completedIssueNo || null,
          resultCompleted: Boolean(data.resultCompleted),
          completedResultNo: data.completedResultNo || null,
          openResult: data.openResult || null,
          openIssue: data.openIssue || null,
          shortageLines: Array.isArray(data.shortageLines) ? data.shortageLines : [],
          loading: false,
        },
      }));
      return data as MaterialReadiness;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal cek kesiapan bahan';
      setReadinessById((prev) => ({
        ...prev,
        [planId]: {
          materialsReady: false,
          shortageCount: 0,
          lineCount: 0,
          loading: false,
          error: msg,
        },
      }));
      return null;
    }
  }

  // Prefetch readiness for active plans so Diproses / Hasil / Selesai gates appear.
  useEffect(() => {
    for (const row of rows) {
      if (
        (row.status === 'APPROVED' || row.status === 'PROCESSING' || row.status === 'COMPLETED')
        && !readinessById[row.id]
      ) {
        void fetchReadiness(row.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when plan list changes
  }, [rows]);

  async function fetchPlanAkgEstimate(row: PlanRow) {
    try {
      const res = await fetch(
        `/api/nutrition-profiles/analyze?scope=plan&id=${encodeURIComponent(row.id)}&akg=${encodeURIComponent(planAkgProfile || 'PORSI_KECIL')}`,
        { headers: { ...actingTenantHeaders() } },
      );
      const data = await res.json();
      if (!res.ok) return;
      setPlanAkgById((prev) => ({
        ...prev,
        [row.id]: {
          perPorsi: {
            energiKcal: Number(data.perPorsi?.energiKcal) || 0,
            proteinG: Number(data.perPorsi?.proteinG) || 0,
          },
          perPorsiAkgPct: {
            energiKcal: Number(data.perPorsiAkgPct?.energiKcal) || 0,
            proteinG: Number(data.perPorsiAkgPct?.proteinG) || 0,
          },
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
          lineEstimates: Array.isArray(data.lineEstimates) ? data.lineEstimates : [],
        },
      }));
    } catch {
      /* ignore — Est. AKG opsional */
    }
  }

  async function toggleExpand(row: PlanRow) {
    const next = expandedId === row.id ? null : row.id;
    setExpandedId(next);
    if (next) {
      void fetchPlanAkgEstimate(row);
    }
    if (
      next
      && ISSUE_ELIGIBLE_PLAN_STATUSES.has(row.status)
      && !readinessById[row.id]
    ) {
      void fetchReadiness(row.id);
    }
  }

  function menuExpandKey(planId: string, menuId: string) {
    return `${planId}:${menuId}`;
  }

  function recipeExpandKey(planId: string, menuId: string, recipeId: string) {
    return `${planId}:${menuId}:${recipeId}`;
  }

  function toggleMenuExpand(planId: string, menuId: string) {
    const key = menuExpandKey(planId, menuId);
    setExpandedMenuKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function ensureIngredientStock(productIds: string[]) {
    const missing = [...new Set(productIds.filter(Boolean))]
      .filter((id) => stockByProductId[id] == null && !stockFetchPending[id]);
    if (!missing.length) return;
    setStockFetchPending((prev) => {
      const next = { ...prev };
      for (const id of missing) next[id] = true;
      return next;
    });
    try {
      const qs = new URLSearchParams({ ids: missing.join(',') });
      const res = await fetch(`/api/stok/by-products?${qs}`, {
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal cek stok');
      const map = (data?.byProductId || {}) as Record<string, { GKERING?: number; GBASAH?: number }>;
      setStockByProductId((prev) => {
        const next = { ...prev };
        for (const id of missing) {
          const row = map[id] || {};
          next[id] = {
            GKERING: Number(row.GKERING) || 0,
            GBASAH: Number(row.GBASAH) || 0,
          };
        }
        return next;
      });
    } catch {
      // diam — UI tetap tampil kebutuhan tanpa stok
    } finally {
      setStockFetchPending((prev) => {
        const next = { ...prev };
        for (const id of missing) delete next[id];
        return next;
      });
    }
  }

  function toggleRecipeExpand(planId: string, menuId: string, recipeId: string) {
    const key = recipeExpandKey(planId, menuId, recipeId);
    const willOpen = !expandedRecipeKeys[key];
    setExpandedRecipeKeys((prev) => ({ ...prev, [key]: willOpen }));
    if (willOpen) {
      void refreshRecipes();
      const recipe = recipesById[recipeId];
      const ids = (recipe?.lines || []).map((l) => l.productId).filter(Boolean);
      if (ids.length) void ensureIngredientStock(ids);
    }
  }

  function menuChildren(menuId: string) {
    return menus.find((m) => m.id === menuId)?.items || [];
  }

  function overrideDraftKey(planId: string, recipeId: string, productId: string) {
    return `${planId}::${materialOverrideKey(recipeId, productId)}`;
  }

  function getPlanOverride(
    row: PlanRow,
    recipeId: string,
    productId: string,
  ): PlanMaterialOverride | null {
    return (row.materialOverrides || []).find(
      (o) => o.recipeId === recipeId && o.productId === productId,
    ) || null;
  }

  function qtyOverrideApplies(ov: PlanMaterialOverride | null, kitchenSatuan?: string): boolean {
    if (!ov || ov.excluded) return false;
    if (!Number.isFinite(Number(ov.qty))) return false;
    const ovSat = normalizeRecipeSatuan(ov.satuan);
    const kitchen = normalizeRecipeSatuan(kitchenSatuan);
    if (ovSat && kitchen && ovSat !== kitchen) return false;
    return true;
  }

  async function toggleRecipeBuffer(row: PlanRow, recipeId: string, enabled: boolean) {
    if (!canManage || !isPlanEditable(row.status)) return;
    const key = `${row.id}::${recipeId}`;
    setSavingBufferKey(key);
    try {
      const res = await fetch(`/api/production-plans/${row.id}/recipe-buffer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          recipeId,
          enabled,
          bufferPct: enabled ? RECIPE_NEED_BUFFER_PCT : 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan buffer');
      setRows((prevRows) => prevRows.map((r) => (
        r.id === row.id ? { ...r, ...data, id: row.id } : r
      )));
      toast.success(enabled
        ? `Buffer ${RECIPE_NEED_BUFFER_PCT}% aktif — kebutuhan bahan ditambah`
        : 'Buffer dimatikan — kembali ke hitungan resep');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan buffer');
    } finally {
      setSavingBufferKey(null);
    }
  }

  async function saveMaterialOverride(input: {
    row: PlanRow;
    recipeId: string;
    productId: string;
    productKode?: string;
    productNama?: string;
    satuan?: string;
    qtyText?: string;
    computedQty: number;
    excluded?: boolean;
    clear?: boolean;
  }) {
    const { row, recipeId, productId, clear } = input;
    if (!canManage || !isPlanEditable(row.status)) return;
    const draftKey = overrideDraftKey(row.id, recipeId, productId);
    const prev = getPlanOverride(row, recipeId, productId);

    setSavingOverrideKey(draftKey);
    try {
      const body: Record<string, unknown> = {
        recipeId,
        productId,
        fallbackQty: input.computedQty,
        productKode: input.productKode,
        productNama: input.productNama,
        satuan: input.satuan,
      };

      if (clear) {
        body.clear = true;
      } else if (input.excluded !== undefined) {
        body.excluded = input.excluded;
        if (prev && Number.isFinite(Number(prev.qty))) body.qty = Number(prev.qty);
      } else if (input.qtyText != null) {
        const qty = parseQtyInput(input.qtyText);
        if (!Number.isFinite(qty) || qty < 0) {
          toast.error('Qty kebutuhan tidak valid');
          setQtyOverrideDraft((prevDraft) => {
            const next = { ...prevDraft };
            delete next[draftKey];
            return next;
          });
          return;
        }
        // Pembulatan sesuai satuan dapur (GR utuh, KG 3 desimal) — jangan ceil 0,02 KG jadi 1 KG.
        body.qty = ceilProcurementQty(qty, input.satuan);
        if (prev?.excluded) body.excluded = true;
      } else {
        return;
      }

      const res = await fetch(`/api/production-plans/${row.id}/material-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menyimpan');
      setRows((prevRows) => prevRows.map((r) => (
        r.id === row.id ? { ...r, ...data, id: row.id } : r
      )));
      setQtyOverrideDraft((prevDraft) => {
        const next = { ...prevDraft };
        delete next[draftKey];
        return next;
      });
      if (clear) toast.success('Qty kembali ke hitungan resep');
      else if (input.excluded === true) toast.success('Item dicoret — tidak masuk MRP/PO');
      else if (input.excluded === false) toast.success('Coret dibatalkan — item aktif lagi');
      else toast.success('Qty kebutuhan disimpan (dipakai ke MRP/PO)');
      const linkedSt = String(readinessById[row.id]?.linkedPo?.status || '').toUpperCase();
      if (linkedSt === 'DRAFT' || linkedSt === 'REJECTED') {
        toast.message('Draft PO perlu diperbarui agar baris belanja sesuai — gunakan Perbarui Draft PO');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
    } finally {
      setSavingOverrideKey(null);
    }
  }

  function renderIngredientQtyCell(input: {
    row: PlanRow;
    recipeId: string;
    ing: {
      productId: string;
      productKode?: string;
      productNama?: string;
      satuan?: string;
      qty: number;
      formula?: string;
    };
  }) {
    const { row, recipeId, ing } = input;
    const ov = getPlanOverride(row, recipeId, ing.productId);
    const excluded = ov?.excluded === true;
    const qtyOv = qtyOverrideApplies(ov, ing.satuan);
    const hasQtyOverride = qtyOv && Number(ov!.qty) !== Number(ing.qty);
    const displayQty = qtyOv ? Number(ov!.qty) : ing.qty;
    const draftKey = overrideDraftKey(row.id, recipeId, ing.productId);
    const canEditQty = canEditMaterialsForRow(row);
    const draftVal = qtyOverrideDraft[draftKey];
    const saving = savingOverrideKey === draftKey;

    const qtyCell = !canEditQty ? (
      <td className={cn(
        'p-2 text-right text-xs tabular-nums font-medium',
        excluded ? 'text-slate-400 line-through' : 'text-orange-700',
      )}>
        {formatNumber(displayQty)}
        {ing.satuan ? (
          <span className="ml-1 text-[10px] font-normal text-slate-500">{ing.satuan}</span>
        ) : null}
        {!excluded && hasQtyOverride && (
          <span className="ml-1 block text-[9px] font-normal text-amber-700">diubah</span>
        )}
        {!excluded && ing.formula ? (
          <span className="mt-0.5 block text-[9px] font-normal leading-snug text-slate-500">
            {ing.formula}
          </span>
        ) : null}
      </td>
    ) : (
      <td className="p-2 text-right" onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex flex-col items-end gap-0.5">
          <div className="inline-flex items-center gap-1">
            <Input
              type="number"
              min={0}
              step={procurementQtyStep(ing.satuan)}
              inputMode="decimal"
              className={cn(
                'h-7 w-[5.5rem] text-right tabular-nums text-xs px-1.5',
                excluded && 'line-through text-slate-400 bg-slate-50',
                !excluded && hasQtyOverride && 'border-amber-400 bg-amber-50/60',
              )}
              disabled={saving || excluded}
              value={draftVal != null ? draftVal : String(displayQty)}
              onChange={(e) => {
                const prevText = draftVal != null ? draftVal : String(displayQty);
                const nextText = e.target.value;
                const prev = parseQtyInput(prevText);
                const next = parseQtyInput(nextText);
                // Spinner mouse: dari pecahan meloncat ≥0.5 → bulatkan dulu (bukan +1 ke 4,45).
                if (nextText !== '' && shouldSnapSpinnerStep(prev, next)) {
                  const snapped = next > prev
                    ? stepQtyFromSpinner(prev, 'up')
                    : stepQtyFromSpinner(prev, 'down');
                  setQtyOverrideDraft((p) => ({ ...p, [draftKey]: String(snapped) }));
                  return;
                }
                setQtyOverrideDraft((p) => ({ ...p, [draftKey]: nextText }));
              }}
              onBlur={() => {
                if (excluded) return;
                const text = draftVal != null ? draftVal : String(displayQty);
                const parsed = parseQtyInput(text);
                if (Number.isFinite(parsed) && Math.abs(parsed - Number(displayQty)) < 1e-9) {
                  setQtyOverrideDraft((prevDraft) => {
                    const next = { ...prevDraft };
                    delete next[draftKey];
                    return next;
                  });
                  return;
                }
                void saveMaterialOverride({
                  row,
                  recipeId,
                  productId: ing.productId,
                  productKode: ing.productKode,
                  productNama: ing.productNama,
                  satuan: ing.satuan,
                  qtyText: text,
                  computedQty: ing.qty,
                });
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  const prevText = draftVal != null ? draftVal : String(displayQty);
                  const snapped = stepQtyFromSpinner(
                    prevText,
                    e.key === 'ArrowUp' ? 'up' : 'down',
                  );
                  setQtyOverrideDraft((p) => ({ ...p, [draftKey]: String(snapped) }));
                  return;
                }
                if (e.key === 'Enter') {
                  (e.target as HTMLInputElement).blur();
                }
              }}
              title={excluded
                ? 'Item dicoret — aktifkan lagi untuk mengubah qty'
                : (ing.formula || 'Edit qty kebutuhan — dipakai ke MRP/PO')}
            />
            {ing.satuan ? (
              <span className={cn('text-[10px] text-slate-500', excluded && 'line-through')}>
                {ing.satuan}
              </span>
            ) : null}
          </div>
          {!excluded && ing.formula ? (
            <span className="max-w-[14rem] text-right text-[9px] leading-snug text-slate-500">
              {ing.formula}
            </span>
          ) : null}
          {!excluded && hasQtyOverride ? (
            <button
              type="button"
              className="text-[9px] text-amber-700 underline-offset-2 hover:underline disabled:opacity-50"
              disabled={saving}
              onClick={() => void saveMaterialOverride({
                row,
                recipeId,
                productId: ing.productId,
                computedQty: ing.qty,
                clear: true,
              })}
            >
              reset ke resep
            </button>
          ) : null}
        </div>
      </td>
    );

    return (
      <Fragment>
        {/* Kolom Buffer hanya di baris resep — sel kosong agar qty sejajar kolom Porsi */}
        <td className="p-2" aria-hidden />
        {qtyCell}
      </Fragment>
    );
  }

  function renderExcludeCheckbox(input: {
    row: PlanRow;
    recipeId: string;
    ing: {
      productId: string;
      productKode?: string;
      productNama?: string;
      satuan?: string;
      qty: number;
    };
  }) {
    const { row, recipeId, ing } = input;
    const ov = getPlanOverride(row, recipeId, ing.productId);
    const excluded = ov?.excluded === true;
    const canEdit = canEditMaterialsForRow(row);
    const draftKey = overrideDraftKey(row.id, recipeId, ing.productId);
    const saving = savingOverrideKey === draftKey;

    if (!canEdit) {
      return (
        <td className="p-2 w-8 align-top">
          {excluded ? (
            <span className="block text-center text-[10px] text-slate-400" title="Dicoret">×</span>
          ) : null}
        </td>
      );
    }

    return (
      <td className="p-2 w-8 align-top" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          className="mt-1 h-3.5 w-3.5 accent-slate-700 cursor-pointer"
          checked={excluded}
          disabled={saving}
          title={excluded
            ? 'Hapus coret — ikut ke MRP/PO lagi'
            : 'Coret item — tidak masuk MRP/PO'}
          aria-label={excluded ? 'Batalkan coret item' : 'Coret item'}
          onChange={(e) => {
            void saveMaterialOverride({
              row,
              recipeId,
              productId: ing.productId,
              productKode: ing.productKode,
              productNama: ing.productNama,
              satuan: ing.satuan,
              computedQty: ing.qty,
              excluded: e.target.checked,
            });
          }}
        />
      </td>
    );
  }

  function openRencanaKebutuhanForDate(tanggal: string, fallbackKitchen = '') {
    const tgl = dateKey(tanggal);
    if (!tgl) {
      toast.error('Pilih tanggal rencana dulu');
      return;
    }
    const dayPlans = rows.filter(
      (r) => dateKey(r.tanggal) === tgl && r.status !== 'CANCELLED',
    );
    if (!dayPlans.length) {
      toast.error('Tidak ada rencana pada tanggal ini');
      return;
    }
    const menusMap = new Map(menus.map((m) => [m.id, m]));
    const recipesMap = new Map(Object.entries(recipesById).map(([id, r]) => [id, r]));
    const built = buildRencanaKebutuhanLines({
      plans: dayPlans.map((p) => ({
        noDokumen: p.noDokumen,
        kitchenNama: p.kitchenNama,
        status: p.status,
        kategoriPorsiList: p.kategoriPorsiList?.length
          ? p.kategoriPorsiList
          : (p.kategoriPorsi ? [p.kategoriPorsi] : []),
        materialOverrides: p.materialOverrides,
        recipeBufferPct: p.recipeBufferPct,
        lines: (p.lines || []).map((l) => ({
          recipeId: l.recipeId,
          recipeKode: l.recipeKode,
          menuId: l.menuId,
          menuKode: l.menuKode,
          targetPorsi: l.targetPorsi,
          kategoriPorsiList: l.kategoriPorsiList?.length
            ? l.kategoriPorsiList
            : (p.kategoriPorsiList?.length
              ? p.kategoriPorsiList
              : (p.kategoriPorsi ? [p.kategoriPorsi] : [])),
        })),
        acuanByKategori: acuanForPlan(p),
      })),
      menusById: menusMap as Parameters<typeof buildRencanaKebutuhanLines>[0]['menusById'],
      recipesById: recipesMap as Parameters<typeof buildRencanaKebutuhanLines>[0]['recipesById'],
      acuanByKategori: portionTargets,
    });
    if (built.errors.length && !built.lines.length) {
      toast.error(built.errors[0] || 'Gagal hitung kebutuhan');
      return;
    }
    if (built.errors.length) {
      toast.message(built.errors[0]);
    }
    const kitchensOnDay = [...new Set(
      dayPlans.map((p) => p.kitchenNama || p.kitchenId).filter(Boolean),
    )];
    setNeedsDoc({
      tanggal: tgl,
      kitchenLabel: kitchensOnDay.join(', ') || fallbackKitchen || 'Food Production',
      planNos: dayPlans.map((p) => p.noDokumen),
      lines: built.lines,
    });
    setNeedsOpen(true);
  }

  function openRencanaKebutuhan(row: PlanRow) {
    openRencanaKebutuhanForDate(row.tanggal, row.kitchenNama || row.kitchenId || '');
  }

  async function printRencanaKebutuhan() {
    if (!needsDoc) return;
    setNeedsPrinting(true);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 80));
      });
      await printDocument(RENCANA_KEBUTUHAN_PRINT_ID);
    } finally {
      setNeedsPrinting(false);
    }
  }

  async function changeStatus(row: PlanRow, status: ProductionPlanStatus) {
    try {
      if (status === 'PROCESSING') {
        const ready = readinessById[row.id] || await fetchReadiness(row.id);
        if (ready && !ready.issueCompleted) {
          if (!ready.materialsReady) {
            throw new Error(
              `Tidak bisa diproses — masih kurang ${ready.shortageCount || '?'} item. Buat Draft Belanja dulu.`,
            );
          }
          throw new Error(
            'Tidak bisa diproses — barang belum dikeluarkan. Klik Keluarkan Barang dulu.',
          );
        }
      }
      if (status === 'COMPLETED') {
        const ready = readinessById[row.id] || await fetchReadiness(row.id);
        if (ready && !ready.resultCompleted) {
          throw new Error(
            ready.openResult
              ? `Selesaikan hasil produksi ${ready.openResult.noDokumen} dulu sebelum menutup rencana.`
              : 'Catat & selesaikan Hasil Produksi (HSL) dulu sebelum menutup rencana.',
          );
        }
      }
      const res = await fetch(`/api/production-plans/${row.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal ubah status');
      toast.success(`Status → ${PLAN_STATUS_LABELS[status]}`);
      await load();
      if (status === 'APPROVED') {
        const ready = await fetchReadiness(row.id);
        setExpandedId(row.id);
        if (ready?.materialsReady) {
          toast.message('Bahan lengkap — silakan Keluarkan Barang');
        } else if (ready && ready.shortageCount > 0) {
          toast.message(`Ada ${ready.shortageCount} item kurang — buat Draft Belanja`);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal ubah status');
    }
  }

  async function cancelPlan(row: PlanRow) {
    const okConfirm = await confirm({
      title: 'Batalkan rencana?',
      description: `${row.noDokumen} (${row.tanggal}) akan dibatalkan.`,
      confirmText: 'Batalkan',
      variant: 'destructive',
    });
    if (!okConfirm) return;
    try {
      const res = await fetch(`/api/production-plans/${row.id}`, {
        method: 'DELETE',
        headers: { ...actingTenantHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal membatalkan');
      toast.success('Rencana dibatalkan');
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membatalkan');
    }
  }

  function openHistory(row: PlanRow) {
    setHistoryRow(row);
    setHistoryOpen(true);
  }

  /** Hitung ulang MRP dari resep + acuan porsi terkini (koreksi explode tanpa acuan). */
  async function regenerateMrp(row: PlanRow) {
    const okConfirm = await confirm({
      title: 'Hitung ulang MRP?',
      description:
        `${row.noDokumen}: kebutuhan bahan dihitung ulang dari resep dan acuan porsi tanggal/dapur. `
        + 'MRP Disetujui tanpa PR/pengeluaran diganti dokumen baru (Draft). '
        + 'Jika sudah ada pengeluaran atau PR aktif, regenerasi ditolak.',
      confirmText: 'Hitung ulang',
      variant: 'warning',
    });
    if (!okConfirm) return;

    setRegeneratingMrpId(row.id);
    try {
      const res = await fetch('/api/material-requirements/regenerate-for-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({ productionPlanId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal hitung ulang MRP');

      const mrpNo = String(data.mrp?.noDokumen || '');
      const shortage = Number(data.mrp?.summary?.shortageCount || 0);
      if (data.mode === 'recalculate') {
        toast.success(
          `MRP ${mrpNo} dihitung ulang${data.acuanApplied ? ' (acuan porsi)' : ''}. Kekurangan: ${shortage}`,
        );
      } else if (data.mode === 'supersede') {
        toast.success(
          `MRP baru ${mrpNo} (Draft) menggantikan ${data.supersededNo || 'MRP lama'}. Ajukan & setujui ulang bila perlu.`,
        );
      } else {
        toast.success(`MRP ${mrpNo} dibuat. Kekurangan: ${shortage}`);
      }
      if (!data.acuanApplied) {
        toast.message('Acuan porsi tanggal/dapur belum diisi — pecah besar/kecil proporsional.');
      }
      await fetchReadiness(row.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gagal hitung ulang MRP';
      if (msg.includes('permintaan pembelian (PR) aktif')) {
        toast.error(msg, {
          description: 'Jika Draft PO dari rencana ini, gunakan Perbarui Draft PO.',
        });
      } else {
        toast.error(msg);
      }
    } finally {
      setRegeneratingMrpId(null);
    }
  }

  /** Kekurangan stok → explode → MRP → PR → Draft CPO (review wajib di PO ke Vendor). */
  async function procureShortage(row: PlanRow) {
    setProcuringId(row.id);
    try {
      const res = await fetch(`/api/production-plans/${row.id}/procure-shortage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          tanggalKedatangan: procureDateFromPlanTanggal(row.tanggal),
          catatan: `Dari rencana ${row.noDokumen}`,
        }),
      });
      const data = await res.json() as {
        error?: string;
        materialsReady?: boolean;
        linkedPo?: { id?: string; noPO?: string; status?: string };
        draftCpoId?: string;
        draftCpoNo?: string;
        poStatus?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(data?.error || 'Gagal buat draft belanja');

      if (data.linkedPo?.id) {
        const st = String(data.linkedPo.status || '').toUpperCase();
        toast.message(data.message || `PO ${data.linkedPo.noPO || ''} sudah ada`);
        router.push(poReviewUrl(data.linkedPo.id, st === 'DRAFT'));
        return;
      }
      if (data.materialsReady) {
        toast.success(data.message || 'Bahan lengkap — siap Ambil Bahan');
        void fetchReadiness(row.id);
        return;
      }

      const cpoId = String(data.draftCpoId || '');
      if (!cpoId) throw new Error('Draft PO tidak terbentuk');

      toast.success(
        data.message
          || `Draft PO ${data.draftCpoNo || ''} — edit baris belanja sebelum kirim`,
      );
      void fetchReadiness(row.id);
      router.push(poReviewUrl(cpoId, true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal buat draft belanja');
    } finally {
      setProcuringId(null);
    }
  }

  async function refreshProcureDraft(row: PlanRow) {
    const okConfirm = await confirm({
      title: 'Perbarui Draft PO?',
      description:
        `${row.noDokumen}: kebutuhan bahan dihitung ulang dari resep/acuan terkini. `
        + 'Draft PO lama diganti draft baru — review ulang sebelum kirim ke vendor.',
      confirmText: 'Perbarui',
      variant: 'warning',
    });
    if (!okConfirm) return;

    setRefreshingProcureId(row.id);
    try {
      const res = await fetch(`/api/production-plans/${row.id}/refresh-procure-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders() },
        body: JSON.stringify({
          tanggalKedatangan: procureDateFromPlanTanggal(row.tanggal),
          catatan: `Perbarui dari rencana ${row.noDokumen}`,
        }),
      });
      const data = await res.json() as {
        error?: string;
        materialsReady?: boolean;
        draftCpoId?: string;
        draftCpoNo?: string;
        message?: string;
      };
      if (!res.ok) throw new Error(data?.error || 'Gagal perbarui draft belanja');

      if (data.materialsReady) {
        toast.success(data.message || 'Bahan lengkap — siap Ambil Bahan');
        void fetchReadiness(row.id);
        return;
      }

      const cpoId = String(data.draftCpoId || '');
      if (!cpoId) throw new Error('Draft PO tidak terbentuk');

      toast.success(
        data.message
          || `Draft PO ${data.draftCpoNo || ''} diperbarui — review sebelum kirim`,
      );
      void fetchReadiness(row.id);
      router.push(poReviewUrl(cpoId, true));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal perbarui draft belanja');
    } finally {
      setRefreshingProcureId(null);
    }
  }

  const canSave = Boolean(
    form.tanggal
    && form.kitchenId
    && lines.some((l) => l.recipeId && l.kategoriPorsiList.length > 0),
  );
  const dayPorsi = filteredList.reduce((s, r) => s + (Number(r.totalTargetPorsi) || 0), 0);
  const dayPlansForConsolidate = !showAll && selectedDate ? filteredList : [];
  const consolidateEligible = dayPlansForConsolidate.filter(
    (r) => CONSOLIDATE_ELIGIBLE_STATUSES.has(r.status),
  );
  const canConsolidate = canManage && consolidateEligible.length >= 2;
  const selectedToMerge = dayPlansForConsolidate.filter((r) => consolidateIds.includes(r.id));
  const mergePreviewLines = mergeProductionPlanLines(selectedToMerge);
  const mergePreviewPorsi = totalTargetPorsi(mergePreviewLines);
  const mergeHasApproved = selectedToMerge.some((r) => r.status === 'APPROVED');

  function openConsolidate() {
    setConsolidateIds(consolidateEligible.map((r) => r.id));
    setConsolidateOpen(true);
  }

  async function submitConsolidate() {
    if (consolidating) return;
    const ids = selectedToMerge
      .filter((r) => CONSOLIDATE_ELIGIBLE_STATUSES.has(r.status))
      .map((r) => r.id);
    if (ids.length < 2) {
      toast.error('Pilih minimal 2 rencana untuk digabung');
      return;
    }
    setConsolidating(true);
    try {
      const res = await fetch('/api/production-plans/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...actingTenantHeaders(), ...actingKitchenHeaders() },
        body: JSON.stringify({ ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Gagal menggabungkan rencana');
      toast.success(
        `Digabung menjadi ${data.noDokumen}. ${ids.length} rencana lama dibatalkan.`,
      );
      setConsolidateOpen(false);
      await load();
      if (data?.id) setExpandedId(data.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menggabungkan rencana');
    } finally {
      setConsolidating(false);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays className="w-6 h-6" />
            Rencana Produksi
          </h1>
          <p className="text-sm text-slate-500">
            Pilih tanggal menu (distribusi pagi) → susun porsi · Barang datang &amp; masak malam H-1 · Disetujui + bahan lengkap → Ambil Bahan · Kekurangan → Buat Draft Belanja → review PO → Ajukan/Kirim vendor
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <select
            className="h-9 border rounded-md px-2 text-sm bg-white min-w-[9rem]"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            title="Filter status"
          >
            <option value="">Semua status</option>
            {(Object.keys(PLAN_STATUS_LABELS) as ProductionPlanStatus[]).map((s) => (
              <option key={s} value={s}>{PLAN_STATUS_LABELS[s]}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => router.push('/food-production/menu')}
            title="Master menu (bahan pangan + resep) untuk rencana"
          >
            <UtensilsCrossed className="h-4 w-4 mr-1" />
            Menu
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4 mr-1', loading && 'animate-spin')} />
            Muat ulang
          </Button>
          {canManage && (
            <Button
              size="sm"
              onClick={() => openCreate(selectedDate)}
              className="bg-orange-500 hover:bg-orange-600"
            >
              <Plus className="h-4 w-4 mr-1" />
              Buat Rencana
            </Button>
          )}
        </div>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      <PlanDateStrip
        plans={rows}
        month={month}
        onMonthChange={setMonth}
        selectedDate={selectedDate}
        onSelectDate={handleSelectDate}
        onCreateForDate={(d) => openCreate(d)}
        canCreate={canManage}
      />

      <div className={cn(
        'grid gap-4',
        portionPanelOpen
          ? 'lg:grid-cols-[minmax(220px,280px)_1fr]'
          : 'lg:grid-cols-[auto_1fr]',
      )}>
        {portionPanelOpen ? (
          <div className="bg-white border rounded-xl p-3 shadow-sm lg:max-w-[280px] relative">
            <div className="flex items-start justify-between gap-2 mb-1">
              <h2 className="font-semibold text-sm">Kategori Porsi</h2>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                title="Sembunyikan panel Kategori Porsi"
                onClick={() => setPortionPanelOpen(false)}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[11px] text-slate-500 mb-1">
              {formatPlanDateLabel(selectedDate)}
            </p>
            <p className="text-[11px] text-slate-500 mb-3">
              Acuan manual per tanggal{scopeKitchenId ? '' : ' — pilih dapur dulu'}.
              Dipakai saat buat rencana.
            </p>
            <ul className="space-y-1.5">
              {KATEGORI_PORSI_OPTIONS.map((opt) => (
                <li
                  key={opt.value}
                  className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50/70 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-800 leading-snug">{opt.label}</div>
                    {opt.hint ? (
                      <div className="text-[10px] text-slate-500 leading-snug">{opt.hint}</div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      disabled={!canManage || !scopeKitchenId || savingPortion}
                      className="h-7 w-[4.5rem] px-1.5 text-right text-sm font-semibold tabular-nums text-orange-700"
                      value={portionDraft[opt.value]}
                      onChange={(e) => setPortionDraft((prev) => ({
                        ...prev,
                        [opt.value]: e.target.value,
                      }))}
                      onBlur={() => {
                        const n = Math.max(0, Math.floor(Number(portionDraft[opt.value]) || 0));
                        const next = { ...portionTargets, [opt.value]: n };
                        if (n === portionTargets[opt.value]) return;
                        void savePortionTargets(next);
                      }}
                      aria-label={`Porsi ${opt.label}`}
                    />
                    <span className="text-[10px] text-slate-500 w-8">porsi</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="bg-white border rounded-xl shadow-sm p-1.5 flex lg:flex-col items-center gap-1 self-start">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              title="Tampilkan panel Kategori Porsi"
              onClick={() => setPortionPanelOpen(true)}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
            <span
              className="hidden lg:inline text-[10px] font-medium text-slate-500 writing-mode-vertical"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            >
              Kategori Porsi
            </span>
          </div>
        )}

        <div className="bg-white border rounded-xl p-4 shadow-sm flex flex-col min-h-[320px] min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div>
              <h2 className="font-semibold">{listTitle}</h2>
              {selectedDate && !showAll && (
                <p className="text-xs text-slate-500">
                  {formatPlanDateLabel(selectedDate)}
                  {filteredList.length > 0 && (
                    <span className="ml-2">· {filteredList.length} rencana · {dayPorsi} porsi</span>
                  )}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {selectedDate && (
                <Button variant="outline" size="sm" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Filter tanggal' : 'Lihat semua'}
                </Button>
              )}
              {selectedDate && canConsolidate && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openConsolidate}
                  title="Gabung beberapa RPN menjadi satu rencana"
                >
                  <Combine className="w-3 h-3 mr-1" /> Gabung rencana
                </Button>
              )}
              {selectedDate && canManage && (
                <Button
                  size="sm"
                  onClick={() => openCreate(selectedDate)}
                  className="bg-orange-500 hover:bg-orange-600"
                >
                  <Plus className="w-3 h-3 mr-1" /> Rencana baru
                </Button>
              )}
            </div>
          </div>

          {loading && (
            <p className="text-sm text-muted-foreground py-8 text-center">Memuat…</p>
          )}
          {!loading && filteredList.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground space-y-2">
              <p>
                {showAll
                  ? 'Belum ada rencana di bulan ini.'
                  : 'Tidak ada rencana pada tanggal ini.'}
              </p>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => openCreate(selectedDate)}>
                  <Plus className="h-3 w-3 mr-1" /> Buat rencana
                </Button>
              )}
            </div>
          )}

          <div className="space-y-2">
            {filteredList.map((row) => {
              const expanded = expandedId === row.id;
              const next = STATUS_NEXT[row.status];
              const kpList = row.kategoriPorsiList?.length
                ? row.kategoriPorsiList
                : (row.kategoriPorsi ? [row.kategoriPorsi] : []);
              const kpLabel = kategoriPorsiListLabel(kpList);
              return (
                <div key={row.id} className="border rounded-lg overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex flex-wrap items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50"
                    onClick={() => void toggleExpand(row)}
                  >
                    {expanded
                      ? <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                      : <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />}
                    <span className="font-mono text-xs font-medium">{row.noDokumen}</span>
                    <span className={cn(
                      'text-[11px] px-1.5 py-0.5 rounded border',
                      PLAN_STATUS_BADGE[row.status] || 'bg-slate-100',
                    )}>
                      {PLAN_STATUS_LABELS[row.status] || row.status}
                    </span>
                    <span className="text-sm text-slate-700 truncate">
                      {row.kitchenNama || row.kitchenId}
                    </span>
                    {kpList.length > 0 && (
                      <span className="text-[11px] text-slate-500 truncate max-w-[12rem]" title={kpLabel}>
                        {kpLabel}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
                      {row.totalTargetPorsi ?? 0} porsi · {(row.lines || []).length} resep
                    </span>
                  </button>

                  {expanded && (
                    <div className="border-t bg-slate-50/50 px-3 py-3 space-y-3">
                      <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                        <span>Menu / distribusi: <strong className="text-foreground">{row.tanggal}</strong></span>
                        <span>Masak malam: <strong className="text-foreground">{cookDateFromPlanTanggal(row.tanggal)}</strong></span>
                        <span>Barang datang: <strong className="text-foreground">{procureDateFromPlanTanggal(row.tanggal)}</strong></span>
                        {kpList.length > 0 && (
                          <span>
                            Kategori:{' '}
                            <strong className="text-foreground">{kpLabel}</strong>
                          </span>
                        )}
                        {row.kitchenWarehouseKode && (
                          <span>Gudang: {row.kitchenWarehouseKode}</span>
                        )}
                        {row.catatan && <span>Catatan: {row.catatan}</span>}
                      </div>

                      {canEditMaterialsForRow(row) && row.status === 'APPROVED' && (
                        <p className="text-[11px] text-amber-800 bg-amber-50/80 border border-amber-200/80 rounded px-2 py-1">
                          Qty bahan bisa diubah sampai PO dikirim ke vendor. Setelah ubah, gunakan Perbarui Draft PO.
                        </p>
                      )}

                      {planAkgById[row.id] && (
                        <div className="rounded-md border border-orange-200 bg-orange-50/70 px-3 py-2 text-xs text-slate-800">
                          <span className="font-medium">Est. AKG / porsi: </span>
                          <span className="tabular-nums">
                            ~{formatEstKcal(planAkgById[row.id].perPorsi.energiKcal)} kkal
                            {' · '}
                            {planAkgById[row.id].perPorsi.proteinG.toLocaleString('id-ID', { maximumFractionDigits: 1 })} g protein
                            {' · '}
                            {planAkgById[row.id].perPorsiAkgPct.energiKcal ?? 0}% energi AKG
                          </span>
                          {!!planAkgById[row.id].warnings.length && (
                            <span className="ml-2 text-amber-800">
                              ({planAkgById[row.id].warnings.join(' · ')})
                            </span>
                          )}
                        </div>
                      )}

                      <div className="rounded-md border bg-white overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/40">
                            <tr>
                              <th className="text-left p-2 font-medium w-8" />
                              <th className="text-left p-2 font-medium">Kode</th>
                              <th className="text-left p-2 font-medium">Resep</th>
                              <th className="text-center p-2 font-medium whitespace-nowrap">Buffer {RECIPE_NEED_BUFFER_PCT}%</th>
                              <th className="text-right p-2 font-medium">Porsi</th>
                              <th className="text-right p-2 font-medium whitespace-nowrap">Est. AKG</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(row.lines || []).map((l, idx) => {
                              const lineKp = l.kategoriPorsiList?.length
                                ? l.kategoriPorsiList
                                : (row.kategoriPorsiList?.length
                                  ? row.kategoriPorsiList
                                  : (row.kategoriPorsi ? [row.kategoriPorsi] : []));
                              const lineAkg = l.recipeId
                                ? planAkgById[row.id]?.lineEstimates?.find((e) => e.recipeId === l.recipeId)
                                : null;

                              if (l.recipeId) {
                                const rKey = recipeExpandKey(row.id, '_', l.recipeId);
                                const recipeOpen = !!expandedRecipeKeys[rKey];
                                const recipe = recipesById[l.recipeId];
                                const bufferPct = getRecipeBufferPct(row.recipeBufferPct, l.recipeId);
                                const bufferOn = bufferPct > 0;
                                const bufferBusy = savingBufferKey === `${row.id}::${l.recipeId}`;
                                const ingredients = recipe
                                  ? recipeIngredientNeeds({
                                    recipe: {
                                      yieldQty: recipe.yieldQty,
                                      wastePct: recipe.wastePct,
                                      lines: recipe.lines as Parameters<typeof recipeIngredientNeeds>[0]['recipe']['lines'],
                                    },
                                    menuTargetPorsi: Number(l.targetPorsi) || 0,
                                    recipePerMenuPorsi: 1,
                                    kategoriPorsiList: lineKp,
                                    acuanByKategori: acuanForPlan(row),
                                    bufferPct,
                                  })
                                  : [];
                                return (
                                  <Fragment key={`recipe-${l.recipeId}-${idx}`}>
                                    <tr
                                      className="border-t cursor-pointer hover:bg-muted/30"
                                      onClick={() => toggleRecipeExpand(row.id, '_', l.recipeId!)}
                                    >
                                      <td className="p-2 w-8">
                                        {recipeOpen
                                          ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                                          : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                                      </td>
                                      <td className="p-2 font-mono text-xs">
                                        {l.recipeKode || recipe?.kode || '—'}
                                      </td>
                                      <td className="p-2">
                                        <span className="font-medium">
                                          {l.recipeNama || recipe?.nama || l.recipeId}
                                        </span>
                                        {ingredients.length > 0 && (
                                          <span className="ml-2 text-[11px] text-muted-foreground">
                                            {ingredients.length} bahan
                                          </span>
                                        )}
                                        {bufferOn && (
                                          <span className="ml-2 text-[10px] text-amber-700 font-medium">
                                            +{bufferPct}%
                                          </span>
                                        )}
                                        {recipeYieldOneWarning(
                                          Number(recipe?.yieldQty) || 1,
                                          Number(l.targetPorsi) || 0,
                                        ) && (
                                          <p className="mt-1 text-[10px] leading-snug text-amber-800">
                                            {recipeYieldOneWarning(
                                              Number(recipe?.yieldQty) || 1,
                                              Number(l.targetPorsi) || 0,
                                            )}
                                          </p>
                                        )}
                                      </td>
                                      <td
                                        className="p-2 text-center"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <input
                                          type="checkbox"
                                          className="h-3.5 w-3.5 accent-amber-600"
                                          checked={bufferOn}
                                          disabled={!canManage || !isPlanEditable(row.status) || bufferBusy}
                                          title={`Buffer ${RECIPE_NEED_BUFFER_PCT}% — tambah kebutuhan tiap bahan`}
                                          onChange={(e) => {
                                            void toggleRecipeBuffer(row, l.recipeId!, e.target.checked);
                                          }}
                                        />
                                      </td>
                                      <td className="p-2 text-right font-medium">{l.targetPorsi}</td>
                                      <td
                                        className="p-2 text-right text-[11px] leading-tight tabular-nums text-slate-700"
                                        title={lineAkg?.perPorsi
                                          ? `${lineAkg.perPorsi.energiKcal} kkal · ${lineAkg.perPorsi.proteinG} g protein / porsi`
                                          : undefined}
                                      >
                                        {lineAkg?.perPorsi ? (
                                          <>
                                            <div className="font-medium">~{formatEstKcal(lineAkg.perPorsi.energiKcal)} kkal</div>
                                            <div className="text-muted-foreground">
                                              {lineAkg.perPorsiAkgPct?.energiKcal ?? 0}% AKG
                                            </div>
                                          </>
                                        ) : '—'}
                                      </td>
                                    </tr>
                                    {recipeOpen && ingredients.map((ing) => {
                                      const stock = stockByProductId[ing.productId];
                                      const stockLoading = !!stockFetchPending[ing.productId];
                                      const qtyKering = Number(stock?.GKERING) || 0;
                                      const qtyBasah = Number(stock?.GBASAH) || 0;
                                      const excluded = getPlanOverride(row, l.recipeId!, ing.productId)?.excluded === true;
                                      return (
                                        <tr
                                          key={`${l.recipeId}-${ing.productId}`}
                                          className={cn(
                                            'border-t bg-white',
                                            excluded && 'bg-slate-50/80 opacity-70',
                                          )}
                                        >
                                          {renderExcludeCheckbox({
                                            row,
                                            recipeId: l.recipeId!,
                                            ing,
                                          })}
                                          <td className={cn(
                                            'p-2 font-mono text-[11px] text-slate-500',
                                            excluded && 'line-through',
                                          )}>
                                            <div className="border-l-2 border-orange-200 pl-5 ml-1">
                                              {ing.productKode || '—'}
                                            </div>
                                          </td>
                                          <td className={cn(
                                            'p-2 text-xs text-slate-600',
                                            excluded && 'line-through text-slate-400',
                                          )}>
                                            <div className="pl-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                              <span>
                                                {ing.productNama || ing.productId}
                                                {excluded && (
                                                  <span className="ml-1.5 text-[10px] text-slate-500 no-underline">
                                                    dicoret
                                                  </span>
                                                )}
                                                {!excluded && (Number(ing.qtyBesarPart) > 0 && Number(ing.qtyKecilPart) > 0) && (
                                                  <span className="ml-1.5 text-[10px] text-slate-400">
                                                    (besar {formatNumber(ing.qtyBesarPart)}
                                                    {' · '}
                                                    kecil {formatNumber(ing.qtyKecilPart)})
                                                  </span>
                                                )}
                                              </span>
                                              {!excluded && stockLoading && (
                                                <span className="text-[10px] text-slate-400">
                                                  cek stok…
                                                </span>
                                              )}
                                              {!excluded && !stockLoading && stock && qtyKering > 0 && (
                                                <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] leading-tight text-emerald-800 tabular-nums no-underline">
                                                  Stok — {formatNumber(qtyKering)}
                                                  {ing.satuan ? ` ${ing.satuan}` : ''} di GKERING
                                                </span>
                                              )}
                                              {!excluded && !stockLoading && stock && qtyBasah > 0 && (
                                                <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] leading-tight text-sky-800 tabular-nums no-underline">
                                                  Stok — {formatNumber(qtyBasah)}
                                                  {ing.satuan ? ` ${ing.satuan}` : ''} di GBASAH
                                                </span>
                                              )}
                                            </div>
                                          </td>
                                          {renderIngredientQtyCell({
                                            row,
                                            recipeId: l.recipeId!,
                                            ing,
                                          })}
                                          <td className="p-2" />
                                        </tr>
                                      );
                                    })}
                                    {recipeOpen && !recipe && (
                                      <tr className="border-t bg-white">
                                        <td colSpan={6} className="p-2 pl-14 text-xs text-muted-foreground">
                                          Detail resep belum termuat
                                        </td>
                                      </tr>
                                    )}
                                    {recipeOpen && recipe && ingredients.length === 0 && (
                                      <tr className="border-t bg-white">
                                        <td colSpan={6} className="p-2 pl-14 text-xs text-muted-foreground">
                                          Resep belum punya baris bahan
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              }

                              const children = menuChildren(l.menuId || '');
                              const mKey = menuExpandKey(row.id, l.menuId || '');
                              const menuOpen = !!expandedMenuKeys[mKey];
                              const hasChildren = children.length > 0;
                              return (
                                <Fragment key={`menu-${l.menuId}-${idx}`}>
                                  <tr
                                    className="border-t cursor-pointer hover:bg-muted/30"
                                    onClick={() => toggleMenuExpand(row.id, l.menuId || '')}
                                  >
                                    <td className="p-2 w-8">
                                      {menuOpen
                                        ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                                        : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                                    </td>
                                    <td className="p-2 font-mono text-xs">{l.menuKode || '—'}</td>
                                    <td className="p-2">
                                      <span className="font-medium">
                                        {l.menuNama || l.menuId}
                                      </span>
                                      <span className="ml-2 text-[11px] text-amber-700">menu lama</span>
                                      {hasChildren && (
                                        <span className="ml-2 text-[11px] text-muted-foreground">
                                          {children.length} resep
                                        </span>
                                      )}
                                    </td>
                                    <td className="p-2" />
                                    <td className="p-2 text-right font-medium">{l.targetPorsi}</td>
                                    <td className="p-2 text-right text-[11px] text-muted-foreground">—</td>
                                  </tr>
                                  {menuOpen && hasChildren && children.map((child) => {
                                    const recipeOpen = !!expandedRecipeKeys[
                                      recipeExpandKey(row.id, l.menuId || '', child.recipeId)
                                    ];
                                    const recipe = recipesById[child.recipeId];
                                    const bufferPct = getRecipeBufferPct(row.recipeBufferPct, child.recipeId);
                                    const bufferOn = bufferPct > 0;
                                    const bufferBusy = savingBufferKey === `${row.id}::${child.recipeId}`;
                                    const ingredients = recipe
                                      ? recipeIngredientNeeds({
                                        recipe: {
                                          yieldQty: recipe.yieldQty,
                                          wastePct: recipe.wastePct,
                                          lines: recipe.lines as Parameters<typeof recipeIngredientNeeds>[0]['recipe']['lines'],
                                        },
                                        menuTargetPorsi: Number(l.targetPorsi) || 0,
                                        recipePerMenuPorsi: Number(child.porsi) || 1,
                                        kategoriPorsiList: lineKp,
                                        acuanByKategori: acuanForPlan(row),
                                        bufferPct,
                                      })
                                      : [];
                                    return (
                                      <Fragment key={`${l.menuId}-${child.recipeId}`}>
                                        <tr
                                          className="border-t bg-slate-50/80 cursor-pointer hover:bg-slate-100/80"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleRecipeExpand(row.id, l.menuId || '', child.recipeId);
                                          }}
                                        >
                                          <td className="p-2 w-8">
                                            <div className="pl-2">
                                              {recipeOpen
                                                ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                                                : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
                                            </div>
                                          </td>
                                          <td className="p-2 pl-2 font-mono text-xs text-muted-foreground">
                                            <div className="flex items-center gap-2 border-l-2 border-slate-200 pl-3">
                                              {child.recipeKode || recipe?.kode || '—'}
                                            </div>
                                          </td>
                                          <td className="p-2 text-muted-foreground">
                                            <div className="pl-1">
                                              {child.recipeNama || recipe?.nama || child.recipeId}
                                              <span className="ml-2 text-[11px]">
                                                ×{child.porsi} per porsi menu
                                              </span>
                                              {ingredients.length > 0 && (
                                                <span className="ml-2 text-[11px] text-slate-400">
                                                  {ingredients.length} bahan
                                                </span>
                                              )}
                                              {bufferOn && (
                                                <span className="ml-2 text-[10px] text-amber-700 font-medium">
                                                  +{bufferPct}%
                                                </span>
                                              )}
                                              {recipeYieldOneWarning(
                                                Number(recipe?.yieldQty) || 1,
                                                Number(l.targetPorsi) || 0,
                                              ) && (
                                                <p className="mt-1 text-[10px] leading-snug text-amber-800">
                                                  {recipeYieldOneWarning(
                                                    Number(recipe?.yieldQty) || 1,
                                                    Number(l.targetPorsi) || 0,
                                                  )}
                                                </p>
                                              )}
                                            </div>
                                          </td>
                                          <td
                                            className="p-2 text-center"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <input
                                              type="checkbox"
                                              className="h-3.5 w-3.5 accent-amber-600"
                                              checked={bufferOn}
                                              disabled={!canManage || !isPlanEditable(row.status) || bufferBusy}
                                              title={`Buffer ${RECIPE_NEED_BUFFER_PCT}% — tambah kebutuhan tiap bahan`}
                                              onChange={(e) => {
                                                void toggleRecipeBuffer(row, child.recipeId, e.target.checked);
                                              }}
                                            />
                                          </td>
                                          <td className="p-2 text-right text-muted-foreground tabular-nums">
                                            {Number(l.targetPorsi) * Number(child.porsi || 1)}
                                          </td>
                                          <td
                                            className="p-2 text-right text-[11px] leading-tight tabular-nums text-slate-600"
                                          >
                                            {(() => {
                                              const childAkg = planAkgById[row.id]?.lineEstimates?.find(
                                                (e) => e.recipeId === child.recipeId,
                                              );
                                              if (!childAkg?.perPorsi) return '—';
                                              return (
                                                <>
                                                  <div className="font-medium">
                                                    ~{formatEstKcal(childAkg.perPorsi.energiKcal)} kkal
                                                  </div>
                                                  <div className="text-muted-foreground">
                                                    {childAkg.perPorsiAkgPct?.energiKcal ?? 0}% AKG
                                                  </div>
                                                </>
                                              );
                                            })()}
                                          </td>
                                        </tr>
                                        {recipeOpen && ingredients.map((ing) => {
                                          const stock = stockByProductId[ing.productId];
                                          const stockLoading = !!stockFetchPending[ing.productId];
                                          const qtyKering = Number(stock?.GKERING) || 0;
                                          const qtyBasah = Number(stock?.GBASAH) || 0;
                                          const excluded = getPlanOverride(row, child.recipeId, ing.productId)?.excluded === true;
                                          return (
                                            <tr
                                              key={`${child.recipeId}-${ing.productId}`}
                                              className={cn(
                                                'border-t bg-white',
                                                excluded && 'bg-slate-50/80 opacity-70',
                                              )}
                                            >
                                              {renderExcludeCheckbox({
                                                row,
                                                recipeId: child.recipeId,
                                                ing,
                                              })}
                                              <td className={cn(
                                                'p-2 font-mono text-[11px] text-slate-500',
                                                excluded && 'line-through',
                                              )}>
                                                <div className="border-l-2 border-orange-200 pl-5 ml-1">
                                                  {ing.productKode || '—'}
                                                </div>
                                              </td>
                                              <td className={cn(
                                                'p-2 text-xs text-slate-600',
                                                excluded && 'line-through text-slate-400',
                                              )}>
                                                <div className="pl-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                                  <span>
                                                    {ing.productNama || ing.productId}
                                                    {excluded && (
                                                      <span className="ml-1.5 text-[10px] text-slate-500 no-underline">
                                                        dicoret
                                                      </span>
                                                    )}
                                                    {!excluded && (Number(ing.qtyBesarPart) > 0 && Number(ing.qtyKecilPart) > 0) && (
                                                      <span className="ml-1.5 text-[10px] text-slate-400">
                                                        (besar {formatNumber(ing.qtyBesarPart)}
                                                        {' · '}
                                                        kecil {formatNumber(ing.qtyKecilPart)})
                                                      </span>
                                                    )}
                                                  </span>
                                                  {!excluded && stockLoading && (
                                                    <span className="text-[10px] text-slate-400">
                                                      cek stok…
                                                    </span>
                                                  )}
                                                  {!excluded && !stockLoading && stock && qtyKering > 0 && (
                                                    <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] leading-tight text-emerald-800 tabular-nums no-underline">
                                                      Stok — {formatNumber(qtyKering)}
                                                      {ing.satuan ? ` ${ing.satuan}` : ''} di GKERING
                                                    </span>
                                                  )}
                                                  {!excluded && !stockLoading && stock && qtyBasah > 0 && (
                                                    <span className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] leading-tight text-sky-800 tabular-nums no-underline">
                                                      Stok — {formatNumber(qtyBasah)}
                                                      {ing.satuan ? ` ${ing.satuan}` : ''} di GBASAH
                                                    </span>
                                                  )}
                                                </div>
                                              </td>
                                              {renderIngredientQtyCell({
                                                row,
                                                recipeId: child.recipeId,
                                                ing,
                                              })}
                                              <td className="p-2" />
                                            </tr>
                                          );
                                        })}
                                        {recipeOpen && !recipe && (
                                          <tr className="border-t bg-white">
                                            <td colSpan={6} className="p-2 pl-14 text-xs text-muted-foreground">
                                              Detail resep belum termuat
                                            </td>
                                          </tr>
                                        )}
                                        {recipeOpen && recipe && ingredients.length === 0 && (
                                          <tr className="border-t bg-white">
                                            <td colSpan={6} className="p-2 pl-14 text-xs text-muted-foreground">
                                              Resep belum punya baris bahan
                                            </td>
                                          </tr>
                                        )}
                                      </Fragment>
                                    );
                                  })}
                                  {menuOpen && !hasChildren && (
                                    <tr className="border-t bg-slate-50/80">
                                      <td colSpan={5} className="p-2 pl-10 text-xs text-muted-foreground">
                                        Menu belum punya resep anak
                                      </td>
                                    </tr>
                                  )}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="flex flex-wrap gap-1 items-center">
                        <Button variant="ghost" size="sm" onClick={() => openHistory(row)} title="Riwayat">
                          <History className="h-4 w-4 mr-1" /> Riwayat
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openRencanaKebutuhan(row)}
                          title="Draft dokumen kebutuhan bahan hari ini"
                        >
                          <FileText className="h-4 w-4 mr-1" /> Rencana Kebutuhan
                        </Button>
                        {canManage && MRP_ELIGIBLE_PLAN_STATUSES.has(row.status) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={regeneratingMrpId === row.id}
                            title="Hitung ulang MRP dari resep + acuan porsi"
                            onClick={() => void regenerateMrp(row)}
                          >
                            <RefreshCw className={cn(
                              'h-4 w-4 mr-1',
                              regeneratingMrpId === row.id && 'animate-spin',
                            )} />
                            {regeneratingMrpId === row.id ? 'Menghitung…' : 'Hitung ulang MRP'}
                          </Button>
                        )}
                        {ISSUE_ELIGIBLE_PLAN_STATUSES.has(row.status) && (() => {
                          const ready = readinessById[row.id];
                          if (ready?.loading) {
                            return (
                              <span className="text-xs text-muted-foreground px-2">Cek stok…</span>
                            );
                          }
                          if (ready?.error) {
                            return (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => void fetchReadiness(row.id)}
                              >
                                Cek ulang stok
                              </Button>
                            );
                          }
                          if (ready?.materialsReady) {
                            if (ready.issueCompleted) {
                              return (
                                <span className="text-xs text-emerald-600 px-1">
                                  Barang sudah dikeluarkan{ready.completedIssueNo ? ` (${ready.completedIssueNo})` : ''}
                                </span>
                              );
                            }
                            return (
                              <Button
                                variant="outline"
                                size="sm"
                                title="Keluarkan barang dari gudang untuk produksi"
                                onClick={() => router.push(`/stok/pengeluaran?mode=produksi&productionPlanId=${row.id}`)}
                              >
                                <ArrowUpFromLine className="h-4 w-4 mr-1" />
                                {ready.openIssue
                                  ? `Lanjutkan Pengeluaran ${ready.openIssue.noDokumen || ''}`
                                  : 'Keluarkan Barang'}
                              </Button>
                            );
                          }
                          if (ready && ready.shortageCount > 0) {
                            const poReceived = ['RECEIVED', 'INVOICED', 'FULFILLED', 'PARTIAL'].includes(
                              String(ready.linkedPo?.status || '').toUpperCase(),
                            );
                            const linkedPoStatus = String(ready.linkedPo?.status || '').toUpperCase();
                            const linkedPoDraft = linkedPoStatus === 'DRAFT';
                            const linkedPoRefreshable = linkedPoDraft || linkedPoStatus === 'REJECTED';
                            return (
                              <>
                                <button
                                  type="button"
                                  className="text-xs text-destructive px-1 underline-offset-2 hover:underline font-medium"
                                  title="Lihat detail item yang kurang"
                                  onClick={() => {
                                    setShortageDetail({
                                      noDokumen: row.noDokumen,
                                      count: ready.shortageCount,
                                      lines: ready.shortageLines || [],
                                    });
                                    setShortageDetailOpen(true);
                                  }}
                                >
                                  Kurang {ready.shortageCount} item
                                </button>
                                {linkedPoDraft && (
                                  <span className="text-xs text-amber-700 px-1 font-medium">
                                    Draft PO menunggu review
                                  </span>
                                )}
                                {poReceived && (
                                  <span className="text-xs text-amber-700 px-1">
                                    PO sudah diterima — cek qty/stok gudang produk
                                  </span>
                                )}
                                {ready.linkedPo?.id ? (
                                  <>
                                    {linkedPoDraft ? (
                                      <Button
                                        variant="default"
                                        size="sm"
                                        onClick={() => router.push(poReviewUrl(ready.linkedPo!.id, true))}
                                      >
                                        <ShoppingBag className="h-4 w-4 mr-1" />
                                        Edit Draft PO {ready.linkedPo.noPO || ''}
                                      </Button>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => router.push(poReviewUrl(ready.linkedPo!.id))}
                                      >
                                        <ShoppingBag className="h-4 w-4 mr-1" />
                                        Lihat PO {ready.linkedPo.noPO || ''}
                                      </Button>
                                    )}
                                    {canManage && linkedPoRefreshable && (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={refreshingProcureId === row.id}
                                        onClick={() => void refreshProcureDraft(row)}
                                      >
                                        <RefreshCw className={cn(
                                          'h-4 w-4 mr-1',
                                          refreshingProcureId === row.id && 'animate-spin',
                                        )} />
                                        {refreshingProcureId === row.id ? 'Memperbarui…' : 'Perbarui Draft PO'}
                                      </Button>
                                    )}
                                  </>
                                ) : canManage ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={procuringId === row.id}
                                    onClick={() => void procureShortage(row)}
                                  >
                                    <ShoppingBag className="h-4 w-4 mr-1" />
                                    {procuringId === row.id ? 'Menyiapkan draft…' : 'Buat Draft Belanja'}
                                  </Button>
                                ) : null}
                              </>
                            );
                          }
                          return (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void fetchReadiness(row.id)}
                            >
                              Cek kesiapan bahan
                            </Button>
                          );
                        })()}
                        {(ISSUE_ELIGIBLE_PLAN_STATUSES.has(row.status) || row.status === 'COMPLETED') && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => router.push(`/food-production/report?productionPlanId=${row.id}`)}
                          >
                            <ClipboardList className="h-4 w-4 mr-1" /> Laporan
                          </Button>
                        )}
                        {(row.status === 'COMPLETED'
                          || ((row.status === 'APPROVED' || row.status === 'PROCESSING')
                            && readinessById[row.id]?.issueCompleted)) && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              title={
                                readinessById[row.id]?.openResult
                                  ? `Lanjutkan ${readinessById[row.id]?.openResult?.noDokumen}`
                                  : readinessById[row.id]?.resultCompleted
                                    ? `Lihat ${readinessById[row.id]?.completedResultNo || 'hasil'}`
                                    : 'Catat hasil produksi (actual porsi)'
                              }
                              onClick={() => {
                                const ready = readinessById[row.id];
                                if (ready?.openResult?.id) {
                                  router.push(`/food-production/result?highlight=${ready.openResult.id}`);
                                  return;
                                }
                                if (ready?.resultCompleted) {
                                  router.push(`/food-production/result?productionPlanId=${row.id}`);
                                  return;
                                }
                                router.push(`/food-production/result?productionPlanId=${row.id}`);
                              }}
                            >
                              <Factory className="h-4 w-4 mr-1" /> Hasil
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={row.status !== 'COMPLETED'}
                              title={row.status !== 'COMPLETED' ? 'Aktif setelah rencana selesai' : 'Proses distribusi'}
                              onClick={() => router.push(`/food-production/distribution?productionPlanId=${row.id}`)}
                            >
                              <Truck className="h-4 w-4 mr-1" /> Distribusi
                            </Button>
                          </>
                        )}
                        {canManage && isPlanEditable(row.status) && (
                          <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                            <Pencil className="h-4 w-4 mr-1" /> Ubah
                          </Button>
                        )}
                        {canManage && next && (
                          row.status === 'DRAFT'
                          || row.status === 'SUBMITTED'
                          || (row.status === 'APPROVED'
                            && Boolean(
                              readinessById[row.id]
                              && !readinessById[row.id].loading
                              && readinessById[row.id].materialsReady
                              && readinessById[row.id].issueCompleted,
                            ))
                          || (row.status === 'PROCESSING'
                            && Boolean(
                              readinessById[row.id]
                              && !readinessById[row.id].loading
                              && readinessById[row.id].resultCompleted,
                            ))
                        ) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void changeStatus(row, next)}
                          >
                            {STATUS_NEXT_LABEL[row.status] || 'Lanjut'}
                          </Button>
                        )}
                        {canManage && row.status === 'APPROVED' && readinessById[row.id]
                          && !readinessById[row.id].loading
                          && !readinessById[row.id].materialsReady && (
                          <span className="text-xs text-muted-foreground px-1">
                            Diproses terkunci sampai bahan lengkap
                          </span>
                        )}
                        {canManage && row.status === 'APPROVED' && readinessById[row.id]
                          && !readinessById[row.id].loading
                          && readinessById[row.id].materialsReady
                          && !readinessById[row.id].issueCompleted && (
                          <span className="text-xs text-muted-foreground px-1">
                            Tombol Diproses terbuka setelah barang dikeluarkan
                          </span>
                        )}
                        {canManage && row.status === 'PROCESSING' && readinessById[row.id]
                          && !readinessById[row.id].loading
                          && !readinessById[row.id].resultCompleted && (
                          <span className="text-xs text-muted-foreground px-1">
                            {readinessById[row.id].openResult
                              ? `Selesaikan HSL ${readinessById[row.id].openResult?.noDokumen} untuk menutup rencana`
                              : 'Catat Hasil Produksi dulu sebelum Selesai'}
                          </span>
                        )}
                        {canManage && row.status === 'SUBMITTED' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void changeStatus(row, 'DRAFT')}
                          >
                            Kembalikan
                          </Button>
                        )}
                        {canManage && row.status !== 'CANCELLED' && row.status !== 'COMPLETED' && (
                          <Button variant="ghost" size="sm" onClick={() => void cancelPlan(row)}>
                            <Trash2 className="h-4 w-4 text-destructive mr-1" /> Batalkan
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {!loading && filteredList.length > 0 && !showAll && selectedDate && (
            <div className="mt-4 pt-3 border-t flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Dokumen kebutuhan bahan untuk tanggal yang dipilih.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-orange-300 text-orange-700 hover:bg-orange-50"
                onClick={() => openRencanaKebutuhanForDate(selectedDate)}
              >
                <FileText className="h-3.5 w-3.5 mr-1" />
                Rencana Kebutuhan
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={consolidateOpen} onOpenChange={setConsolidateOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Gabung rencana</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {selectedDate ? formatPlanDateLabel(selectedDate) : ''}
            {dayPlansForConsolidate[0]?.kitchenNama
              ? ` · ${dayPlansForConsolidate[0].kitchenNama}`
              : ''}
            {' · pilih RPN yang mau digabung'}
          </p>
          <div className="space-y-2 py-1">
            {dayPlansForConsolidate.map((row) => {
              const eligible = CONSOLIDATE_ELIGIBLE_STATUSES.has(row.status);
              const blocked = eligible ? null : consolidateBlockedReason(row.status);
              const checked = consolidateIds.includes(row.id);
              return (
                <label
                  key={row.id}
                  className={cn(
                    'flex items-start gap-2 rounded-md border p-2 text-sm',
                    !eligible && 'opacity-60',
                    checked && eligible && 'border-orange-300 bg-orange-50/50',
                  )}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    disabled={!eligible || consolidating}
                    onCheckedChange={(v) => {
                      const on = v === true;
                      setConsolidateIds((prev) => {
                        if (on) return prev.includes(row.id) ? prev : [...prev, row.id];
                        return prev.filter((id) => id !== row.id);
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-medium">{row.noDokumen}</span>
                      <span className={cn(
                        'rounded-full px-1.5 py-0 text-[10px]',
                        PLAN_STATUS_BADGE[row.status] || 'bg-slate-100',
                      )}>
                        {PLAN_STATUS_LABELS[row.status] || row.status}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-600">
                      {summarizePlanLines(row.lines)} · {row.totalTargetPorsi ?? 0} porsi
                    </span>
                    {blocked && (
                      <span className="mt-0.5 block text-[10px] text-amber-800">{blocked}</span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          {selectedToMerge.length >= 2 && (
            <p className="text-xs text-slate-600">
              Hasil: {mergePreviewLines.length} resep · {mergePreviewPorsi} porsi
            </p>
          )}
          {mergeHasApproved && (
            <p className="text-xs text-amber-800">
              Ada RPN Disetujui — hasil gabungan menjadi Draft dan perlu diajukan/disetujui lagi.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={consolidating}
              onClick={() => setConsolidateOpen(false)}
            >
              Batal
            </Button>
            <Button
              className="bg-orange-500 hover:bg-orange-600"
              disabled={consolidating || selectedToMerge.length < 2}
              onClick={() => void submitConsolidate()}
            >
              {consolidating ? 'Menggabung…' : 'Gabung'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
            return;
          }
          // Klik luar / Escape / X → autosave bila form valid; Batal pakai setOpen(false) langsung (buang).
          if (saving) return;
          if (!canSave) {
            setOpen(false);
            return;
          }
          void save();
        }}
      >
        <DialogContent className="max-w-5xl w-[min(96vw,64rem)] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Ubah Rencana' : 'Buat Rencana Produksi'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Tanggal menu / distribusi *</Label>
              <Input
                type="date"
                value={form.tanggal}
                onChange={(e) => setForm((f) => ({ ...f, tanggal: e.target.value }))}
              />
              {form.tanggal && (
                <p className="text-[11px] text-muted-foreground">
                  Masak malam {cookDateFromPlanTanggal(form.tanggal)}
                  {' · '}barang datang {procureDateFromPlanTanggal(form.tanggal)}
                  {' · '}distribusi pagi {form.tanggal}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Dapur *</Label>
              <select
                className="w-full border rounded-md px-3 py-2 text-sm bg-white"
                value={form.kitchenId}
                onChange={(e) => setForm((f) => ({ ...f, kitchenId: e.target.value }))}
              >
                <option value="">— Pilih dapur —</option>
                {kitchens.map((k) => (
                  <option key={k.id} value={k.id}>{k.nama}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Catatan</Label>
              <Input
                value={form.catatan}
                onChange={(e) => setForm((f) => ({ ...f, catatan: e.target.value }))}
                placeholder="Opsional"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Label>Resep × porsi</Label>
                <p className="text-xs text-muted-foreground">
                  Pilih kategori (multi) dan resep — porsi mengikuti acuan kategori.
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => router.push('/food-production/recipe')}
                >
                  <UtensilsCrossed className="h-3 w-3 mr-1" />
                  Kelola resep
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLines((prev) => [...prev, emptyLine()])}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Baris
                </Button>
              </div>
            </div>

            <div className="rounded-md border bg-orange-50/60 border-orange-200/80 px-3 py-2.5 space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-700">
                  <span className="font-medium text-slate-900">Deskripsi porsi: </span>
                  {draftPorsiDescription.parts.length
                    ? `${draftPorsiDescription.parts.join(' · ')} · total ${draftPorsiDescription.total.toLocaleString('id-ID')} porsi`
                    : 'Belum ada kategori/porsi'}
                </p>
                <select
                  className="h-7 border rounded-md px-2 text-[11px] bg-white"
                  value={planAkgProfile}
                  onChange={(e) => setPlanAkgProfile(e.target.value)}
                  title="Target AKG Tabel 2 MBG (penyebut %); isi porsi dihitung dari TKPI × qty besar/kecil"
                >
                  <option value="PORSI_KECIL">Target Porsi Kecil Sekolah (340 kkal)</option>
                  <option value="PORSI_BESAR">Target Porsi Besar Sekolah (762 kkal)</option>
                </select>
              </div>
              <p className="text-sm text-slate-900">
                <span className="font-medium">Est. isi porsi (TKPI) vs target MBG: </span>
                {draftAkgLoading && <span className="text-muted-foreground text-xs">menghitung…</span>}
                {!draftAkgLoading && draftAkg && (
                  <span className="tabular-nums">
                    ~{formatEstKcal(draftAkg.perPorsi.energiKcal)} kkal
                    {' · '}
                    {draftAkg.perPorsi.proteinG.toLocaleString('id-ID', { maximumFractionDigits: 1 })} g protein
                    {' · '}
                    {draftAkg.perPorsiAkgPct.energiKcal ?? 0}% energi
                    {' · '}
                    {draftAkg.perPorsiAkgPct.proteinG ?? 0}% protein
                  </span>
                )}
                {!draftAkgLoading && !draftAkg && (
                  <span className="text-muted-foreground text-xs">isi resep + porsi untuk estimasi</span>
                )}
              </p>
              <p className="text-[10px] text-slate-600">
                Qty bahan: Porsi Besar Sekolah/Posyandu = 100%; Kecil Sekolah/Posyandu = % dari qty besar (resep). Target 90–120% energi &amp; protein MBG.
              </p>
              {!!draftAkg?.warnings?.length && (
                <p className="text-[11px] text-amber-800">{draftAkg.warnings.join(' · ')}</p>
              )}
            </div>

            <div className="hidden sm:grid sm:grid-cols-[minmax(12rem,1.1fr)_minmax(14rem,1.5fr)_6.5rem_7.5rem_2.5rem] gap-3 px-1 text-[11px] font-medium text-muted-foreground">
              <span>Kategori porsi *</span>
              <span>Resep *</span>
              <span className="text-right pr-1">Porsi</span>
              <span className="text-right pr-1">Est. AKG</span>
              <span />
            </div>

            <div className="space-y-2">
              {lines.map((line, idx) => {
                const draftLinePos = lines
                  .map((l, i) => ({ l, i }))
                  .filter(({ l }) => l.recipeId && (Number(l.targetPorsi) || 0) > 0)
                  .findIndex(({ i }) => i === idx);
                const lineEst = draftLinePos >= 0
                  ? draftAkg?.lineEstimates?.[draftLinePos]
                  : undefined;
                return (
                <div
                  key={idx}
                  className="grid gap-3 sm:grid-cols-[minmax(12rem,1.1fr)_minmax(14rem,1.5fr)_6.5rem_7.5rem_2.5rem] sm:items-start border rounded-lg px-3 py-2.5 bg-white"
                >
                  <div className="min-w-0 space-y-1.5">
                    <Label className="text-xs sm:hidden">Kategori porsi *</Label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-between font-normal h-9 px-3"
                          title={kategoriPorsiListLabel(line.kategoriPorsiList)}
                        >
                          <span className="truncate text-left">
                            {kategoriDropdownLabel(line.kategoriPorsiList)}
                          </span>
                          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-[min(92vw,22rem)]">
                        <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">
                          Centang satu atau lebih kategori
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {KATEGORI_PORSI_OPTIONS.map((opt) => {
                          const checked = line.kategoriPorsiList.includes(opt.value);
                          const acuan = porsiAcuanFor(opt.value);
                          return (
                            <DropdownMenuCheckboxItem
                              key={opt.value}
                              checked={checked}
                              onCheckedChange={(v) => toggleLineKategoriPorsi(idx, opt.value, !!v)}
                              onSelect={(e) => e.preventDefault()}
                              className="py-2"
                            >
                              <span className="flex w-full items-start justify-between gap-3">
                                <span className="min-w-0">
                                  <span className="block font-medium leading-snug">{opt.label}</span>
                                  {opt.hint ? (
                                    <span className="block text-[10px] text-muted-foreground leading-snug">
                                      {opt.hint}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="shrink-0 text-[11px] tabular-nums text-orange-700">
                                  {acuan.toLocaleString('id-ID')} porsi
                                </span>
                              </span>
                            </DropdownMenuCheckboxItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {line.kategoriPorsiList.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {line.kategoriPorsiList.map((kp) => {
                          const label = KATEGORI_PORSI_OPTIONS.find((o) => o.value === kp)?.label || kp;
                          return (
                            <span
                              key={kp}
                              className="inline-flex items-center rounded border border-orange-200 bg-orange-50/80 px-1.5 py-0.5 text-[10px] leading-tight text-orange-800"
                            >
                              {label}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label className="text-xs sm:hidden">Resep *</Label>
                    <select
                      className="w-full border rounded-md px-2.5 py-1.5 text-sm bg-white h-9"
                      value={line.recipeId}
                      onChange={(e) => setLines((prev) => prev.map((l, i) => (
                        i === idx ? { ...l, recipeId: e.target.value } : l
                      )))}
                    >
                      <option value="">— Pilih resep —</option>
                      {(activeRecipes.length
                        ? activeRecipes
                        : Object.values(recipesById)
                      )
                        .filter((r) => r.aktif !== false || r.id === line.recipeId)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.kode} — {r.nama}{r.aktif === false ? ' (nonaktif)' : ''}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs sm:hidden">Porsi</Label>
                    <Input
                      type="number"
                      min={1}
                      className="h-9 text-right tabular-nums"
                      value={line.targetPorsi}
                      onChange={(e) => setLines((prev) => prev.map((l, i) => (
                        i === idx ? { ...l, targetPorsi: e.target.value } : l
                      )))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs sm:hidden">Est. AKG</Label>
                    <div
                      className="h-9 flex flex-col justify-center text-right text-[11px] leading-tight tabular-nums text-slate-700"
                      title={lineEst?.perPorsi
                        ? `${lineEst.perPorsi.energiKcal} kkal · P ${lineEst.perPorsi.proteinG}g · L ${lineEst.perPorsi.lemakG ?? 0}g · K ${lineEst.perPorsi.karbohidratG ?? 0}g / porsi`
                        : 'Belum ada data gizi resep'}
                    >
                      {line.recipeId && lineEst?.perPorsi ? (
                        <>
                          <span className="font-medium">~{formatEstKcal(lineEst.perPorsi.energiKcal)} kkal</span>
                          <span className="text-muted-foreground">
                            {lineEst.perPorsiAkgPct?.energiKcal ?? 0}% AKG
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end sm:justify-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                      disabled={lines.length <= 1}
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== idx))}
                      aria-label="Hapus baris"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                );
              })}
            </div>

            {activeRecipes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada resep aktif. Buat di Food Production → Resep.
              </p>
            )}
            {kitchens.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Belum ada dapur aktif. Buat di Food Production → Dapur.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Batal</Button>
            <Button onClick={() => void save()} disabled={saving || !canSave}>
              {saving ? 'Menyimpan…' : 'Simpan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={shortageDetailOpen} onOpenChange={setShortageDetailOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Item kurang — {shortageDetail?.noDokumen || ''}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {shortageDetail?.count || 0} item belum terpenuhi dari stok gudang.
          </p>
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left p-2 font-medium">Kode</th>
                  <th className="text-left p-2 font-medium">Nama</th>
                  <th className="text-right p-2 font-medium">Perlu</th>
                  <th className="text-right p-2 font-medium">Stok</th>
                  <th className="text-left p-2 font-medium">Gudang</th>
                </tr>
              </thead>
              <tbody>
                {(shortageDetail?.lines || []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-3 text-xs text-muted-foreground text-center">
                      Detail item tidak tersedia — cek ulang stok.
                    </td>
                  </tr>
                )}
                {(shortageDetail?.lines || []).map((line) => (
                  <tr key={line.productId} className="border-t">
                    <td className="p-2 font-mono text-xs">{line.productKode || '—'}</td>
                    <td className="p-2">{line.productNama || line.productId}</td>
                    <td className="p-2 text-right tabular-nums text-destructive font-medium">
                      {formatNumber(line.qtyNet ?? 0)}
                      {line.satuan ? ` ${line.satuan}` : ''}
                    </td>
                    <td className="p-2 text-right tabular-nums text-muted-foreground">
                      {formatNumber(line.qtyOnHand ?? 0)}
                    </td>
                    <td className="p-2 text-xs font-mono">
                      {line.stockWarehouseKode || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShortageDetailOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Riwayat {historyRow?.noDokumen || ''}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-2">
            {(historyRow?.history || []).length === 0 && (
              <p className="text-sm text-muted-foreground">Belum ada riwayat.</p>
            )}
            {(historyRow?.history || []).map((h, i) => (
              <div key={i} className="border rounded-md p-2 text-sm">
                <div className="font-medium">
                  {h.fromStatus || '—'} → {h.toStatus || '—'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.at ? new Date(h.at).toLocaleString('id-ID') : '—'}
                  {h.userName ? ` · ${h.userName}` : ''}
                </div>
                {h.note && <div className="text-xs mt-1">{h.note}</div>}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={needsOpen} onOpenChange={setNeedsOpen}>
        <DialogContent className="max-w-5xl w-[min(96vw,56rem)] max-h-[92vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-8">
              <DialogTitle>Rencana Kebutuhan — draft</DialogTitle>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="bg-orange-500 hover:bg-orange-600"
                  disabled={!needsDoc || needsPrinting || !(needsDoc?.lines.length)}
                  onClick={() => void printRencanaKebutuhan()}
                >
                  <Printer className="h-3.5 w-3.5 mr-1" />
                  {needsPrinting ? 'Mencetak…' : 'Cetak / PDF'}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground font-normal">
              Dokumen kebutuhan bahan untuk masak malam H-1 (barang datang sehari sebelum distribusi pagi).
              Gunakan Cetak / PDF lalu pilih &quot;Save as PDF&quot; di dialog printer.
            </p>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 bg-slate-100 p-3 sm:p-4">
            {needsDoc && (
              <div className="bg-white shadow-sm border rounded-md overflow-hidden">
                <RencanaKebutuhanDocument
                  tanggal={needsDoc.tanggal}
                  kitchenLabel={needsDoc.kitchenLabel}
                  planNos={needsDoc.planNos}
                  lines={needsDoc.lines}
                />
              </div>
            )}
          </div>
          <DialogFooter className="px-4 py-3 border-t shrink-0">
            <Button variant="outline" onClick={() => setNeedsOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {needsDoc && (
        <PrintPortal>
          <div className="doc-print-host">
            <RencanaKebutuhanDocument
              tanggal={needsDoc.tanggal}
              kitchenLabel={needsDoc.kitchenLabel}
              planNos={needsDoc.planNos}
              lines={needsDoc.lines}
              printId={RENCANA_KEBUTUHAN_PRINT_ID}
            />
          </div>
        </PrintPortal>
      )}
    </div>
  );
}
