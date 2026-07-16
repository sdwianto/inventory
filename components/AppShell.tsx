'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import { clearUser, syncSessionUser } from '@/lib/auth-client';
import type { SessionUser } from '@/types/auth';
import {
  LayoutDashboard, ShoppingCart, Package, Receipt, LogOut, Menu, Store,
  Boxes, FileEdit, Factory, ChevronDown, ChevronRight, Users, UserCircle,
  Database, Truck, ShoppingBag, FileText, Banknote, BookOpen,
  TrendingUp, TrendingDown, ArrowDownToLine, ArrowUpFromLine, Scale, Settings, Building2, UserCog,
  MapPin, ArrowLeftRight, RotateCcw, Calculator, Lock, Printer, Wrench, Cog, CalendarClock, BarChart3,
  Eraser, Activity, Shield, ChefHat, UtensilsCrossed, Apple, BadgeCheck, LineChart, LayoutGrid, ClipboardList,
  PackageOpen, KeyRound, Lightbulb, MapPinned, Thermometer, ShieldCheck, Smartphone,
} from 'lucide-react';
import { isSandboxResetMenuVisible } from '@/lib/sandbox-client';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import TenantScopeSelector from '@/components/TenantScopeSelector';
import { debounce } from '@/lib/debounce';
import { useVendorCatalogAutoSync } from '@/lib/hooks/use-vendor-catalog-auto-sync';
import {
  applyWorkspaceLokasi,
  useWorkspaceBootstrap,
} from '@/lib/hooks/use-workspace-bootstrap';
import { invalidateNavBadges, useNavBadges } from '@/lib/hooks/use-nav-badges';
import { invalidateOperationalCaches } from '@/lib/hooks/invalidate-operational';
import { prefetchRouteData } from '@/lib/prefetch-route';
import { prefetchRouteFlow } from '@/lib/prefetch-flow';
import { debouncedPrefetch, prefetchNavGroupThrottled } from '@/lib/prefetch-throttle';
import { prefetchByRole } from '@/lib/prefetch-by-role';
import { fetchTenantSettings } from '@/lib/tenant-client';
import { useKeepWarm } from '@/lib/hooks/use-keep-warm';
import WorkerHealthBanner from '@/components/WorkerHealthBanner';

type NavBadgeKey = 'grnPending' | 'hutangReview' | 'wrPending' | 'pmOverdue';

interface NavLeaf {
  href: string;
  label: string;
  icon: LucideIcon;
  badgeKey?: NavBadgeKey;
}

interface NavItem extends NavLeaf {
  type: 'item';
  highlight?: boolean;
  badgeKey?: NavBadgeKey;
}

interface NavGroup {
  type: 'group';
  key: string;
  label: string;
  icon: LucideIcon;
  items: NavLeaf[];
}

type NavEntry = NavItem | NavGroup;

interface AppShellProps {
  children: ReactNode;
}

