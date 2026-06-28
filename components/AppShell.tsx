'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { getUser, clearUser, syncSessionUser } from '@/lib/auth-client';
import type { SessionUser } from '@/types/auth';
import {
  LayoutDashboard, ShoppingCart, Package, Receipt, LogOut, Menu, Store,
  Boxes, FileEdit, Factory, ChevronDown, ChevronRight, Users, UserCircle,
  Database, Truck, ShoppingBag, FileText, Banknote, BookOpen,
  TrendingUp, TrendingDown, ArrowDownToLine, ArrowUpFromLine, Scale, Settings, Building2, UserCog,
  MapPin, ArrowLeftRight, RotateCcw, Calculator, Lock, Printer, Wrench, Cog, CalendarClock, BarChart3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { fetchTenantSettings } from '@/lib/tenant-client';
import { getLokasiAktif, loadLokasiForTenant } from '@/lib/lokasi-client';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import TenantScopeSelector from '@/components/TenantScopeSelector';
import { triggerVendorCatalogAutoSync } from '@/lib/integration-auto-sync';
import { debounce } from '@/lib/debounce';
import { useGrnPendingCount } from '@/lib/hooks/use-goods-receipts';
import { useHutangPendingCount } from '@/lib/hooks/use-vendor-hutang';

import { useWrPendingCount, usePmDueCount } from '@/lib/hooks/use-maintenance';

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
    ],
  },
];

const DEFAULT_EXPANDED: Record<string, boolean> = Object.fromEntries(
  NAV.filter((item): item is NavGroup => item.type === 'group').map((item) => [item.key, true]),
);

