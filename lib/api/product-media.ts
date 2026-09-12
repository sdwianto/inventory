/** Persist detailProduk + fotos (max 5) for tenant products. */

import { storeBase64Image, storeImageBuffer } from '@/lib/api/media-storage';
import { resolveEffectiveSalesAppUrl } from '@/lib/api/sales-app-url';

export const MAX_PRODUCT_FOTOS = 5;
export const MAX_DETAIL_PRODUK_LEN = 4000;
export const PRODUCT_FOTO_MAX_BYTES = 400_000;

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
const FETCH_TIMEOUT_MS = 8_000;

export function normalizeDetailProduk(value: unknown): string | { error: string } {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  if (s.length > MAX_DETAIL_PRODUK_LEN) {
    return { error: `Detail produk maksimal ${MAX_DETAIL_PRODUK_LEN} karakter` };
  }
  return s;
}

export function publicAppOrigin(): string {
  return String(
    process.env.INVENTORY_APP_URL
    || process.env.NEXT_PUBLIC_BASE_URL
    || process.env.APP_URL
    || '',
  ).trim().replace(/\/$/, '');
}

export function absolutizeMediaUrl(url: string, origin = publicAppOrigin()): string {
  const s = String(url || '').trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/') && origin) return `${origin}${s}`;
  return s;
}

export function absolutizeMediaUrls(urls: string[], origin = publicAppOrigin()): string[] {
  return urls.map((u) => absolutizeMediaUrl(u, origin));
}

function inventoryMediaPrefix(tenantId: string): string {
  return `/api/media/${encodeURIComponent(String(tenantId || 'default').trim().toLowerCase())}/`;
}

function mimeFromUrlOrHeader(url: string, contentType: string | null): string {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct;
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

/**
 * Sales sering mengirim `/api/media/{vendorTenant}/…` (relatif) atau URL absolut Sales.
 * Browser di Inventory akan request ke :3001 → 404. Materialize ke storage lokal tenant customer.
 */
export async function materializeInboundProductFotos(
  tenantId: string,
  incoming: string[],
  opts: { salesAppUrl?: string | null } = {},
): Promise<string[]> {
  const tid = String(tenantId || 'default').trim().toLowerCase();
  const localPrefix = inventoryMediaPrefix(tid);
  const invOrigin = publicAppOrigin();
  const salesOrigin = resolveEffectiveSalesAppUrl(opts.salesAppUrl).replace(/\/$/, '');
  const out: string[] = [];

  for (const raw of incoming.slice(0, MAX_PRODUCT_FOTOS)) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (s.startsWith(localPrefix)) {
      out.push(s);
      continue;
    }
    if (invOrigin && s.startsWith(`${invOrigin}${localPrefix}`)) {
      out.push(s.slice(invOrigin.length));
      continue;
    }

    let fetchUrl = s;
    if (s.startsWith('/api/media/')) {
      fetchUrl = `${salesOrigin}${s}`;
    } else if (!/^https?:\/\//i.test(s)) {
      out.push(s);
      continue;
    }

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(fetchUrl, { signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(timer);
      if (!res.ok) {
        // Fallback: tetap simpan absolut Sales supaya img lintas-origin bisa render.
        out.push(/^https?:\/\//i.test(s) ? s : fetchUrl);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const stored = await storeImageBuffer(tid, buf, {
        prefix: 'produk',
        maxBytes: PRODUCT_FOTO_MAX_BYTES,
        mime: mimeFromUrlOrHeader(fetchUrl, res.headers.get('content-type')),
      });
      if ('error' in stored) {
        out.push(/^https?:\/\//i.test(s) ? s : fetchUrl);
        continue;
      }
      out.push(stored.url);
    } catch {
      out.push(/^https?:\/\//i.test(s) ? s : `${salesOrigin}${s.startsWith('/') ? s : `/${s}`}`);
    }
  }

  return out;
}

export async function persistProductFotos(
  tenantId: string,
  incoming: unknown,
): Promise<string[] | { error: string }> {
  if (incoming === undefined || incoming === null) return [];
  if (!Array.isArray(incoming)) return { error: 'Format foto tidak valid' };
  if (incoming.length > MAX_PRODUCT_FOTOS) {
    return { error: `Maksimal ${MAX_PRODUCT_FOTOS} foto` };
  }

  const out: string[] = [];
  for (let i = 0; i < incoming.length; i++) {
    const s = String(incoming[i] || '').trim();
    if (!s) continue;
    if (s.startsWith('/api/media/') || /^https?:\/\//i.test(s)) {
      out.push(s);
      continue;
    }
    if (!DATA_URL_RE.test(s)) {
      return { error: `Foto ${i + 1} harus URL media atau gambar base64` };
    }
    const stored = await storeBase64Image(tenantId, s, {
      prefix: 'produk',
      maxBytes: PRODUCT_FOTO_MAX_BYTES,
    });
    if ('error' in stored) return { error: stored.error };
    out.push(stored.url);
  }
  return out;
}