const NAV: NavEntry[] = [
  { type: 'item', href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { type: 'item', href: '/penerimaan', label: 'Penerimaan (GRN)', icon: Truck, highlight: true, badgeKey: 'grnPending' },
  { type: 'item', href: '/pembelian-po', label: 'PO ke Vendor', icon: ShoppingBag },
  { type: 'item', href: '/hutang', label: 'Tagihan Vendor', icon: Banknote, badgeKey: 'hutangReview' },
  { type: 'item', href: '/pengeluaran-pengadaan', label: 'Pengeluaran Pengadaan', icon: TrendingDown },
  {
    type: 'group', key: 'maintenance', label: 'Maintenance', icon: Wrench,
    items: [
      { href: '/maintenance/permintaan', label: 'Permintaan (WR)', icon: Wrench, badgeKey: 'wrPending' },
      { href: '/maintenance/jadwal', label: 'Jadwal PM', icon: CalendarClock, badgeKey: 'pmOverdue' },
      { href: '/maintenance/aset', label: 'Register Aset', icon: Cog },
      { href: '/maintenance/laporan', label: 'Laporan', icon: BarChart3 },
    ],
  },
  {
    type: 'group', key: 'foodProduction', label: 'Food Production', icon: ChefHat,
    items: [
      { href: '/food-production/kitchen', label: 'Dapur', icon: ChefHat },
      { href: '/food-production/recipe', label: 'Resep', icon: BookOpen },
      { href: '/food-production/menu', label: 'Menu', icon: UtensilsCrossed },
      { href: '/food-production/plan', label: 'Rencana Produksi', icon: CalendarClock },
      { href: '/food-production/mrp', label: 'Kebutuhan Bahan', icon: Calculator },
      { href: '/food-production/purchase-requirement', label: 'Kebutuhan Beli', icon: ShoppingCart },
      { href: '/food-production/issue', label: 'Pengambilan Bahan', icon: ArrowUpFromLine },
      { href: '/food-production/result', label: 'Hasil Produksi', icon: Factory },
      { href: '/food-production/mobile', label: 'Mode Dapur', icon: Smartphone },
      { href: '/food-production/report', label: 'Laporan Produksi', icon: ClipboardList },
      { href: '/food-production/calendar', label: 'Kalender Produksi', icon: CalendarClock },
      { href: '/food-production/transfer', label: 'Transfer Dapur', icon: ArrowLeftRight },
      { href: '/food-production/service-point', label: 'Titik Layanan', icon: MapPinned },
      { href: '/food-production/distribution', label: 'Distribusi', icon: Truck },
      { href: '/food-production/cold-chain', label: 'Cold Chain', icon: Thermometer },
      { href: '/food-production/haccp', label: 'HACCP', icon: ShieldCheck },
      { href: '/food-production/batch', label: 'Batch & Expiry', icon: PackageOpen },
      { href: '/food-production/nutrition', label: 'Gizi (MBG)', icon: Apple },
      { href: '/food-production/cost', label: 'Biaya Pangan', icon: Calculator },
      { href: '/food-production/price-book', label: 'Price Book', icon: BookOpen },
      { href: '/food-production/qc', label: 'Quality Control', icon: BadgeCheck },
      { href: '/food-production/forecast', label: 'Forecast Bahan', icon: LineChart },
      { href: '/food-production/recommendations', label: 'Rekomendasi', icon: Lightbulb },
      { href: '/food-production/dashboard', label: 'Dashboard FP', icon: LayoutGrid },
    ],
  },
  {
    type: 'group', key: 'master', label: 'Master Data', icon: Database,
    items: [
      { href: '/produk', label: 'Produk', icon: Package },
    ],
  },
  {
    type: 'group', key: 'stok', label: 'Stok', icon: Boxes,
    items: [
      { href: '/stok/saldo', label: 'Saldo per Gudang', icon: Boxes },
      { href: '/stok/release', label: 'Release Inventory', icon: ArrowUpFromLine },
      { href: '/stok/kartu', label: 'Kartu Stok', icon: Receipt },
      { href: '/stok/penyesuaian', label: 'Penyesuaian', icon: FileEdit },
      { href: '/stok/transfer', label: 'Transfer Stok', icon: ArrowLeftRight },
      { href: '/stok/lokasi', label: 'Gudang Operasional', icon: MapPin },
    ],
  },
  {
    type: 'group', key: 'utiliti', label: 'Pengaturan', icon: Settings,
    items: [
      { href: '/utiliti/tenant', label: 'Setup Tenant & Logo', icon: Building2 },
      { href: '/integrasi', label: 'Integrasi Sales.app', icon: Settings },
      { href: '/utiliti/user', label: 'User Management', icon: UserCog },
      { href: '/utiliti/tenants', label: 'Daftar Tenant (MASTER)', icon: Building2 },
      { href: '/utiliti/api-keys', label: 'API Keys', icon: KeyRound },
      { href: '/utiliti/audit', label: 'Audit Log (MASTER)', icon: Shield },
      { href: '/utiliti/ops', label: 'Ops Dashboard (MASTER)', icon: Activity },
      ...(isSandboxResetMenuVisible()
        ? [{ href: '/utiliti/sandbox', label: 'Reset Sandbox (MASTER)', icon: Eraser }]
        : []),
    ],
  },
];

const DEFAULT_EXPANDED: Record<string, boolean> = Object.fromEntries(
  NAV.filter((item): item is NavGroup => item.type === 'group').map((item) => [item.key, true]),
);

/** Master / Planning / Operation (+ QC dapur). */
const FP_OPS_ROUTES = [
  '/food-production/kitchen', '/food-production/recipe', '/food-production/menu', '/food-production/plan',
  '/food-production/mrp', '/food-production/purchase-requirement', '/food-production/issue', '/food-production/result',
  '/food-production/mobile',
  '/food-production/report', '/food-production/calendar', '/food-production/transfer',
  '/food-production/service-point', '/food-production/distribution', '/food-production/cold-chain',
  '/food-production/haccp', '/food-production/batch', '/food-production/qc',
] as const;

/** Cost / Nutrition / Forecast / AI / Dashboard — management (ADR coding #5). */
const FP_MGMT_ROUTES = [
  '/food-production/nutrition', '/food-production/cost', '/food-production/forecast',
  '/food-production/recommendations', '/food-production/dashboard', '/food-production/price-book',
] as const;

const FP_ROUTES = [...FP_OPS_ROUTES, ...FP_MGMT_ROUTES] as const;

const ROLE_PERMISSIONS: Record<string, string[] | '*'> = {
  GUDANG: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    ...FP_OPS_ROUTES,
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/transfer'],
  SUPERVISOR: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    ...FP_ROUTES,
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer'],
  ADMIN: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
          ...FP_ROUTES,
          '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
          '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi',
          '/integrasi', '/utiliti/tenant', '/utiliti/user', '/utiliti/api-keys'],
  OWNER: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
          ...FP_ROUTES,
          '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
          '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi',
          '/integrasi', '/utiliti/tenant', '/utiliti/user', '/utiliti/api-keys'],
  MASTER: '*',
};

