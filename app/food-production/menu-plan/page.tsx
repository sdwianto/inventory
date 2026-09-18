'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  CalendarRange, Copy, FileText, Loader2, Package,
  Plus, Printer, Send, Trash2, Users, UtensilsCrossed, X,
} from 'lucide-react';
import { toast } from 'sonner';
import OperationalScopeBar from '@/components/OperationalScopeBar';
import KitchenScopeBar from '@/components/KitchenScopeBar';
import RecipeSearchSelect, { type RecipeSearchOption } from '@/components/RecipeSearchSelect';
import PrintPortal from '@/components/PrintPortal';
import FpFlowHint from '@/components/food-production/FpFlowHint';
import MenuWeekSwitcher, { currentMenuWeekStart } from '@/components/food-production/MenuWeekSwitcher';
import MenuHarianDocument, { MENU_HARIAN_PRINT_ID } from '@/components/food-production/MenuHarianDocument';
import KebutuhanBahanHarianDocument, {
  KEBUTUHAN_BAHAN_HARIAN_PRINT_ID,
} from '@/components/food-production/KebutuhanBahanHarianDocument';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders, getActingKitchenId, setActingKitchenId } from '@/lib/acting-kitchen-client';
import { getUser } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import {
  KATEGORI_MENU_OPTIONS,
  isKategoriMenu,
  type KategoriMenu,
} from '@/lib/food-production/recipe';
import {
  KATEGORI_PORSI_OPTIONS,
  PLAN_STATUS_LABELS,
  RECIPE_NEED_BUFFER_PCT,
  shiftIsoDate,
  type ProductionPlanStatus,
} from '@/lib/food-production/production-plan';
import {
  emptyPortionTargets,
  sumAllPorsi,
  sumPosyanduPorsi,
  sumSekolahPorsi,
  type PortionTargetMap,
} from '@/lib/food-production/portion-target';
import {
  WEEKLY_MENU_WEEKDAYS,
  akgKeyForDay,
  applyMenuPackageToDay,
  applyMenuPackageWarnings,
  clearWeeklyMenuDayContent,
  copyPorsiOntoDays,
  copyWeekDays,
  dayHasMenuContent,
  dayHasSlotContent,
  dayPorsiSummary,
  dayRecipeIds,
  draftNutritionLinesFromDay,
  emptyWeeklyDays,
  formatCopyPorsiDayLabel,
  groupDatesByWeekStart,
  indexWeeklyRpnByTanggal,
  isoWeekdays,
  localIsoDate,
  rpnPublishBlockedReason,
  presentWeeklyMenuDays,
  sumServicePointPorsi,
  weekHasSlotContent,
  weekStartFrom,
  type WeeklyMenuAlergi,
  type WeeklyMenuDay,
  type WeeklyMenuSlots,
  type WeeklyRecipeRef,
} from '@/lib/food-production/weekly-menu-plan';
import { kategoriMenuLabel, presentMenuItems } from '@/lib/food-production/menu';
import {
  AKG_COMPLIANCE_MAX_PCT,
  AKG_COMPLIANCE_MIN_PCT,
} from '@/lib/food-production/nutrition';
import { PLAN_STATUS_BADGE, formatPlanDateLabel } from '@/lib/food-production/plan-calendar';
import {
  acuanKerjaDraftWatermark,
  acuanKerjaFileName,
  buildKebutuhanBahanFromWeeklyDay,
  dayHasHidangan,
  type KebutuhanBahanHarian,
  type KebutuhanRecipeRef,
} from '@/lib/food-production/kebutuhan-bahan-harian';
import { printDocument } from '@/lib/doc-print';
import { FP_MANAGE_ROLES } from '@/lib/food-production/roles';
import { planHref } from '@/lib/food-production/fp-flow';

type RecipeOpt = RecipeSearchOption & {
  kategoriMenu?: string | null;
  yieldQty?: number;
  wastePct?: number;
  lines?: Array<{
    productId: string;
    productKode?: string;
    productNama?: string;
    qty?: number;
    qtyBesar?: number;
    qtyKecil?: number;
    pctKecil?: number;
    satuan?: string;
    baseSatuan?: string;
  }>;
};

type PlanLite = {
  id: string;
  noDokumen: string;
  tanggal: string;
  status: ProductionPlanStatus;
  weeklyMenuPlanId?: string;
};

type WeeklyDoc = {
  id?: string;
  exists?: boolean;
  kitchenId: string;
  kitchenNama?: string;
  weekStart: string;
  status: string;
  days: WeeklyMenuDay[];
};

type MenuPackage = {
  id: string;
  kode: string;
  nama: string;
  aktif?: boolean;
  items?: Array<{
    recipeId: string;
    recipeKode?: string;
    recipeNama?: string;
    kategoriMenu?: string;
    bahanPangan?: string;
    porsi?: number;
  }>;
};

type DayGizi = {
  energiKcal: number;
  proteinG: number;
  energiPct: number;
  proteinPct: number;
  akg: string;
  warnings: string[];
};

function formatEstKcal(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '0';
  if (n >= 10) return Math.round(n).toLocaleString('id-ID');
  return n.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function giziTone(pct: number): string {
  if (!(pct > 0)) return 'text-slate-500';
  if (pct < AKG_COMPLIANCE_MIN_PCT || pct > AKG_COMPLIANCE_MAX_PCT) return 'text-amber-800';
  return 'text-emerald-800';
}

const MANAGE = new Set<string>(FP_MANAGE_ROLES);

function initialMenuWeekStart(): string {
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(window.location.search).get('weekStart');
    const start = q ? weekStartFrom(q) : null;
    if (typeof start === 'string') return start;
  }
  const today = weekStartFrom(localIsoDate());
  return typeof today === 'string' ? today : '2026-09-21';
}

function fpHeaders(): HeadersInit {
  return { ...actingTenantHeaders(), ...actingKitchenHeaders() };
}

function shortDate(iso: string): string {
  return formatPlanDateLabel(iso).replace(/^[A-Za-zÀ-ÿ]+,\s*/, '');
}

function dayLocked(status?: ProductionPlanStatus): boolean {
  return Boolean(rpnPublishBlockedReason(status));
}

const DRAG_SCROLL_IGNORE = 'a, button, input, select, textarea, [role="combobox"], [role="listbox"], [role="option"]';

/** Geser papan horizontal: klik-tahan lalu drag (scrollbar tetap ada). */
function useHorizontalDragScroll(ref: { current: HTMLElement | null }, ready = true) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;
    let pointerId = 0;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      const node = e.target instanceof Element ? e.target : null;
      if (node?.closest(DRAG_SCROLL_IGNORE)) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add('cursor-grabbing');
      el.classList.remove('cursor-grab');
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = startScroll - dx;
      if (moved) e.preventDefault();
    };
    const endDrag = (e: PointerEvent) => {
      if (!dragging || e.pointerId !== pointerId) return;
      dragging = false;
      el.classList.remove('cursor-grabbing');
      el.classList.add('cursor-grab');
      try { el.releasePointerCapture(e.pointerId); } catch { /* sudah lepas */ }
    };
    const onClickCapture = (e: MouseEvent) => {
      if (!moved) return;
      e.preventDefault();
      e.stopPropagation();
      moved = false;
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', endDrag);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, [ref, ready]);
}

