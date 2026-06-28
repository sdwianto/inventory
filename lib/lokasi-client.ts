'use client';

import { getUser } from '@/lib/auth-client';
import type { LokasiItem } from '@/types/client';

const keyFor = (tenantId: string | null | undefined) => `inventory_lokasi_aktif_${tenantId || 'default'}`;
const legacyKeyFor = (tenantId: string | null | undefined) => `kasir_lokasi_aktif_${tenantId || 'default'}`;

export interface LokasiCache {
  tenantId: string;
  list: LokasiItem[];
  lokasiAktif: string;
}

type LokasiInput = LokasiItem | string | null | undefined;

let _lokasiCache: LokasiCache | null = null;
let _lokasiPromise: Promise<LokasiCache> | null = null;

/** Label lokasi untuk transaksi: "L236 - Gudang Zulmy" */
export function formatLokasiLabel(lok: LokasiInput): string {
  if (!lok) return '';
  if (typeof lok === 'string') return lok;
  return `${lok.kode} - ${lok.nama}`;
}

/** Tampilan dropdown: kode, nama, keterangan tenant/gudang */
export function formatLokasiOption(lok: LokasiInput): string {
  const base = formatLokasiLabel(lok);
  if (!lok || typeof lok === 'string') return base;
  return lok.keterangan ? `${base} (${lok.keterangan})` : base;
}

function resolveLokasiAktif(tenantId: string, list: LokasiItem[]): string {
  const labels = list.map((l) => formatLokasiLabel(l));
  let aktif = getLokasiAktif(tenantId);
  if (aktif && labels.includes(aktif)) return aktif;
  if (list.length > 0) {
    aktif = formatLokasiLabel(list[0]);
    setLokasiAktif(tenantId, aktif);
    return aktif;
  }
  if (aktif) setLokasiAktif(tenantId, '');
  return '';
}

export function getLokasiAktif(tenantId: string | null | undefined): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(keyFor(tenantId))
      || localStorage.getItem(legacyKeyFor(tenantId))
      || '';
  } catch {
    return '';
  }
}

export function setLokasiAktif(tenantId: string | null | undefined, label: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (label) localStorage.setItem(keyFor(tenantId), label);
    else localStorage.removeItem(keyFor(tenantId));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('erp-scope-change'));
}

export function invalidateLokasiCache(): void {
  _lokasiCache = null;
  _lokasiPromise = null;
}

interface LoadLokasiOptions {
  actingTenantId?: string;
  isMaster?: boolean;
  bustCache?: boolean;
}

/** Muat daftar lokasi tenant + set default aktif jika belum ada. */
export async function loadLokasiForTenant(
  tenantId?: string,
  { actingTenantId, isMaster, bustCache = false }: LoadLokasiOptions = {},
): Promise<LokasiCache> {
  const tid = tenantId || getUser()?.tenantId || 'default';
  if (!bustCache && _lokasiCache?.tenantId === tid) {
    return _lokasiCache;
  }
  if (_lokasiPromise && !bustCache) return _lokasiPromise;

  let url = '/api/lokasi';
  if (isMaster && actingTenantId) {
    url += `?tenantId=${encodeURIComponent(actingTenantId)}`;
  }

  _lokasiPromise = fetch(url)
    .then((res) => res.json())
    .then((list: unknown) => {
      const arr = Array.isArray(list) ? list as LokasiItem[] : [];
      const aktif = resolveLokasiAktif(tid, arr);
      _lokasiCache = { tenantId: tid, list: arr, lokasiAktif: aktif };
      _lokasiPromise = null;
      return _lokasiCache;
    })
    .catch(() => {
      _lokasiPromise = null;
      return { tenantId: tid, list: [], lokasiAktif: getLokasiAktif(tid) };
    });

  return _lokasiPromise;
}