function filterByRole(items: NavEntry[], role: string): NavEntry[] {
  const perms = ROLE_PERMISSIONS[role] || ['*'];
  if (perms === '*') return items;
  return items
    .map((item) => {
      if (item.type === 'item') return perms.includes(item.href) ? item : null;
      if (item.type === 'group') {
        const filteredChildren = item.items.filter((c) => perms.includes(c.href));
        return filteredChildren.length > 0 ? { ...item, items: filteredChildren } : null;
      }
      return null;
    })
    .filter((item): item is NavEntry => item !== null);
}

export default function AppShell({ children }: AppShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Start null so SSR + first client paint match (localStorage is client-only).
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(DEFAULT_EXPANDED);
  const [tenantLogo, setTenantLogo] = useState('');
  const [lokasiLabel, setLokasiLabel] = useState('');
  const [scopeTenantLabel, setScopeTenantLabel] = useState('');

  const {
    scopeId,
    tenantLabel: wsTenantLabel,
    lokasiList,
    branding,
    invalidate: invalidateWorkspace,
  } = useWorkspaceBootstrap(Boolean(user));

  const { data: liveBadges } = useNavBadges(Boolean(user));
  const badgeSource = liveBadges;
  const prevGrnPendingRef = useRef<number | null>(null);

  useVendorCatalogAutoSync(user);

  const GRN_BADGE_ROLES = new Set(['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER']);

  const refreshOperationalScope = () => {
    invalidateWorkspace();
  };

  useEffect(() => {
    if (!user) return;
    queueMicrotask(() => {
      setScopeTenantLabel(wsTenantLabel || '');
      setLokasiLabel(applyWorkspaceLokasi(scopeId, lokasiList) || '');
      if (branding) {
        if (branding.logoUrl) setTenantLogo(branding.logoUrl);
        else if (branding.logoBase64) setTenantLogo(branding.logoBase64);
        else setTenantLogo('');
      }
    });
  }, [user, wsTenantLabel, scopeId, lokasiList, branding]);

  useEffect(() => {
    syncSessionUser().then((synced) => {
      if (!synced) {
        setSessionReady(true);
        router.replace('/');
        return;
      }
      setUserState(synced);
      setSessionReady(true);
      refreshOperationalScope();
      const logoTenant = synced.role === 'MASTER' ? getActingTenantId() : (synced.tenantId || 'default');
      if (synced.role !== 'MASTER' || logoTenant) {
        fetchTenantSettings(logoTenant || synced.tenantId, { bustCache: false }).then((s) => {
          if (s?.logoUrl) setTenantLogo(s.logoUrl);
          else if (s?.logoBase64) setTenantLogo(s.logoBase64);
        });
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- session bootstrap runs once on mount
  }, [router]);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return;
    const scopeKey = getActingTenantId() || user.tenantId || '';
    const runIdle = (fn: () => void) => {
      let idleId: number | undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(fn, { timeout: 3000 });
      } else {
        timeoutId = setTimeout(fn, 150);
      }
      return () => {
        if (idleId != null && typeof window !== 'undefined') window.cancelIdleCallback(idleId);
        if (timeoutId != null) clearTimeout(timeoutId);
      };
    };
    return runIdle(() => prefetchByRole(queryClient, user.role));
  }, [user, queryClient]);

  useKeepWarm(Boolean(user));

  useEffect(() => {
    if (!user) return undefined;
    const onScopeChange = () => {
      invalidateWorkspace();
    };
    window.addEventListener('erp-scope-change', onScopeChange);
    return () => {
      window.removeEventListener('erp-scope-change', onScopeChange);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scope listener uses stable invalidate helpers
  }, [user, queryClient]);

  const showHutangBadge = user && ['ADMIN', 'MASTER', 'OWNER'].includes(user.role);
  const showGrnBadge = user && GRN_BADGE_ROLES.has(user.role);
  const showWrBadge = user && ['ADMIN', 'MASTER', 'OWNER'].includes(user.role);
  const showPmBadge = user && ['SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER'].includes(user.role);
  const pmBadgeCount = showPmBadge
    ? (Number(badgeSource?.pmOverdue) || 0) + (Number(badgeSource?.pmDueSoon) || 0)
    : 0;
  const navBadges: Record<NavBadgeKey, number> = {
    grnPending: showGrnBadge ? (Number(badgeSource?.grnPending) || 0) : 0,
    hutangReview: showHutangBadge ? (Number(badgeSource?.hutangReview) || 0) : 0,
    wrPending: showWrBadge ? (Number(badgeSource?.wrPending) || 0) : 0,
    pmOverdue: pmBadgeCount,
  };

  useEffect(() => {
    if (!showGrnBadge) return;
    const pending = navBadges.grnPending;
    const prev = prevGrnPendingRef.current;
    if (prev != null && pending > prev) {
      const delta = pending - prev;
      toast.info(
        delta === 1
          ? 'GRN baru dari pengiriman vendor — siap diterima'
          : `${delta} GRN baru dari pengiriman vendor`,
        {
          action: pathname === '/penerimaan'
            ? undefined
            : { label: 'Lihat', onClick: () => router.push('/penerimaan') },
        },
      );
    }
    prevGrnPendingRef.current = pending;
  }, [navBadges.grnPending, showGrnBadge, pathname, router]);

  const debouncedOperationalRefresh = useMemo(
    () => debounce(() => invalidateOperationalCaches(queryClient), 300),
    [queryClient],
  );

  useEffect(() => {
    const onGrn = () => debouncedOperationalRefresh();
    const onHutang = () => debouncedOperationalRefresh();
    const onMaintenance = () => debouncedOperationalRefresh();
    const onOfflineReplay = () => debouncedOperationalRefresh();
    window.addEventListener('erp-grn-change', onGrn);
    window.addEventListener('erp-hutang-change', onHutang);
    window.addEventListener('erp-maintenance-change', onMaintenance);
    window.addEventListener('erp-offline-replay-done', onOfflineReplay);
    return () => {
      window.removeEventListener('erp-grn-change', onGrn);
      window.removeEventListener('erp-hutang-change', onHutang);
      window.removeEventListener('erp-maintenance-change', onMaintenance);
      window.removeEventListener('erp-offline-replay-done', onOfflineReplay);
    };
  }, [debouncedOperationalRefresh]);

  useEffect(() => {
    if (!user || !pathname) return undefined;
    const run = () => prefetchRouteFlow(queryClient, pathname);
    let idleId: number | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(run, { timeout: 2000 });
    } else {
      timeoutId = setTimeout(run, 100);
    }
    return () => {
      if (idleId != null && typeof window !== 'undefined') window.cancelIdleCallback(idleId);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [user, pathname, queryClient]);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    if (pathname?.startsWith('/stok')) next.stok = true;
    if (pathname?.startsWith('/produk') || pathname?.startsWith('/pelanggan') || pathname?.startsWith('/member') || pathname?.startsWith('/supplier')) next.master = true;
    if (pathname?.startsWith('/food-production')) next.foodProduction = true;
    if (pathname?.startsWith('/transaksi') || pathname?.startsWith('/piutang')) next.penjualan = true;
    if (pathname?.startsWith('/pembelian') || pathname?.startsWith('/hutang') || pathname?.startsWith('/pengeluaran-pengadaan')) next.pembelian = true;
    if (pathname?.startsWith('/penjualan')) next.penjualan = true;
    if (pathname?.startsWith('/laporan')) next.laporan = true;
    if (pathname?.startsWith('/akunting')) next.akunting = true;
    if (pathname?.startsWith('/retur')) next.retur = true;
    if (pathname?.startsWith('/utiliti')) next.utiliti = true;
    if (pathname?.startsWith('/maintenance')) next.maintenance = true;
    queueMicrotask(() => setExpanded((s) => ({ ...s, ...next })));
  }, [pathname]);

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      /* ignore */
    }
    clearUser();
    router.replace('/');
  };

  if (!sessionReady || !user) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
      </div>
    );
  }

  const visibleNav = filterByRole(NAV, user.role);

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden no-print">
      {open && (
        <button
          type="button"
          aria-label="Tutup menu"
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={`${
          open ? 'fixed inset-y-0 left-0 z-50 flex' : 'hidden'
        } md:relative md:flex w-64 h-full min-h-0 bg-bgn-navy text-slate-100 flex-shrink-0 flex flex-col overflow-hidden`}
      >
        <div className="flex-shrink-0 px-5 py-5 border-b border-bgn-navy-light flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-bgn-gold flex items-center justify-center overflow-hidden shrink-0 ring-1 ring-bgn-gold-light/50">
            {tenantLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tenantLogo} alt="" className="w-full h-full object-contain bg-white" />
            ) : (
              <Store className="w-5 h-5" />
            )}
          </div>
          <div className="min-w-0">
            <div className="font-bold text-base leading-tight truncate">{user.tenantName || 'Inventory App'}</div>
            <div className="text-xs text-slate-400">
              {user.role === 'MASTER' ? <span className="text-bgn-gold font-semibold">MASTER • Pusat</span> : `Tenant: ${user.tenantId || 'default'}`}
            </div>
          </div>
        </div>
        <nav
          onWheel={(e) => {
            const nav = e.currentTarget;
            if (nav.scrollHeight > nav.clientHeight) e.stopPropagation();
          }}
          className="flex-1 min-h-0 px-3 py-4 space-y-1 overflow-y-auto overscroll-y-contain"
        >
          {user.role === 'MASTER' ? (
            <div className="px-1 pb-3 mb-2 border-b border-bgn-navy-light">
              <TenantScopeSelector />
            </div>
          ) : null}
          {visibleNav.map((item) => {
            if (item.type === 'item') {
              const Icon = item.icon;
              const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              const badgeCount = item.badgeKey ? navBadges[item.badgeKey] : 0;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  onMouseEnter={() => debouncedPrefetch(item.href, () => prefetchRouteData(queryClient, item.href))}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                    active ? 'nav-active-bgn' : 'text-slate-300 hover:bg-bgn-navy-light hover:text-white'
                  } ${item.highlight && !active ? 'ring-1 ring-bgn-gold/50' : ''}`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1">{item.label}</span>
                  {item.badgeKey && badgeCount > 0 && (
                    <span className="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-orange-500 text-white text-xs font-bold flex items-center justify-center">
                      {badgeCount}
                    </span>
                  )}
                </Link>
              );
            }
            if (item.type === 'group') {
              const Icon = item.icon;
              const isOpen = !!expanded[item.key];
              const groupActive = item.items.some((c) => pathname === c.href || pathname?.startsWith(`${c.href}/`));
              const groupBadge = item.items.reduce(
                (sum, c) => sum + (c.badgeKey ? navBadges[c.badgeKey] : 0),
                0,
              );
              return (
                <div key={item.key}>
                  <button
                    onClick={() => {
                      setExpanded((s) => {
                        const nextOpen = !s[item.key];
                        if (nextOpen) {
                          prefetchNavGroupThrottled(
                            queryClient,
                            item.items.map((c) => c.href),
                            prefetchRouteData,
                          );
                        }
                        return { ...s, [item.key]: nextOpen };
                      });
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors ${
                      groupActive ? 'text-bgn-gold font-medium' : 'text-slate-300 hover:bg-bgn-navy-light hover:text-white'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="flex-1 text-left">{item.label}</span>
                    {groupBadge > 0 && (
                      <span className="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-orange-500 text-white text-xs font-bold flex items-center justify-center">
                        {groupBadge}
                      </span>
                    )}
                    {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  </button>
                  {isOpen && (
                    <div className="ml-3 mt-1 space-y-0.5 border-l border-bgn-navy-light pl-2">
                      {item.items.map((c) => {
                        const CIcon = c.icon;
                        const cActive = pathname === c.href || pathname?.startsWith(`${c.href}/`);
                        const cBadge = c.badgeKey ? navBadges[c.badgeKey] : 0;
                        return (
                          <Link
                            key={c.href}
                            href={c.href}
                            onClick={() => setOpen(false)}
                            onMouseEnter={() => debouncedPrefetch(c.href, () => prefetchRouteData(queryClient, c.href))}
                            className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs transition-colors ${
                              cActive ? 'nav-active-bgn' : 'text-slate-400 hover:bg-bgn-navy-light hover:text-white'
                            }`}
                          >
                            <CIcon className="w-3.5 h-3.5" />
                            <span className="flex-1">{c.label}</span>
                            {c.badgeKey && cBadge > 0 && (
                              <span className="min-w-[1.125rem] h-4 px-1 rounded-full bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center">
                                {cBadge}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            return null;
          })}
        </nav>
        <div className="flex-shrink-0 px-3 py-3 border-t border-bgn-navy-light bg-bgn-navy">
          <div className="px-3 py-2 text-xs text-slate-400">
            <div className="font-medium text-slate-200 truncate">{user.name}</div>
            <div className="truncate">{user.role} • {user.email}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            className="w-full justify-start text-slate-200 hover:bg-red-600/90 hover:text-white mt-1"
          >
            <LogOut className="w-4 h-4 mr-2 shrink-0" /> Keluar
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 bg-white border-b border-bgn-sky flex items-center justify-between px-4 flex-shrink-0 shadow-sm">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(!open)}>
              <Menu className="w-5 h-5" />
            </Button>
            <div className="text-sm text-slate-600 flex items-center gap-2 flex-wrap">
              {user.role === 'MASTER' && (
                <span className="px-2 py-0.5 bg-bgn-gold/20 text-bgn-gold text-xs font-bold rounded border border-bgn-gold/30">MASTER</span>
              )}
              {user.role === 'ADMIN' && (
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-bold rounded">ADMIN</span>
              )}
              {user.role === 'SUPERVISOR' && (
                <span className="px-2 py-0.5 bg-amber-100 text-amber-800 text-xs font-bold rounded">SUPERVISOR</span>
              )}
              {user.role === 'GUDANG' && (
                <span className="px-2 py-0.5 bg-slate-100 text-slate-700 text-xs font-bold rounded">GUDANG</span>
              )}
              <span className="text-slate-300 hidden sm:inline">|</span>
              {user.role === 'MASTER' && !scopeTenantLabel ? (
                <span className="text-amber-700 text-xs sm:text-sm">Pilih tenant operasional di sidebar</span>
              ) : (
                <>
                  {scopeTenantLabel && (
                    <span className="font-medium text-slate-800">{scopeTenantLabel}</span>
                  )}
                  <span className="text-slate-400">•</span>
                  <span className="text-slate-400">Lokasi:</span>
                  <span className="font-medium text-slate-800">
                    {lokasiLabel || '— pilih di Kasir / Pembelian —'}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:block text-sm text-slate-600 font-mono">{now ? formatDateTime(now) : '—'}</div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="text-slate-600 hover:text-red-600 hover:border-red-200"
            >
              <LogOut className="w-4 h-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Keluar</span>
            </Button>
          </div>
        </header>
        <WorkerHealthBanner enabled={user.role === 'MASTER'} />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
