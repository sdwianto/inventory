'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import { actingKitchenHeaders } from '@/lib/acting-kitchen-client';
import { formatDate, formatNumber } from '@/lib/format';
import {
  VENDOR_AVAILABILITY_TTL_MS,
  type ItemAvailabilityStatus,
  type PoAvailabilityView,
  type PoItemAvailabilityView,
  type VendorSegmentState,
} from '@/lib/pembelian-po/vendor-availability-view';

const STATUS_LABEL: Record<ItemAvailabilityStatus, string> = {
  TERKIRIM: 'Terkirim',
  SIAP: 'Siap kirim',
  DIADAKAN: 'Sedang diadakan',
  BELUM: 'Belum diadakan',
  DIBATALKAN: 'Dibatalkan',
  TIDAK_DIKETAHUI: 'Belum ada info',
};

const STATUS_STYLE: Record<ItemAvailabilityStatus, string> = {
  TERKIRIM: 'bg-slate-100 text-slate-700 border-slate-200',
  SIAP: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DIADAKAN: 'bg-sky-50 text-sky-700 border-sky-200',
  BELUM: 'bg-red-50 text-red-700 border-red-200',
  DIBATALKAN: 'bg-rose-50 text-rose-600 border-rose-200',
  TIDAK_DIKETAHUI: 'bg-white text-slate-400 border-slate-200',
};

const VENDOR_STATE_NOTE: Partial<Record<VendorSegmentState, string>> = {
  UNSUPPORTED: 'Status vendor belum tersedia',
  NO_SO: 'SO vendor belum ditemukan',
  NOT_LINKED: 'Belum terhubung ke sales.app',
  ERROR: 'Gagal memuat status vendor — menampilkan data terakhir',
};

function relativeTime(isoStr: string | null, now: number): string {
  if (!isoStr) return 'belum pernah diperbarui';
  const mins = Math.max(0, Math.round((now - new Date(isoStr).getTime()) / 60_000));
  if (mins < 1) return 'diperbarui baru saja';
  if (mins < 60) return `diperbarui ${mins} menit lalu`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `diperbarui ${hours} jam lalu`;
  return `diperbarui ${Math.round(hours / 24)} hari lalu`;
}