export default function MenuPlanPage() {
  const router = useRouter();
  const canManage = useMemo(() => {
    const role = String((getUser() as { role?: string } | null)?.role || '');
    return MANAGE.has(role);
  }, []);

  const [kitchenTick, setKitchenTick] = useState(0);
  const kitchenId = useMemo(() => getActingKitchenId(), [kitchenTick]);
  const [weekStart, setWeekStart] = useState(initialMenuWeekStart);
  const [days, setDays] = useState<WeeklyMenuDay[]>(() => emptyWeeklyDays(initialMenuWeekStart()));
  const [planId, setPlanId] = useState<string | undefined>();
  const [kitchenNama, setKitchenNama] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [selectedTanggal, setSelectedTanggal] = useState(initialMenuWeekStart);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [recipes, setRecipes] = useState<RecipeOpt[]>([]);
  const [rpnByDate, setRpnByDate] = useState<Record<string, PlanLite>>({});
  const [acuanOpen, setAcuanOpen] = useState(false);
  const [acuanPrinting, setAcuanPrinting] = useState<'full' | 'bahan' | null>(null);
  const [acuanDoc, setAcuanDoc] = useState<(KebutuhanBahanHarian & {
    tanggal: string;
    kitchenNama?: string;
    porsiByKategori: PortionTargetMap;
    note?: string;
    productionPlanNo?: string;
    productionPlanStatus?: ProductionPlanStatus;
    draftWatermark: boolean;
  }) | null>(null);
  const [menus, setMenus] = useState<MenuPackage[]>([]);
  const [packageOpen, setPackageOpen] = useState(false);
  const [packageMenuId, setPackageMenuId] = useState('');
  const [packageBusy, setPackageBusy] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyPorsi, setCopyPorsi] = useState(true);
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyPorsiOpen, setCopyPorsiOpen] = useState(false);
  const [copyTargetWeek, setCopyTargetWeek] = useState(weekStart);
  const [copyTargetDates, setCopyTargetDates] = useState<string[]>([]);
  const [copyTargetLocks, setCopyTargetLocks] = useState<Record<string, ProductionPlanStatus | undefined>>({});
  const [copyTargetBusy, setCopyTargetBusy] = useState(false);
  const [copyPorsiSaving, setCopyPorsiSaving] = useState(false);
  const [prefillOpen, setPrefillOpen] = useState(false);
  const [prefillBusy, setPrefillBusy] = useState(false);
  const [prefillSum, setPrefillSum] = useState<PortionTargetMap | null>(null);
  const [prefillScope, setPrefillScope] = useState<'selected' | 'empty' | 'all'>('selected');
  const [giziByDate, setGiziByDate] = useState<Record<string, DayGizi | null>>({});
  const [giziLoading, setGiziLoading] = useState(false);
  const [republishOpen, setRepublishOpen] = useState(false);
  const [republishTanggal, setRepublishTanggal] = useState<string | undefined>();
  const [republishNos, setRepublishNos] = useState<string[]>([]);
  const lastSaved = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipAutosave = useRef(true);
  const recipesRef = useRef<RecipeOpt[]>([]);
  const queryApplied = useRef(false);
  const copyWeekReq = useRef(0);
  const copyTargetWeekRef = useRef(weekStart);
  const daysRef = useRef<WeeklyMenuDay[]>([]);
  const [clearConfirmTanggal, setClearConfirmTanggal] = useState<string | null>(null);
  const boardScrollRef = useRef<HTMLDivElement>(null);
  recipesRef.current = recipes;
  daysRef.current = days;
  useHorizontalDragScroll(boardScrollRef, !loading);

  const weekDates = useMemo(() => isoWeekdays(weekStart), [weekStart]);
  const todayWeekStart = currentMenuWeekStart();
  copyTargetWeekRef.current = copyTargetWeek;

  useEffect(() => {
    setDays((prev) => {
      const have = new Set(prev.map((d) => d.tanggal));
      if (weekDates.length && weekDates.every((d) => have.has(d))) return prev;
      skipAutosave.current = true;
      return emptyWeeklyDays(weekStart);
    });
    setSelectedTanggal((prev) => (weekDates.includes(prev) ? prev : weekStart));
  }, [weekStart, weekDates]);

  useEffect(() => {
    const onKitchen = () => setKitchenTick((n) => n + 1);
    window.addEventListener('fp-kitchen-changed', onKitchen);
    return () => window.removeEventListener('fp-kitchen-changed', onKitchen);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!queryApplied.current) {
      queryApplied.current = true;
      const params = new URLSearchParams(window.location.search);
      let pending = false;
      const weekQ = params.get('weekStart');
      if (weekQ) {
        const start = weekStartFrom(weekQ);
        if (typeof start === 'string' && start !== weekStart) {
          setWeekStart(start);
          pending = true;
        }
      }
      const kitchenQ = String(params.get('kitchenId') || '').trim();
      if (kitchenQ && kitchenQ !== getActingKitchenId()) {
        setActingKitchenId(kitchenQ);
        window.dispatchEvent(new Event('fp-kitchen-changed'));
        pending = true;
      }
      if (pending) return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('weekStart', weekStart);
    if (kitchenId) url.searchParams.set('kitchenId', kitchenId);
    else url.searchParams.delete('kitchenId');
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
      window.history.replaceState({}, '', next);
    }
  }, [weekStart, kitchenId]);

  const loadRecipes = useCallback(async () => {
    try {
      const res = await fetch('/api/recipes?aktif=1', { headers: fpHeaders() });
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setRecipes(data as RecipeOpt[]);
    } catch {
      /* ignore */
    }
  }, []);

  const loadMenus = useCallback(async () => {
    try {
      const res = await fetch('/api/menus?aktif=1', { headers: fpHeaders() });
      const data = await res.json();
      if (res.ok && Array.isArray(data)) setMenus(data as MenuPackage[]);
    } catch {
      /* ignore */
    }
  }, []);

  const mergeRecipesByIds = useCallback(async (ids: string[]): Promise<Map<string, RecipeOpt>> => {
    const map = new Map(recipesRef.current.map((r) => [r.id, r]));
    const missing = [...new Set(ids.filter((id) => id && !map.has(id)))];
    if (missing.length) {
      try {
        for (let i = 0; i < missing.length; i += 200) {
          const chunk = missing.slice(i, i + 200);
          const res = await fetch(
            `/api/recipes?ids=${encodeURIComponent(chunk.join(','))}`,
            { headers: fpHeaders() },
          );
          const data = await res.json();
          if (!res.ok || !Array.isArray(data)) continue;
          for (const row of data as RecipeOpt[]) {
            if (row?.id) map.set(row.id, row);
          }
        }
        const next = [...map.values()];
        recipesRef.current = next;
        setRecipes(next);
      } catch {
        /* pakai map yang sudah ada */
      }
    }
    return map;
  }, []);

  const loadWeek = useCallback(async (opts?: { silent?: boolean }) => {
    if (!kitchenId) return;
    if (!opts?.silent) setLoading(true);
    skipAutosave.current = true;
    try {
      const [planRes, rpnRes] = await Promise.all([
        fetch(
          `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchenId)}&weekStart=${encodeURIComponent(weekStart)}`,
          { headers: fpHeaders() },
        ),
        fetch(
          `/api/production-plans?from=${encodeURIComponent(weekStart)}&to=${encodeURIComponent(weekDates[4])}&kitchenId=${encodeURIComponent(kitchenId)}`,
          { headers: fpHeaders() },
        ),
      ]);
      const planData = await planRes.json();
      const rpnData = await rpnRes.json();
      if (!planRes.ok) throw new Error(planData?.error || 'Gagal memuat rencana menu');
      const nextDays: WeeklyMenuDay[] = Array.isArray(planData.days) && planData.days.length
        ? planData.days
        : emptyWeeklyDays(weekStart);
      setDays(nextDays);
      setPlanId(planData.id);
      setKitchenNama(planData.kitchenNama || undefined);
      lastSaved.current = JSON.stringify(nextDays);
      setSelectedTanggal((prev) => (weekDates.includes(prev) ? prev : weekStart));
      void mergeRecipesByIds(nextDays.flatMap((d) => dayRecipeIds(d)));

      setRpnByDate(
        rpnRes.ok && Array.isArray(rpnData)
          ? indexWeeklyRpnByTanggal(nextDays, rpnData as PlanLite[], planData.id)
          : {},
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat minggu');
    } finally {
      setLoading(false);
      setTimeout(() => { skipAutosave.current = false; }, 50);
    }
  }, [kitchenId, weekStart, weekDates, mergeRecipesByIds]);

  useEffect(() => { void loadRecipes(); }, [loadRecipes]);
  useEffect(() => { void loadMenus(); }, [loadMenus]);
  useEffect(() => { void loadWeek(); }, [loadWeek]);

  const persist = useCallback(async (nextDays: WeeklyMenuDay[]): Promise<{ ok: boolean; id?: string }> => {
    if (!canManage || !kitchenId) return { ok: false };
    const payload = JSON.stringify(nextDays);
    if (payload === lastSaved.current) return { ok: true, id: planId };
    setSaving(true);
    try {
      const res = await fetch('/api/weekly-menu-plans', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...fpHeaders() },
        body: JSON.stringify({ kitchenId, weekStart, days: nextDays }),
      });
      const data = await res.json() as WeeklyDoc & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Gagal menyimpan');
      if (data.id) setPlanId(data.id);
      if (JSON.stringify(daysRef.current) !== payload) {
        return { ok: true, id: data.id };
      }
      lastSaved.current = JSON.stringify(data.days || nextDays);
      if (Array.isArray(data.days)) setDays(data.days);
      return { ok: true, id: data.id };
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyimpan');
      return { ok: false };
    } finally {
      setSaving(false);
    }
  }, [canManage, kitchenId, weekStart, planId]);

  useEffect(() => {
    if (skipAutosave.current || !canManage || !kitchenId) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(days); }, 700);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [days, persist, canManage, kitchenId]);

  useEffect(() => {
    if (!kitchenId) {
      setGiziByDate({});
      setGiziLoading(false);
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setGiziLoading(true);
        const next: Record<string, DayGizi | null> = {};
        await Promise.all(days.map(async (day) => {
          const lines = draftNutritionLinesFromDay(day);
          if (!lines.length) {
            next[day.tanggal] = null;
            return;
          }
          try {
            const res = await fetch('/api/nutrition-profiles/analyze-draft', {
              method: 'POST',
              signal: ac.signal,
              headers: { 'Content-Type': 'application/json', ...fpHeaders() },
              body: JSON.stringify({
                akg: akgKeyForDay(day.porsiByKategori),
                lines,
                acuanByKategori: day.porsiByKategori,
              }),
            });
            const data = await res.json();
            if (!res.ok) {
              next[day.tanggal] = null;
              return;
            }
            next[day.tanggal] = {
              energiKcal: Number(data.perPorsi?.energiKcal) || 0,
              proteinG: Number(data.perPorsi?.proteinG) || 0,
              energiPct: Number(data.perPorsiAkgPct?.energiKcal) || 0,
              proteinPct: Number(data.perPorsiAkgPct?.proteinG) || 0,
              akg: String(data.akgProfile || akgKeyForDay(day.porsiByKategori)),
              warnings: Array.isArray(data.warnings) ? data.warnings.map(String) : [],
            };
          } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') return;
            next[day.tanggal] = null;
          }
        }));
        if (!cancelled) {
          setGiziByDate(next);
          setGiziLoading(false);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      ac.abort();
      window.clearTimeout(timer);
    };
  }, [days, kitchenId]);

  const selected = days.find((d) => d.tanggal === selectedTanggal) || days[0];
  const selectedRpn = selected ? rpnByDate[selected.tanggal] : undefined;
  const selectedLocked = dayLocked(selectedRpn?.status);

  function patchDay(tanggal: string, patch: Partial<WeeklyMenuDay>) {
    if (!canManage) return;
    if (dayLocked(rpnByDate[tanggal]?.status)) {
      toast.error('RPN hari ini terkunci — tidak bisa diubah dari papan minggu');
      return;
    }
    setDays((prev) => prev.map((d) => (d.tanggal === tanggal ? { ...d, ...patch } : d)));
  }

  function addRecipe(tanggal: string, slot: KategoriMenu, recipeId: string) {
    if (!recipeId) return;
    const day = days.find((d) => d.tanggal === tanggal);
    if (!day) return;
    const used = new Set([
      ...Object.values(day.slots || {}).flat(),
      ...(day.alergi || []).map((a) => a.recipeId),
    ]);
    if (used.has(recipeId)) {
      toast.error('Resep ini sudah dipakai di hari yang sama');
      return;
    }
    const nextSlots: WeeklyMenuSlots = {
      ...day.slots,
      [slot]: [...(day.slots?.[slot] || []), recipeId],
    };
    patchDay(tanggal, { slots: nextSlots });
  }

  function removeRecipe(tanggal: string, slot: KategoriMenu, recipeId: string) {
    const day = days.find((d) => d.tanggal === tanggal);
    if (!day) return;
    const nextList = (day.slots?.[slot] || []).filter((id) => id !== recipeId);
    const nextSlots = { ...day.slots };
    if (nextList.length) nextSlots[slot] = nextList;
    else delete nextSlots[slot];
    patchDay(tanggal, { slots: nextSlots });
  }

  function setPorsi(tanggal: string, key: keyof PortionTargetMap, raw: string) {
    const day = days.find((d) => d.tanggal === tanggal);
    if (!day) return;
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    patchDay(tanggal, {
      porsiByKategori: { ...(day.porsiByKategori || emptyPortionTargets()), [key]: n },
    });
  }

  function requestClearDay(tanggal: string) {
    if (!canManage) return;
    if (dayLocked(rpnByDate[tanggal]?.status)) {
      toast.error('RPN hari ini terkunci — tidak bisa diubah dari papan minggu');
      return;
    }
    const day = daysRef.current.find((d) => d.tanggal === tanggal);
    if (!day) return;
    if (!dayHasMenuContent(day)) {
      toast.message('Hari ini sudah kosong');
      return;
    }
    setSelectedTanggal(tanggal);
    setClearConfirmTanggal(tanggal);
  }

  function confirmClearDay() {
    const tanggal = clearConfirmTanggal;
    if (!tanggal || !canManage) return;
    if (dayLocked(rpnByDate[tanggal]?.status)) {
      toast.error('RPN hari ini terkunci — tidak bisa diubah dari papan minggu');
      setClearConfirmTanggal(null);
      return;
    }
    const day = daysRef.current.find((d) => d.tanggal === tanggal);
    if (!day || !dayHasMenuContent(day)) {
      setClearConfirmTanggal(null);
      return;
    }
    const hari = WEEKLY_MENU_WEEKDAYS[weekDates.indexOf(tanggal)] || 'hari ini';
    const hadRpn = Boolean(day.productionPlanId || rpnByDate[tanggal]);
    setDays((prev) => prev.map((d) => (d.tanggal === tanggal ? clearWeeklyMenuDayContent(d) : d)));
    setClearConfirmTanggal(null);
    toast.success(
      hadRpn
        ? `Isian ${hari} dikosongkan. Terbitkan ulang agar RPN ikut berubah.`
        : `Isian ${hari} dikosongkan`,
    );
  }

  function recipesAsRefs(map: Map<string, RecipeOpt>): Map<string, WeeklyRecipeRef> {
    return new Map([...map.values()].map((r) => [r.id, {
      id: r.id,
      kode: r.kode,
      nama: r.nama,
      aktif: r.aktif,
      kategoriMenu: r.kategoriMenu,
    }]));
  }

  async function applyPackage(opts?: { replace?: boolean }) {
    if (!canManage || !selected) return;
    if (selectedLocked) {
      toast.error('RPN hari ini terkunci — tidak bisa menerapkan paket');
      return;
    }
    const menu = menus.find((m) => m.id === packageMenuId);
    const items = (menu?.items || []).filter((i) => String(i.recipeId || '').trim());
    if (!menu || !items.length) {
      toast.error('Pilih paket menu yang punya resep');
      return;
    }
    if (!opts?.replace && dayHasSlotContent(selected)) {
      const ok = window.confirm(
        'Hari ini sudah ada hidangan. Terapkan paket akan mengganti slot (porsi dan catatan tetap). Lanjut?',
      );
      if (!ok) return;
    }
    setPackageBusy(true);
    try {
      const recipeMap = await mergeRecipesByIds(items.map((i) => i.recipeId));
      const refs = recipesAsRefs(recipeMap);
      const next = applyMenuPackageToDay(selected, items, refs);
      if ('error' in next) {
        toast.error(next.error);
        return;
      }
      patchDay(selected.tanggal, { slots: next.slots, alergi: next.alergi });
      const warnings = applyMenuPackageWarnings(items, refs);
      toast.success(`Paket ${menu.kode} diterapkan`);
      if (warnings[0]) toast.message(warnings[0]);
      setPackageOpen(false);
    } finally {
      setPackageBusy(false);
    }
  }

  async function copyPreviousWeek() {
    if (!canManage || !kitchenId) return;
    const prevStart = shiftIsoDate(weekStart, -7);
    setCopyBusy(true);
    try {
      const res = await fetch(
        `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchenId)}&weekStart=${encodeURIComponent(prevStart)}`,
        { headers: fpHeaders() },
      );
      const data = await res.json() as WeeklyDoc & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Gagal memuat minggu lalu');
      const sourceDays = presentWeeklyMenuDays(
        Array.isArray(data.days) ? data.days : [],
        prevStart,
      );
      if (!weekHasSlotContent(sourceDays)) {
        toast.error('Minggu lalu belum ada hidangan untuk disalin');
        return;
      }
      const skip = weekDates.filter((d) => dayLocked(rpnByDate[d]?.status));
      if (skip.length === weekDates.length) {
        toast.error('Semua hari minggu ini terkunci');
        return;
      }
      const unlockedHasContent = days.some((d) => !skip.includes(d.tanggal) && dayHasSlotContent(d));
      if (unlockedHasContent) {
        const ok = window.confirm(
          'Minggu ini sudah ada hidangan. Salin minggu lalu akan mengganti slot hari yang belum terkunci. Lanjut?',
        );
        if (!ok) return;
      }
      const copied = copyWeekDays(sourceDays, days, { copyPorsi, skipTanggal: skip });
      setDays(copied);
      void mergeRecipesByIds(copied.flatMap((d) => dayRecipeIds(d)));
      setCopyOpen(false);
      toast.success(
        skip.length
          ? `Minggu lalu disalin · ${skip.length} hari terkunci dilewati`
          : 'Minggu lalu disalin',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyalin minggu lalu');
    } finally {
      setCopyBusy(false);
    }
  }

  function locksFromRpnMap(map: Record<string, PlanLite>): Record<string, ProductionPlanStatus | undefined> {
    const locks: Record<string, ProductionPlanStatus | undefined> = {};
    for (const [tgl, row] of Object.entries(map)) locks[tgl] = row.status;
    return locks;
  }

  async function fetchCopyTargetWeek(ws: string): Promise<{
    days: WeeklyMenuDay[];
    locks: Record<string, ProductionPlanStatus | undefined>;
  }> {
    if (!kitchenId) throw new Error('Dapur wajib dipilih');
    const dates = isoWeekdays(ws);
    const [planRes, rpnRes] = await Promise.all([
      fetch(
        `/api/weekly-menu-plans?kitchenId=${encodeURIComponent(kitchenId)}&weekStart=${encodeURIComponent(ws)}`,
        { headers: fpHeaders() },
      ),
      fetch(
        `/api/production-plans?from=${encodeURIComponent(ws)}&to=${encodeURIComponent(dates[4])}&kitchenId=${encodeURIComponent(kitchenId)}`,
        { headers: fpHeaders() },
      ),
    ]);
    const planData = await planRes.json() as WeeklyDoc & { error?: string };
    const rpnData = await rpnRes.json();
    if (!planRes.ok) throw new Error(planData.error || 'Gagal memuat minggu tujuan');
    const days = presentWeeklyMenuDays(Array.isArray(planData.days) ? planData.days : [], ws);
    const indexed = rpnRes.ok && Array.isArray(rpnData)
      ? indexWeeklyRpnByTanggal(days, rpnData as PlanLite[], planData.id)
      : {};
    return { days, locks: locksFromRpnMap(indexed) };
  }

  function applyCopyWeekLocks(
    ws: string,
    lockMap: Record<string, ProductionPlanStatus | undefined>,
  ) {
    const dates = isoWeekdays(ws);
    setCopyTargetLocks(lockMap);
    setCopyTargetDates(
      dates.filter((d) => d !== selectedTanggal && !dayLocked(lockMap[d])),
    );
  }

  async function changeCopyTargetWeek(ws: string) {
    const req = ++copyWeekReq.current;
    const from = copyTargetWeekRef.current;
    copyTargetWeekRef.current = ws;
    setCopyTargetWeek(ws);
    if (ws === weekStart) {
      applyCopyWeekLocks(ws, locksFromRpnMap(rpnByDate));
      setCopyTargetBusy(false);
      return;
    }
    if (!kitchenId) {
      copyTargetWeekRef.current = from;
      setCopyTargetWeek(from);
      return;
    }
    setCopyTargetBusy(true);
    try {
      const { locks } = await fetchCopyTargetWeek(ws);
      if (req !== copyWeekReq.current) return;
      applyCopyWeekLocks(ws, locks);
    } catch (e) {
      if (req !== copyWeekReq.current) return;
      copyTargetWeekRef.current = from;
      setCopyTargetWeek(from);
      toast.error(e instanceof Error ? e.message : 'Gagal memuat minggu tujuan');
    } finally {
      if (req === copyWeekReq.current) setCopyTargetBusy(false);
    }
  }

  async function confirmCopyPorsi() {
    if (!canManage || !selected) return;
    const skipDialog = Object.entries(copyTargetLocks)
      .filter(([, status]) => dayLocked(status))
      .map(([tanggal]) => tanggal);
    const targets = copyTargetDates.filter((d) => d !== selected.tanggal && !skipDialog.includes(d));
    if (!targets.length) {
      toast.error('Pilih hari tujuan yang belum terkunci');
      return;
    }
    setCopyPorsiSaving(true);
    try {
      const copied: string[] = [];
      const grouped = groupDatesByWeekStart(targets);
      for (const [ws, tgls] of grouped) {
        if (ws === weekStart) {
          const skip = weekDates.filter((d) => dayLocked(rpnByDate[d]?.status));
          const allowed = tgls.filter((d) => !skip.includes(d));
          if (!allowed.length) continue;
          setDays((prev) => copyPorsiOntoDays(prev, selected.porsiByKategori, allowed, skip));
          copied.push(...allowed);
          continue;
        }
        const { days, locks } = await fetchCopyTargetWeek(ws);
        const skip = Object.entries(locks)
          .filter(([, status]) => dayLocked(status))
          .map(([tanggal]) => tanggal);
        const allowed = tgls.filter((d) => !skip.includes(d));
        if (!allowed.length) continue;
        const nextDays = copyPorsiOntoDays(days, selected.porsiByKategori, allowed, skip);
        const put = await fetch('/api/weekly-menu-plans', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...fpHeaders() },
          body: JSON.stringify({ kitchenId, weekStart: ws, days: nextDays }),
        });
        const putData = await put.json() as { error?: string };
        if (!put.ok) throw new Error(putData.error || 'Gagal menyimpan porsi');
        copied.push(...allowed);
      }
      if (!copied.length) {
        toast.error('Pilih hari tujuan yang belum terkunci');
        return;
      }
      toast.success(`Porsi disalin ke ${copied.map(formatCopyPorsiDayLabel).join(' · ')}`);
      setCopyPorsiOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menyalin porsi');
    } finally {
      setCopyPorsiSaving(false);
    }
  }

  async function openPrefill() {
    if (!canManage || !kitchenId) return;
    setPrefillBusy(true);
    try {
      const res = await fetch(
        `/api/service-points?aktif=1&kitchenId=${encodeURIComponent(kitchenId)}`,
        { headers: fpHeaders() },
      );
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) {
        throw new Error(data?.error || 'Gagal memuat titik layanan');
      }
      const sum = sumServicePointPorsi(data as Array<{
        aktif?: boolean;
        porsiByKategori?: Partial<Record<string, number>> | null;
      }>);
      if (sumAllPorsi(sum) <= 0) {
        toast.error('Titik layanan dapur ini belum punya porsi');
        return;
      }
      setPrefillSum(sum);
      setPrefillOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat titik layanan');
    } finally {
      setPrefillBusy(false);
    }
  }

  function applyPrefill() {
    if (!prefillSum) return;
    const skip = new Set(weekDates.filter((d) => dayLocked(rpnByDate[d]?.status)));
    if (prefillScope === 'selected' && selected && skip.has(selected.tanggal)) {
      toast.error('RPN hari terpilih terkunci');
      return;
    }
    setDays((prev) => prev.map((d) => {
      if (skip.has(d.tanggal)) return d;
      if (prefillScope === 'selected' && d.tanggal !== selectedTanggal) return d;
      if (prefillScope === 'empty' && sumAllPorsi(d.porsiByKategori) > 0) return d;
      return { ...d, porsiByKategori: { ...prefillSum } };
    }));
    setPrefillOpen(false);
    toast.success('Porsi diisi dari titik layanan');
  }

  async function publish(tanggal?: string, opts?: { confirmSubmitted?: boolean }) {
    if (!canManage) return;
    if (!kitchenId) {
      toast.error('Pilih dapur dulu');
      return;
    }
    const targets = tanggal
      ? days.filter((d) => d.tanggal === tanggal)
      : days;
    const submitted = targets.filter((d) => rpnByDate[d.tanggal]?.status === 'SUBMITTED');
    if (submitted.length && !opts?.confirmSubmitted) {
      setRepublishTanggal(tanggal);
      setRepublishNos(submitted.map((d) => rpnByDate[d.tanggal]?.noDokumen || d.tanggal));
      setRepublishOpen(true);
      return;
    }
    setPublishing(true);
    try {
      const saved = await persist(days);
      if (!saved.ok) throw new Error('Simpan rencana dulu sebelum menerbitkan');
      const id = saved.id || planId;
      if (!id) throw new Error('Simpan rencana dulu sebelum menerbitkan');
      const res = await fetch(`/api/weekly-menu-plans/${id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...fpHeaders() },
        body: JSON.stringify(tanggal ? { tanggal } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal menerbitkan');
      const published = Array.isArray(data.published)
        ? data.published as Array<{ tanggal: string; productionPlanId: string; productionPlanNo: string }>
        : [];
      const nos = published.map((p) => p.productionPlanNo).join(', ') || 'RPN';
      const first = published[0];
      toast.success(`Terbit ${nos}`, first ? {
        action: {
          label: `Buka ${first.productionPlanNo}`,
          onClick: () => router.push(planHref({
            productionPlanId: first.productionPlanId,
            tanggal: first.tanggal,
          })),
        },
      } : undefined);
      if (Array.isArray(data.warnings) && data.warnings.length) {
        toast.message(data.warnings[0]);
      }
      skipAutosave.current = true;
      if (Array.isArray(data.days)) {
        setDays(data.days);
        lastSaved.current = JSON.stringify(data.days);
      }
      await loadWeek({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal menerbitkan');
    } finally {
      setPublishing(false);
    }
  }

  const recipesById = useMemo(() => new Map(recipes.map((r) => [r.id, r])), [recipes]);

  async function openAcuan(day: WeeklyMenuDay) {
    if (!dayHasHidangan(day)) {
      toast.error('Pilih resep di slot dulu sebelum mengunduh acuan kerja');
      return;
    }
    const rpn = rpnByDate[day.tanggal];
    const productionPlanNo = rpn?.noDokumen || day.productionPlanNo;
    const productionPlanStatus = rpn?.status;
    const recipeMap = await mergeRecipesByIds(dayRecipeIds(day));
    const built = buildKebutuhanBahanFromWeeklyDay(
      day,
      recipeMap as Map<string, KebutuhanRecipeRef>,
    );
    setAcuanDoc({
      ...built,
      tanggal: day.tanggal,
      kitchenNama: kitchenNama || 'Dapur',
      porsiByKategori: { ...emptyPortionTargets(), ...(day.porsiByKategori || {}) },
      note: day.note,
      productionPlanNo,
      productionPlanStatus,
      draftWatermark: acuanKerjaDraftWatermark(productionPlanNo, productionPlanStatus),
    });
    setAcuanOpen(true);
    if (built.errors.length) toast.message(built.errors[0]);
  }

  async function printAcuan(kind: 'full' | 'bahan') {
    if (!acuanDoc) return;
    setAcuanPrinting(kind);
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 200));
      });
      await printDocument(
        kind === 'full' ? MENU_HARIAN_PRINT_ID : KEBUTUHAN_BAHAN_HARIAN_PRINT_ID,
        300,
        acuanKerjaFileName(
          acuanDoc.kitchenNama,
          acuanDoc.tanggal,
          kind === 'bahan' ? 'bahan' : 'acuan',
        ),
      );
    } finally {
      setAcuanPrinting(null);
    }
  }

  const inspector = selected ? (
    <DayInspector
      day={selected}
      locked={selectedLocked}
      canManage={canManage}
      rpn={selectedRpn}
      recipes={recipes}
      recipesById={recipesById}
      weekDates={weekDates}
      onPorsi={(key, val) => setPorsi(selected.tanggal, key, val)}
      onNote={(note) => patchDay(selected.tanggal, { note })}
      onAlergi={(alergi) => patchDay(selected.tanggal, { alergi })}
      onCopyPorsi={() => {
        if (!selected) return;
        setCopyTargetWeek(weekStart);
        const rest = weekDates.filter((d) => d !== selected.tanggal && !dayLocked(rpnByDate[d]?.status));
        setCopyTargetDates(rest);
        const locks: Record<string, ProductionPlanStatus | undefined> = {};
        for (const d of weekDates) locks[d] = rpnByDate[d]?.status;
        setCopyTargetLocks(locks);
        setCopyPorsiOpen(true);
      }}
      onPublishDay={() => void publish(selected.tanggal)}
      onOpenAcuan={() => void openAcuan(selected)}
      onApplyPackage={() => setPackageOpen(true)}
      onClearDay={() => requestClearDay(selected.tanggal)}
      gizi={giziByDate[selected.tanggal]}
      giziLoading={giziLoading}
      publishing={publishing}
    />
  ) : null;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarRange className="w-6 h-6" />
            Perencanaan Menu
          </h1>
          <p className="text-sm text-slate-500">
            Susun menu seminggu. Terbitkan ke RPN — dapur setujui dan ambil bahan di Rencana Produksi.
          </p>
          <FpFlowHint active="menu" className="mt-1" />
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {saving ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Menyimpan
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Tersimpan otomatis</span>
          )}
          {canManage && (
            <Button size="sm" onClick={() => void publish()} disabled={publishing || !kitchenId}>
              <Send className="h-4 w-4 mr-1" />
              Terbitkan minggu
            </Button>
          )}
        </div>
      </div>

      <OperationalScopeBar />
      <KitchenScopeBar />

      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!kitchenId}
            onClick={() => setPackageOpen(true)}
          >
            <Package className="h-4 w-4 mr-1" />
            Terapkan paket
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!kitchenId}
            onClick={() => setCopyOpen(true)}
          >
            <Copy className="h-4 w-4 mr-1" />
            Salin minggu lalu
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!kitchenId || prefillBusy}
            onClick={() => void openPrefill()}
          >
            <Users className="h-4 w-4 mr-1" />
            {prefillBusy ? 'Memuat PM…' : 'Isi PM dari titik layanan'}
          </Button>
        </div>
      )}

      {!kitchenId && (
        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          Pilih dapur di filter di atas untuk menyusun menu minggu ini.
        </p>
      )}

      {selected && (
        <div className="rounded-lg border bg-white p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              Penerima manfaat · {WEEKLY_MENU_WEEKDAYS[weekDates.indexOf(selected.tanggal)] || ''} {shortDate(selected.tanggal)}
            </p>
            <div className="text-xs text-muted-foreground">
              Sekolah {sumSekolahPorsi(selected.porsiByKategori).toLocaleString('id-ID')}
              {' · '}
              Posyandu {sumPosyanduPorsi(selected.porsiByKategori).toLocaleString('id-ID')}
              {' · '}
              Total {sumAllPorsi(selected.porsiByKategori).toLocaleString('id-ID')}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {KATEGORI_PORSI_OPTIONS.map((opt) => (
              <div key={opt.value} className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{opt.label}</Label>
                <Input
                  type="number"
                  min={0}
                  className="h-8"
                  disabled={!canManage || selectedLocked}
                  value={selected.porsiByKategori?.[opt.value] ?? 0}
                  onChange={(e) => setPorsi(selected.tanggal, opt.value, e.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <MenuWeekSwitcher
        weekStart={weekStart}
        todayWeekStart={todayWeekStart}
        onWeekStartChange={setWeekStart}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_22rem] gap-4 items-start">
        <div
          ref={boardScrollRef}
          className="overflow-x-auto rounded-lg border bg-white cursor-grab [scrollbar-gutter:stable] [&_button]:cursor-pointer [&_a]:cursor-pointer [&_input]:cursor-text [&_[role=combobox]]:cursor-pointer"
          title="Klik kartu hari untuk memilih. Geser papan: tahan klik di area kosong lalu tarik, atau pakai scrollbar"
        >
          {loading ? (
            <div className="p-8 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Memuat papan minggu…
            </div>
          ) : (
            <table className="min-w-[64rem] w-full text-sm border-separate border-spacing-0 isolate">
              <thead>
                <tr>
                  <th className="sticky left-0 z-30 w-36 bg-slate-700 text-left font-semibold text-white px-3 py-2 border-b border-slate-200 shadow-[1px_0_0_0_rgb(226,232,240)]">
                    Hidangan
                  </th>
                  {weekDates.map((tanggal, i) => {
                    const day = days[i];
                    const rpn = rpnByDate[tanggal];
                    const selectedCol = tanggal === selectedTanggal;
                    return (
                      <th key={tanggal} className="relative z-0 px-2 py-2 border-b border-slate-200 min-w-[12rem] align-bottom bg-white">
                        <button
                          type="button"
                          title="Pilih hari ini"
                          className={cn(
                            'w-full text-left rounded-md px-2 py-1.5 border cursor-pointer',
                            selectedCol ? 'border-orange-400 bg-orange-50' : 'border-transparent hover:bg-slate-100',
                          )}
                          onClick={() => {
                            setSelectedTanggal(tanggal);
                            if (window.matchMedia('(max-width: 1279px)').matches) setSheetOpen(true);
                          }}
                        >
                          <div className="text-xs font-semibold">
                            {WEEKLY_MENU_WEEKDAYS[i]} · {tanggal.slice(8, 10)}/{tanggal.slice(5, 7)}
                          </div>
                          <div className="text-[11px] text-muted-foreground tabular-nums">
                            {dayPorsiSummary(day).total.toLocaleString('id-ID')} porsi
                          </div>
                          <DayGiziChip gizi={giziByDate[tanggal]} loading={giziLoading} compact />
                          {rpn ? (
                            <span className={cn(
                              'inline-flex mt-1 text-[10px] px-1.5 py-0.5 rounded border',
                              PLAN_STATUS_BADGE[rpn.status] || 'bg-slate-100',
                            )}>
                              {rpn.noDokumen} · {PLAN_STATUS_LABELS[rpn.status] || rpn.status}
                            </span>
                          ) : day?.productionPlanNo ? (
                            <span className="inline-flex mt-1 text-[10px] px-1.5 py-0.5 rounded border bg-slate-50">
                              {day.productionPlanNo}
                            </span>
                          ) : (
                            <span className="inline-flex mt-1 text-[10px] text-slate-400">Belum terbit</span>
                          )}
                        </button>
                        {canManage && !dayLocked(rpn?.status) && (
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <button
                              type="button"
                              className="text-[10px] text-orange-700 hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedTanggal(tanggal);
                                setPackageOpen(true);
                              }}
                            >
                              Terapkan paket
                            </button>
                            <button
                              type="button"
                              data-testid="menu-day-clear"
                              aria-label={`Kosongkan isian ${WEEKLY_MENU_WEEKDAYS[i]}`}
                              className="text-[10px] text-slate-500 hover:text-red-700 hover:underline"
                              onClick={(e) => {
                                e.stopPropagation();
                                requestClearDay(tanggal);
                              }}
                            >
                              Kosongkan
                            </button>
                          </div>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {KATEGORI_MENU_OPTIONS.map((slot) => (
                  <tr key={slot.value}>
                    <th className="sticky left-0 z-30 w-36 bg-slate-100 text-left font-medium text-slate-800 px-3 py-2 align-top border-b border-slate-200 shadow-[1px_0_0_0_rgb(226,232,240)]">
                      {slot.label}
                    </th>
                    {weekDates.map((tanggal) => {
                      const day = days.find((d) => d.tanggal === tanggal);
                      const ids = day?.slots?.[slot.value] || [];
                      const locked = dayLocked(rpnByDate[tanggal]?.status);
                      const used = new Set([
                        ...Object.values(day?.slots || {}).flat(),
                        ...(day?.alergi || []).map((a) => a.recipeId),
                      ]);
                      const options = recipes.filter((r) => (
                        r.aktif !== false
                        && (r.kategoriMenu === slot.value || !r.kategoriMenu)
                        && !used.has(r.id)
                      ));
                      return (
                        <td
                          key={tanggal}
                          className={cn(
                            'relative z-0 px-2 py-2 align-top border-b border-slate-200',
                            tanggal === selectedTanggal ? 'bg-orange-50/40' : 'bg-white',
                          )}
                          onClick={() => setSelectedTanggal(tanggal)}
                        >
                          <div className="space-y-1.5">
                            {ids.map((id) => {
                              const rec = recipesById.get(id);
                              return (
                                <span
                                  key={id}
                                  className="flex items-center gap-1 rounded border border-orange-200 bg-orange-50 px-1.5 py-1 text-[11px]"
                                >
                                  <span className="truncate">
                                    {rec ? `${rec.kode} · ${rec.nama}` : id}
                                  </span>
                                  {canManage && !locked && (
                                    <button
                                      type="button"
                                      className="shrink-0 text-slate-500 hover:text-red-600"
                                      onClick={() => removeRecipe(tanggal, slot.value, id)}
                                      aria-label="Hapus resep"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                            {canManage && !locked ? (
                              <RecipeSearchSelect
                                value=""
                                recipes={options}
                                placeholder={ids.length ? 'Tambah resep…' : 'Pilih resep…'}
                                onChange={(id) => addRecipe(tanggal, slot.value, id)}
                                className="h-8 text-xs"
                              />
                            ) : !ids.length ? (
                              <p className="text-[11px] text-slate-400">Kosong</p>
                            ) : null}
                            {!ids.length && (
                              <Link
                                href="/food-production/recipe"
                                className="text-[10px] text-orange-700 hover:underline inline-flex items-center gap-1"
                              >
                                <UtensilsCrossed className="h-3 w-3" />
                                Master resep
                              </Link>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="hidden xl:block sticky top-4">
          {inspector}
        </div>
      </div>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Inspector hari</SheetTitle>
          </SheetHeader>
          <div className="mt-4">{inspector}</div>
        </SheetContent>
      </Sheet>

      <Dialog open={acuanOpen} onOpenChange={setAcuanOpen}>
        <DialogContent className="max-w-5xl w-[min(96vw,56rem)] max-h-[92vh] overflow-hidden flex flex-col p-0 gap-0">
          <DialogHeader className="px-4 pt-4 pb-2 border-b shrink-0">
            <div className="flex flex-wrap items-center justify-between gap-2 pr-8">
              <DialogTitle>Acuan kerja dapur</DialogTitle>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!acuanDoc || Boolean(acuanPrinting) || !acuanDoc?.rekap.length}
                  onClick={() => void printAcuan('bahan')}
                >
                  <FileText className="h-3.5 w-3.5 mr-1" />
                  {acuanPrinting === 'bahan' ? 'Mencetak…' : 'Kebutuhan bahan saja'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="bg-orange-500 hover:bg-orange-600"
                  disabled={!acuanDoc || Boolean(acuanPrinting)}
                  onClick={() => void printAcuan('full')}
                >
                  <Printer className="h-3.5 w-3.5 mr-1" />
                  {acuanPrinting === 'full' ? 'Mencetak…' : 'Cetak / PDF'}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground font-normal">
              Hidangan, porsi, dan total bahan baku (buffer {RECIPE_NEED_BUFFER_PCT}%).
              Pilih Cetak / PDF lalu &quot;Save as PDF&quot;.
            </p>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 bg-slate-100 p-3 sm:p-4">
            {acuanDoc && (
              <div className="bg-white shadow-sm border rounded-md overflow-hidden">
                <MenuHarianDocument
                  tanggal={acuanDoc.tanggal}
                  kitchenNama={acuanDoc.kitchenNama || 'Dapur'}
                  porsiByKategori={acuanDoc.porsiByKategori}
                  hidangan={acuanDoc.hidangan}
                  rekap={acuanDoc.rekap}
                  note={acuanDoc.note}
                  productionPlanNo={acuanDoc.productionPlanNo}
                  productionPlanStatus={acuanDoc.productionPlanStatus}
                  draftWatermark={acuanDoc.draftWatermark}
                  errors={acuanDoc.errors}
                  fillEmptySlots
                />
              </div>
            )}
          </div>
          <DialogFooter className="px-4 py-3 border-t shrink-0">
            <Button variant="outline" onClick={() => setAcuanOpen(false)}>Tutup</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={packageOpen} onOpenChange={setPackageOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Terapkan paket menu</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Isi slot{' '}
            {selected
              ? `${WEEKLY_MENU_WEEKDAYS[weekDates.indexOf(selected.tanggal)] || ''} ${shortDate(selected.tanggal)}`
              : 'hari terpilih'}
            {' '}dari master Menu (paket resep untuk papan minggu). Resep master menentukan kategori; porsi dan catatan tidak berubah.
          </p>
          {selectedLocked && (
            <p className="text-sm text-amber-800">Hari ini terkunci — pilih hari lain dulu.</p>
          )}
          <div className="space-y-2">
            <Label>Paket</Label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={packageMenuId}
              onChange={(e) => setPackageMenuId(e.target.value)}
              aria-label="Pilih paket menu"
            >
              <option value="">Pilih paket…</option>
              {menus.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.kode} · {m.nama} ({(m.items || []).length} resep)
                </option>
              ))}
            </select>
            {!menus.length && (
              <p className="text-xs text-muted-foreground">
                Belum ada paket.{' '}
                <Link href="/food-production/menu" className="text-orange-700 hover:underline">
                  Buat di master Menu
                </Link>
              </p>
            )}
            {packageMenuId && (
              <ul className="text-xs border rounded-md divide-y max-h-40 overflow-auto">
                {presentMenuItems(menus.find((m) => m.id === packageMenuId)?.items || []).map((item) => {
                  const rec = recipesById.get(item.recipeId);
                  const slot = isKategoriMenu(rec?.kategoriMenu) ? rec.kategoriMenu : item.kategoriMenu;
                  return (
                    <li key={`${item.recipeId}-${slot}`} className="px-2 py-1.5 flex justify-between gap-2">
                      <span className="truncate">
                        {rec?.kode || item.recipeKode || item.recipeId} · {rec?.nama || item.recipeNama || 'Resep'}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {kategoriMenuLabel(slot)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPackageOpen(false)}>Batal</Button>
            <Button
              disabled={!packageMenuId || packageBusy || selectedLocked || !selected}
              onClick={() => void applyPackage()}
            >
              {packageBusy ? 'Menerapkan…' : 'Terapkan ke hari terpilih'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={republishOpen} onOpenChange={setRepublishOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Terbit ulang RPN yang diajukan?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            RPN {republishNos.join(', ') || 'hari ini'} sedang diajukan. Terbit ulang menimpa
            baris resep (qty bahan override tetap). Lanjut?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRepublishOpen(false)}>Batal</Button>
            <Button
              disabled={publishing}
              onClick={() => {
                setRepublishOpen(false);
                void publish(republishTanggal, { confirmSubmitted: true });
              }}
            >
              Terbit ulang
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={copyOpen} onOpenChange={setCopyOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Salin minggu lalu</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Menyalin slot, catatan, dan alergi {shortDate(shiftIsoDate(weekStart, -7))}
            {' '}– {shortDate(shiftIsoDate(weekDates[4], -7))} ke minggu ini. Tautan RPN tidak disalin.
            Hari terkunci dilewati.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={copyPorsi}
              onChange={(e) => setCopyPorsi(e.target.checked)}
            />
            Salin porsi (PM) juga
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyOpen(false)}>Batal</Button>
            <Button disabled={copyBusy || !kitchenId} onClick={() => void copyPreviousWeek()}>
              {copyBusy ? 'Menyalin…' : 'Salin'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={copyPorsiOpen} onOpenChange={setCopyPorsiOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Salin porsi ke hari lain</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Sumber:{' '}
            {selected
              ? `${WEEKLY_MENU_WEEKDAYS[weekDates.indexOf(selected.tanggal)] || ''} ${shortDate(selected.tanggal)}`
              : 'hari terpilih'}
            . Hanya porsi (PM) yang disalin — hidangan tidak berubah.
          </p>
          <MenuWeekSwitcher
            compact
            weekStart={copyTargetWeek}
            todayWeekStart={todayWeekStart}
            onWeekStartChange={(ws) => void changeCopyTargetWeek(ws)}
          />
          {copyTargetBusy ? (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Memuat hari tujuan…
            </p>
          ) : (
            <div className="space-y-1.5">
              {isoWeekdays(copyTargetWeek).map((tanggal, i) => {
                const locked = dayLocked(copyTargetLocks[tanggal]);
                const isSource = tanggal === selectedTanggal;
                const checked = copyTargetDates.includes(tanggal);
                return (
                  <label
                    key={tanggal}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm',
                      isSource || locked ? 'bg-slate-50 text-slate-500' : 'bg-white',
                    )}
                  >
                    <input
                      type="checkbox"
                      disabled={isSource || locked}
                      checked={isSource ? false : checked}
                      onChange={(e) => {
                        setCopyTargetDates((prev) => (
                          e.target.checked
                            ? [...prev, tanggal]
                            : prev.filter((d) => d !== tanggal)
                        ));
                      }}
                    />
                    <span className="flex-1">
                      {WEEKLY_MENU_WEEKDAYS[i]} · {shortDate(tanggal)}
                    </span>
                    {isSource ? (
                      <span className="text-[11px] text-orange-700">Sumber</span>
                    ) : locked ? (
                      <span className="text-[11px] text-slate-500">Terkunci</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyPorsiOpen(false)}>Batal</Button>
            <Button
              disabled={copyTargetBusy || copyPorsiSaving || !copyTargetDates.length}
              onClick={() => void confirmCopyPorsi()}
            >
              {copyPorsiSaving ? 'Menyalin…' : 'Salin porsi'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(clearConfirmTanggal)} onOpenChange={(open) => { if (!open) setClearConfirmTanggal(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kosongkan isian hari</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Hidangan, porsi penerima manfaat, alergi, dan catatan{' '}
            <span className="font-medium text-slate-800">
              {clearConfirmTanggal
                ? `${WEEKLY_MENU_WEEKDAYS[weekDates.indexOf(clearConfirmTanggal)] || ''} ${shortDate(clearConfirmTanggal)}`
                : 'hari ini'}
            </span>
            {' '}akan dihapus. Tautan RPN (jika ada) tetap — terbitkan ulang supaya RPN ikut kosong.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirmTanggal(null)}>Batal</Button>
            <Button variant="destructive" onClick={confirmClearDay}>Kosongkan hari</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={prefillOpen} onOpenChange={setPrefillOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Isi PM dari titik layanan</DialogTitle>
          </DialogHeader>
          {prefillSum && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Jumlah porsi titik layanan aktif dapur ini:{' '}
                <span className="font-medium tabular-nums">{sumAllPorsi(prefillSum).toLocaleString('id-ID')}</span>
              </p>
              <div className="grid grid-cols-2 gap-1 text-[11px]">
                {KATEGORI_PORSI_OPTIONS.map((opt) => (
                  <div key={opt.value} className="flex justify-between gap-2 rounded border px-2 py-1">
                    <span>{opt.label}</span>
                    <span className="tabular-nums">{(prefillSum[opt.value] || 0).toLocaleString('id-ID')}</span>
                  </div>
                ))}
              </div>
              <div className="space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="prefill-scope"
                    checked={prefillScope === 'selected'}
                    onChange={() => setPrefillScope('selected')}
                  />
                  Hari terpilih saja
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="prefill-scope"
                    checked={prefillScope === 'empty'}
                    onChange={() => setPrefillScope('empty')}
                  />
                  Semua hari yang PM-nya 0 (belum terkunci)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="prefill-scope"
                    checked={prefillScope === 'all'}
                    onChange={() => setPrefillScope('all')}
                  />
                  Semua hari belum terkunci
                </label>
              </div>
              {prefillScope !== 'empty' && days.some((d) => {
                if (dayLocked(rpnByDate[d.tanggal]?.status)) return false;
                if (prefillScope === 'selected' && d.tanggal !== selectedTanggal) return false;
                return sumAllPorsi(d.porsiByKategori) > 0;
              }) && (
                <p className="text-xs text-amber-800">
                  Porsi yang sudah terisi di hari tujuan akan ditimpa.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrefillOpen(false)}>Batal</Button>
            <Button disabled={!prefillSum} onClick={applyPrefill}>Isi porsi</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {acuanDoc && (
        <PrintPortal>
          <div className="doc-print-host">
            {acuanPrinting === 'bahan' ? (
              <KebutuhanBahanHarianDocument
                tanggal={acuanDoc.tanggal}
                kitchenNama={acuanDoc.kitchenNama || 'Dapur'}
                planNos={acuanDoc.productionPlanNo ? [acuanDoc.productionPlanNo] : []}
                rekap={acuanDoc.rekap}
                printId={KEBUTUHAN_BAHAN_HARIAN_PRINT_ID}
              />
            ) : (
              <MenuHarianDocument
                tanggal={acuanDoc.tanggal}
                kitchenNama={acuanDoc.kitchenNama || 'Dapur'}
                porsiByKategori={acuanDoc.porsiByKategori}
                hidangan={acuanDoc.hidangan}
                rekap={acuanDoc.rekap}
                note={acuanDoc.note}
                productionPlanNo={acuanDoc.productionPlanNo}
                productionPlanStatus={acuanDoc.productionPlanStatus}
                draftWatermark={acuanDoc.draftWatermark}
                errors={acuanDoc.errors}
                fillEmptySlots
                printId={MENU_HARIAN_PRINT_ID}
              />
            )}
          </div>
        </PrintPortal>
      )}
    </div>
  );
}

function DayGiziChip({
  gizi,
  loading,
  compact,
}: {
  gizi?: DayGizi | null;
  loading?: boolean;
  compact?: boolean;
}) {
  if (loading && !gizi) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {compact ? 'Gizi…' : 'Menghitung gizi…'}
      </span>
    );
  }
  if (!gizi) {
    return compact
      ? null
      : <p className="text-[11px] text-muted-foreground">Isi resep + porsi untuk estimasi AKG.</p>;
  }
  const label = gizi.akg === 'PORSI_KECIL' ? 'AKG kecil' : 'AKG besar';
  const noTkpi = !(gizi.energiKcal >= 1) && !(gizi.proteinG >= 0.1);
  if (noTkpi) {
    return (
      <div className={cn('text-[10px] text-slate-500', compact ? 'mt-0.5' : 'rounded border bg-slate-50 px-2 py-1.5')}>
        Tanpa data TKPI
        {!compact && gizi.warnings[0] ? <span className="block text-amber-800">{gizi.warnings[0]}</span> : null}
      </div>
    );
  }
  return (
    <div className={cn('text-[10px] tabular-nums', compact ? 'mt-0.5' : 'rounded border bg-slate-50 px-2 py-1.5 space-y-0.5')}>
      <span className={cn('font-medium', giziTone(gizi.energiPct))}>
        ~{formatEstKcal(gizi.energiKcal)} kkal · {Math.round(gizi.energiPct)}% energi
      </span>
      {!compact && (
        <span className={cn('block', giziTone(gizi.proteinPct))}>
          {gizi.proteinG.toLocaleString('id-ID', { maximumFractionDigits: 1 })} g protein · {Math.round(gizi.proteinPct)}% · {label}
        </span>
      )}
      {compact && (
        <span className="block text-muted-foreground">{label}</span>
      )}
      {!compact && gizi.warnings[0] ? (
        <span className="block text-amber-800">{gizi.warnings[0]}</span>
      ) : null}
    </div>
  );
}

function DayInspector({
  day,
  locked,
  canManage,
  rpn,
  recipes,
  recipesById,
  weekDates,
  onPorsi,
  onNote,
  onAlergi,
  onCopyPorsi,
  onPublishDay,
  onOpenAcuan,
  onApplyPackage,
  onClearDay,
  gizi,
  giziLoading,
  publishing,
}: {
  day: WeeklyMenuDay;
  locked: boolean;
  canManage: boolean;
  rpn?: PlanLite;
  recipes: RecipeOpt[];
  recipesById: Map<string, RecipeOpt>;
  weekDates: string[];
  onPorsi: (key: keyof PortionTargetMap, val: string) => void;
  onNote: (note: string) => void;
  onAlergi: (alergi: WeeklyMenuAlergi[]) => void;
  onCopyPorsi: () => void;
  onPublishDay: () => void;
  onOpenAcuan: () => void;
  onApplyPackage: () => void;
  onClearDay: () => void;
  gizi?: DayGizi | null;
  giziLoading?: boolean;
  publishing: boolean;
}) {
  const used = new Set([
    ...Object.values(day.slots || {}).flat(),
    ...(day.alergi || []).map((a) => a.recipeId),
  ]);
  const alergiOptions = recipes.filter((r) => r.aktif !== false && !used.has(r.id));
  const total = sumAllPorsi(day.porsiByKategori);
  const preview = useMemo(() => {
    const built = buildKebutuhanBahanFromWeeklyDay(
      day,
      recipesById as Map<string, KebutuhanRecipeRef>,
    );
    return {
      lines: built.rekap.map((n) => ({
        bahan: n.productNama || n.productKode || n.productId,
        qty: n.qty,
        satuan: n.satuan,
      })),
      hint: built.errors[0],
    };
  }, [day, recipesById]);

  return (
    <div className="rounded-lg border bg-white p-3 space-y-3">
      <div>
        <h2 className="font-semibold text-sm">{formatPlanDateLabel(day.tanggal)}</h2>
        <p className="text-xs text-muted-foreground">
          {rpn
            ? `${rpn.noDokumen} · ${PLAN_STATUS_LABELS[rpn.status] || rpn.status}`
            : day.productionPlanNo
              ? day.productionPlanNo
              : 'Belum terbit ke RPN'}
        </p>
      </div>
      <DayGiziChip gizi={gizi} loading={giziLoading} />
      {canManage && !locked && (
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onApplyPackage}>
            <Package className="h-4 w-4 mr-1" />
            Terapkan paket
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="menu-day-clear-inspector"
            aria-label="Kosongkan isian hari"
            onClick={onClearDay}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Kosongkan
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {KATEGORI_PORSI_OPTIONS.map((opt) => (
          <div key={opt.value} className="space-y-1">
            <Label className="text-[11px]">{opt.label}</Label>
            <Input
              type="number"
              min={0}
              className="h-8"
              disabled={!canManage || locked}
              value={day.porsiByKategori?.[opt.value] ?? 0}
              onChange={(e) => onPorsi(opt.value, e.target.value)}
            />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Sekolah {sumSekolahPorsi(day.porsiByKategori).toLocaleString('id-ID')}
        {' · '}Posyandu {sumPosyanduPorsi(day.porsiByKategori).toLocaleString('id-ID')}
        {' · '}Total {total.toLocaleString('id-ID')}
      </p>
      {canManage && !locked && weekDates.length > 1 && (
        <Button type="button" variant="outline" size="sm" className="w-full" onClick={onCopyPorsi}>
          Salin porsi ke hari lain
        </Button>
      )}

      <div className="space-y-1">
        <Label className="text-xs">Catatan hari</Label>
        <textarea
          className="w-full min-h-[4.5rem] rounded-md border px-2 py-1.5 text-sm"
          disabled={!canManage || locked}
          value={day.note || ''}
          onChange={(e) => onNote(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Alergi (resep pengganti + porsi ekstra)</Label>
        {(day.alergi || []).map((row, idx) => {
          const rec = recipesById.get(row.recipeId);
          return (
            <div key={`${row.recipeId}-${idx}`} className="space-y-1 rounded border p-1.5">
              <div className="flex items-center gap-1">
                <span className="flex-1 truncate text-[11px] rounded px-1.5 py-1 bg-slate-50">
                  {rec ? `${rec.kode} · ${rec.nama}` : row.recipeId}
                </span>
                <Input
                  type="number"
                  min={1}
                  className="h-8 w-16"
                  disabled={!canManage || locked}
                  value={row.porsi}
                  onChange={(e) => {
                    const next = [...(day.alergi || [])];
                    next[idx] = { ...row, porsi: Math.max(1, Math.floor(Number(e.target.value) || 1)) };
                    onAlergi(next);
                  }}
                />
                {canManage && !locked && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="px-1"
                    onClick={() => onAlergi((day.alergi || []).filter((_, i) => i !== idx))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              <Input
                className="h-8 text-xs"
                disabled={!canManage || locked}
                placeholder="Catatan alergi"
                value={row.catatan || ''}
                onChange={(e) => {
                  const next = [...(day.alergi || [])];
                  const catatan = e.target.value;
                  next[idx] = { ...row, ...(catatan.trim() ? { catatan } : { catatan: undefined }) };
                  onAlergi(next);
                }}
              />
            </div>
          );
        })}
        {canManage && !locked && (
          <div className="flex items-center gap-1">
            <div className="flex-1">
              <RecipeSearchSelect
                value=""
                recipes={alergiOptions}
                placeholder="Tambah resep alergi…"
                onChange={(id) => {
                  if (!id) return;
                  onAlergi([...(day.alergi || []), { recipeId: id, porsi: 1 }]);
                }}
                className="h-8 text-xs"
              />
            </div>
            <Plus className="h-4 w-4 text-slate-400" />
          </div>
        )}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Preview bahan (buffer {RECIPE_NEED_BUFFER_PCT}%)</Label>
        {preview.lines.length ? (
          <div className="max-h-40 overflow-auto border rounded text-[11px]">
            <table className="w-full">
              <tbody>
                {preview.lines.map((row, i) => (
                  <tr key={`${row.bahan}-${i}`} className="border-b last:border-0">
                    <td className="px-1.5 py-1 truncate">{row.bahan}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums whitespace-nowrap">
                      {row.qty.toLocaleString('id-ID')} {row.satuan || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {preview.hint || 'Isi slot resep dan penerima manfaat untuk melihat kebutuhan bahan.'}
          </p>
        )}
        {preview.hint && preview.lines.length ? (
          <p className="text-[10px] text-amber-700">{preview.hint}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Button variant="outline" className="w-full" onClick={onOpenAcuan}>
          <Printer className="h-4 w-4 mr-1" />
          Unduh PDF acuan kerja
        </Button>
        {canManage && (
          <Button onClick={onPublishDay} disabled={publishing || locked} className="w-full">
            <Send className="h-4 w-4 mr-1" />
            Terbitkan hari ini
          </Button>
        )}
        {(rpn || day.productionPlanId) && (
          <Button variant="outline" className="w-full" asChild>
            <Link href={planHref({
              productionPlanId: rpn?.id || day.productionPlanId,
              tanggal: day.tanggal,
            })}>Buka Rencana Produksi</Link>
          </Button>
        )}
      </div>
    </div>
  );
}
