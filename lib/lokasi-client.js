'use client';

import { getUser } from '@/lib/auth-client';

const keyFor = (tenantId) => `inventory_lokasi_aktif_${tenantId || 'default'}`;
const legacyKeyFor = (tenantId) => `kasir_lokasi_aktif_${tenantId || 'default'}`;

let _lokasiCache = null;
let _lokasiPromise = null;

/** Label lokasi untuk transaksi: "L236 - Gudang Zulmy" */
export function formatLokasiLabel(lok) {
  if (!lok) return '';
  if (typeof lok === 'string') return lok;
  return `${lok.kode} - ${lok.nama}`;
}

/** Tampilan dropdown: kode, nama, keterangan tenant/gudang */
export function formatLokasiOption(lok) {
  const base = formatLokasiLabel(lok);
  if (!lok || typeof lok === 'string') return base;
  return lok.keterangan ? `${base} (${lok.keterangan})` : base;
}

function resolveLokasiAktif(tenantId, list) {
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

export function getLokasiAktif(tenantId) {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(keyFor(tenantId))
      || localStorage.getItem(legacyKeyFor(tenantId))
      || '';
  } catch {
    return '';
  }
}

export function setLokasiAktif(tenantId, label) {
  if (typeof window === 'undefined') return;
  try {
    if (label) localStorage.setItem(keyFor(tenantId), label);
    else localStorage.removeItem(keyFor(tenantId));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent('erp-scope-change'));
}

export function invalidateLokasiCache() {
  _lokasiCache = null;
  _lokasiPromise = null;
}

/** Muat daftar lokasi tenant + set default aktif jika belum ada. */
export async function loadLokasiForTenant(tenantId, { actingTenantId, isMaster, bustCache = false } = {}) {
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
    .then((list) => {
      const arr = Array.isArray(list) ? list : [];
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