const ROLE_PERMISSIONS: Record<string, string[] | '*'> = {
  GUDANG: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/transfer'],
  SUPERVISOR: ['/dashboard', '/penerimaan', '/pembelian-po', '/produk',
    '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
    '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer'],
  ADMIN: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
          '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
          '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi',
          '/integrasi', '/utiliti/tenant', '/utiliti/user'],
  OWNER: ['/dashboard', '/penerimaan', '/pembelian-po', '/hutang', '/pengeluaran-pengadaan', '/produk',
          '/maintenance/permintaan', '/maintenance/jadwal', '/maintenance/aset', '/maintenance/laporan',
          '/stok/saldo', '/stok/release', '/stok/kartu', '/stok/penyesuaian', '/stok/transfer', '/stok/lokasi',
          '/integrasi', '/utiliti/tenant', '/utiliti/user'],
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
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [now, setNow] = useState(new Date());
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(DEFAULT_EXPANDED);
  const [tenantLogo, setTenantLogo] = useState('');
  const [lokasiLabel, setLokasiLabel] = useState('');
  const [scopeTenantLabel, setScopeTenantLabel] = useState('');
  const [navBadges, setNavBadges] = useState<Record<NavBadgeKey, number>>({
    hutangReview: 0, grnPending: 0, wrPending: 0, pmOverdue: 0,
  });

  const GRN_BADGE_ROLES = new Set(['GUDANG', 'SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER']);

  const refreshOperationalScope = async (synced: SessionUser) => {
    if (!synced) return;
    const isMaster = synced.role === 'MASTER';
    const actingId = isMaster ? getActingTenantId() : '';
    const scopeId = isMaster ? actingId : (synced.tenantId || 'default');

    if (isMaster && !actingId) {
      setScopeTenantLabel('');
      setLokasiLabel('');
      return;
    }

    const settings = await fetchTenantSettings(scopeId, { bustCache: false }).catch(() => null);
    setScopeTenantLabel(settings?.companyName || settings?.tenantName || scopeId);

    const lok = await loadLokasiForTenant(scopeId, {
      actingTenantId: isMaster ? actingId : undefined,
      isMaster,
    });
    setLokasiLabel(lok.lokasiAktif || getLokasiAktif(scopeId) || '');
  };

  useEffect(() => {
    const u = getUser();
    if (u) setUserState(u);
    syncSessionUser().then((synced) => {
      if (!synced) {
        router.replace('/');
        return;
      }
      setUserState(synced);
      refreshOperationalScope(synced);
      if (synced.role !== 'MASTER') {
        triggerVendorCatalogAutoSync().catch(() => {});
      }
      const logoTenant = synced.role === 'MASTER' ? getActingTenantId() : (synced.tenantId || 'default');
      if (synced.role !== 'MASTER' || logoTenant) {
        fetchTenantSettings(logoTenant || synced.tenantId, { bustCache: false }).then((s) => {
          if (s?.logoBase64) setTenantLogo(s.logoBase64);
        });
      }
    });
  }, [router]);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return undefined;
    const onScopeChange = () => {
      refreshOperationalScope(user);
      queryClient.invalidateQueries();
    };
    window.addEventListener('erp-scope-change', onScopeChange);
    window.addEventListener('storage', onScopeChange);
    return () => {
      window.removeEventListener('erp-scope-change', onScopeChange);
      window.removeEventListener('storage', onScopeChange);
    };
  }, [user, queryClient]);

  const showHutangBadge = user && ['ADMIN', 'MASTER', 'OWNER'].includes(user.role);
  const showGrnBadge = user && GRN_BADGE_ROLES.has(user.role);
  const showWrBadge = user && ['ADMIN', 'MASTER', 'OWNER'].includes(user.role);
  const showPmBadge = user && ['SUPERVISOR', 'ADMIN', 'MASTER', 'OWNER'].includes(user.role);
  const { data: grnPending = 0 } = useGrnPendingCount(!!showGrnBadge);
  const { data: hutangReview = 0 } = useHutangPendingCount(!!showHutangBadge);
  const { data: wrPending = 0 } = useWrPendingCount(!!showWrBadge);
  const { data: pmOverdue = 0 } = usePmDueCount(!!showPmBadge);

  const debouncedBadgeRefresh = useMemo(
    () => debounce(() => {
      queryClient.invalidateQueries({ queryKey: ['goods-receipts', 'pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['hutang', 'pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['maintenance-requests', 'pending-count'] });
      queryClient.invalidateQueries({ queryKey: ['maintenance-schedules', 'due-count'] });
    }, 300),
    [queryClient],
  );

  useEffect(() => {
    setNavBadges((prev) => ({ ...prev, grnPending, hutangReview, wrPending, pmOverdue }));
  }, [grnPending, hutangReview, wrPending, pmOverdue]);

  useEffect(() => {
    const onGrn = () => debouncedBadgeRefresh();
    const onHutang = () => debouncedBadgeRefresh();
    const onMaintenance = () => debouncedBadgeRefresh();
    window.addEventListener('erp-grn-change', onGrn);
    window.addEventListener('erp-hutang-change', onHutang);
    window.addEventListener('erp-maintenance-change', onMaintenance);
    return () => {
      window.removeEventListener('erp-grn-change', onGrn);
      window.removeEventListener('erp-hutang-change', onHutang);
      window.removeEventListener('erp-maintenance-change', onMaintenance);
    };
  }, [debouncedBadgeRefresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const next: Record<string, boolean> = {};
    if (pathname?.startsWith('/stok')) next.stok = true;
    if (pathname?.startsWith('/produk') || pathname?.startsWith('/pelanggan') || pathname?.startsWith('/member') || pathname?.startsWith('/supplier')) next.master = true;
    if (pathname?.startsWith('/transaksi') || pathname?.startsWith('/piutang')) next.penjualan = true;
    if (pathname?.startsWith('/pembelian') || pathname?.startsWith('/hutang') || pathname?.startsWith('/pengeluaran-pengadaan')) next.pembelian = true;
    if (pathname?.startsWith('/penjualan')) next.penjualan = true;
    if (pathname?.startsWith('/laporan')) next.laporan = true;
    if (pathname?.startsWith('/akunting')) next.akunting = true;
    if (pathname?.startsWith('/retur')) next.retur = true;
    if (pathname?.startsWith('/utiliti')) next.utiliti = true;
    if (pathname?.startsWith('/maintenance')) next.maintenance = true;
    setExpanded((s) => ({ ...s, ...next }));
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

  if (!user) return null;

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
        } md:relative md:flex w-64 h-full min-h-0 bg-bgn-navy text-slate-100 flex-shrink-0 flex flex-col`}
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
        <nav className="flex-1 min-h-0 px-3 py-4 space-y-1 overflow-y-auto overscroll-contain">
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
                    onClick={() => setExpanded((s) => ({ ...s, [item.key]: !s[item.key] }))}
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
            <div className="hidden sm:block text-sm text-slate-600 font-mono">{formatDateTime(now)}</div>
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
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