/** State ketersediaan satu PO: awal dari list, auto-muat saat dibuka bila basi, tombol Perbarui. */
export function usePoVendorAvailability(
  poId: string,
  initial: PoAvailabilityView | null,
  expanded: boolean,
) {
  const [fetched, setFetched] = useState<{
    base: PoAvailabilityView | null;
    view: PoAvailabilityView;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const autoLoaded = useRef(false);
  const requestSeq = useRef(0);
  const view = fetched && fetched.base === initial ? fetched.view : initial;
  const setView = useCallback(
    (next: PoAvailabilityView) => setFetched({ base: initial, view: next }),
    [initial],
  );

  const load = useCallback(async (refresh: boolean) => {
    if (!poId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/customer-purchase-orders/${poId}/vendor-availability${refresh ? '?refresh=1' : ''}`,
        { headers: { ...actingTenantHeaders(), ...actingKitchenHeaders() } },
      );
      const data = await res.json().catch(() => ({}));
      // Respons permintaan lama yang tiba belakangan tidak boleh menimpa yang lebih baru.
      if (seq !== requestSeq.current) return;
      if (!res.ok) {
        if (refresh) toast.error(String(data.error || 'Gagal memuat status vendor'));
        return;
      }
      if (data.view) setView(data.view as PoAvailabilityView);
      if (refresh && data.skipped === 'rate_limited') {
        toast.info('Status baru saja diperbarui — coba lagi sebentar lagi');
      } else if (refresh && data.skipped === 'in_progress') {
        toast.info('Sedang diperbarui oleh pengguna lain');
      }
    } catch {
      if (refresh && seq === requestSeq.current) toast.error('Gagal memuat status vendor');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [poId, setView]);

  useEffect(() => {
    if (!expanded || autoLoaded.current) return;
    if (view?.mode !== 'REMOTE') return;
    // `stale` dari server dihitung saat daftar dimuat — daftar yang lama terbuka perlu dicek ulang di klien.
    const fetchedMs = view.fetchedAt ? new Date(view.fetchedAt).getTime() : 0;
    if (!view.stale && Date.now() - fetchedMs <= VENDOR_AVAILABILITY_TTL_MS) return;
    autoLoaded.current = true;
    queueMicrotask(() => void load(false));
  }, [expanded, view, load]);

  return { view, loading, refresh: () => load(true) };
}

/** Ringkasan di header kartu PO. */
export function AvailabilitySummaryBadge({ view }: { view: PoAvailabilityView | null }) {
  if (!view || view.mode !== 'REMOTE') return null;
  const s = view.summary;
  if (s.belum > 0) {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded border font-medium bg-red-50 text-red-700 border-red-200"
        title="Ada item yang belum diadakan vendor"
      >
        {s.belum} item belum diadakan
      </span>
    );
  }
  if (s.etaLewatKedatangan > 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border font-medium bg-amber-50 text-amber-800 border-amber-200">
        {s.etaLewatKedatangan} item ETA lewat kedatangan
      </span>
    );
  }
  if (s.diadakan > 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border font-medium bg-sky-50 text-sky-700 border-sky-200">
        {s.diadakan} item sedang diadakan
      </span>
    );
  }
  const active = s.total - s.dibatalkan;
  if (active > 0 && s.siap + s.terkirim === active) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded border font-medium bg-emerald-50 text-emerald-700 border-emerald-200">
        Semua item siap
      </span>
    );
  }
  return null;
}

/** Baris info + tombol Perbarui di atas tabel item. */
export function AvailabilityToolbar({
  view,
  loading,
  onRefresh,
  canRefresh,
}: {
  view: PoAvailabilityView | null;
  loading: boolean;
  onRefresh: () => void;
  canRefresh: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!view || view.mode !== 'REMOTE') return null;
  const notes = [...new Set(
    view.vendors.map((v) => VENDOR_STATE_NOTE[v.state]).filter((n): n is string => Boolean(n)),
  )];
  const s = view.summary;
  return (
    <div className="mb-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-xs no-print">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-slate-700">Status di vendor:</span>
        {s.siap > 0 && <span className="text-emerald-700">{s.siap} siap</span>}
        {s.diadakan > 0 && <span className="text-sky-700">{s.diadakan} diadakan</span>}
        {s.belum > 0 && <span className="font-medium text-red-700">{s.belum} belum diadakan</span>}
        {s.terkirim > 0 && <span className="text-slate-600">{s.terkirim} terkirim</span>}
        <span className="text-slate-400">{relativeTime(view.fetchedAt, now)}</span>
        {canRefresh && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ml-auto h-6 px-2 text-[10px]"
            disabled={loading}
            onClick={onRefresh}
            title="Tarik status terbaru dari vendor"
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Perbarui
          </Button>
        )}
      </div>
      {notes.map((n) => (
        <p key={n} className="mt-1 text-[10px] text-amber-700">{n}</p>
      ))}
    </div>
  );
}

function breakdown(it: PoItemAvailabilityView): string[] {
  const parts: string[] = [];
  if (it.qtyTerkirim > 0 && it.status !== 'TERKIRIM') parts.push(`terkirim ${formatNumber(it.qtyTerkirim)}`);
  if (it.qtySiap > 0 && it.status !== 'SIAP') parts.push(`siap ${formatNumber(it.qtySiap)}`);
  if (it.qtyDiadakan > 0 && it.status !== 'DIADAKAN') parts.push(`diadakan ${formatNumber(it.qtyDiadakan)}`);
  if (it.qtyBelum > 0 && it.status !== 'BELUM') parts.push(`belum ${formatNumber(it.qtyBelum)}`);
  return parts;
}

/** Sel status per item. */
export function AvailabilityCell({ item }: { item: PoItemAvailabilityView | undefined }) {
  if (!item) return <span className="text-slate-300">—</span>;
  const main = item.status === 'BELUM' ? item.qtyBelum
    : item.status === 'DIADAKAN' ? item.qtyDiadakan
      : item.status === 'SIAP' ? item.qtySiap : 0;
  const extra = breakdown(item);
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border font-medium ${STATUS_STYLE[item.status]}`}>
        {STATUS_LABEL[item.status]}
        {main > 0 && extra.length > 0 && ` ${formatNumber(main)}`}
      </span>
      {item.status === 'DIADAKAN' && item.etaDiadakan && (
        <span className={`text-[10px] ${item.etaLewatKedatangan ? 'text-amber-700 font-medium' : 'text-slate-500'}`}>
          ETA {formatDate(item.etaDiadakan)}
          {item.etaLewatKedatangan && ' (lewat kedatangan)'}
        </span>
      )}
      {item.menungguPersetujuan && (
        <span className="text-[10px] text-slate-500">menunggu persetujuan vendor</span>
      )}
      {extra.length > 0 && (
        <span className="text-[10px] text-slate-500">{extra.join(' · ')}</span>
      )}
    </div>
  );
}
