/**
 * Halaman daftar crash "Cannot read properties of null (reading 'items')": respons 2xx yang
 * body-nya terputus dulu dikembalikan fetchJson sebagai null sukses, lalu di-cache & dipersist
 * ke IndexedDB sehingga crash berulang tiap reload.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson } from '@/lib/fetch-json';
import { toCursorPage } from '@/lib/cursor-prefetch-cache';
import { isPersistableData, persistBuster, PERSIST_CACHE_VERSION } from '@/lib/query-persist';

function stubFetch(res: Response | (() => Response)) {
  vi.stubGlobal('fetch', vi.fn(async () => (typeof res === 'function' ? res() : res)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchJson', () => {
  it('mengembalikan JSON pada 2xx', async () => {
    stubFetch(new Response(JSON.stringify({ items: [1] }), { status: 200 }));
    await expect(fetchJson('/api/x')).resolves.toEqual({ items: [1] });
  });

  it('body kosong / 204 → null', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(fetchJson('/api/x')).resolves.toBeNull();
    stubFetch(new Response('', { status: 200 }));
    await expect(fetchJson('/api/x')).resolves.toBeNull();
  });

  it('body terputus saat dibaca → error, bukan null sukses', async () => {
    stubFetch(() => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"items":[{"id":'));
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        },
      });
      return new Response(body, { status: 200 });
    });
    await expect(fetchJson('/api/x')).rejects.toThrow(/Koneksi terputus/);
  });

  it('2xx bukan JSON (mis. HTML) → error', async () => {
    stubFetch(new Response('<html>login</html>', { status: 200 }));
    await expect(fetchJson('/api/x')).rejects.toThrow(/tidak valid/);
  });

  it('non-2xx memakai pesan error server, atau fallback HTTP status', async () => {
    stubFetch(new Response(JSON.stringify({ error: 'Tidak boleh' }), { status: 403 }));
    await expect(fetchJson('/api/x')).rejects.toThrow('Tidak boleh');
    stubFetch(new Response('Bad gateway', { status: 502 }));
    await expect(fetchJson('/api/x')).rejects.toThrow('Permintaan gagal (HTTP 502)');
  });
});

describe('toCursorPage', () => {
  it('objek dipakai apa adanya; array dibungkus jadi items', () => {
    expect(toCursorPage({ items: [1], hasMore: true, nextCursor: 'c' })).toEqual({ items: [1], hasMore: true, nextCursor: 'c' });
    expect(toCursorPage([1, 2])).toEqual({ items: [1, 2], hasMore: false, nextCursor: null });
  });

  it('null / primitif → error (tidak masuk cache)', () => {
    expect(() => toCursorPage(null)).toThrow(/tidak valid/);
    expect(() => toCursorPage(undefined)).toThrow();
    expect(() => toCursorPage('x')).toThrow();
  });
});

describe('persist cache', () => {
  it('infinite data dengan halaman null tidak dipersist', () => {
    expect(isPersistableData({ pages: [{ items: [] }, null], pageParams: [null, 'c'] })).toBe(false);
    expect(isPersistableData({ pages: [{ items: [] }], pageParams: [null] })).toBe(true);
    expect(isPersistableData({ pages: 'x' })).toBe(false);
  });

  it('data biasa dipersist, null/undefined tidak', () => {
    expect(isPersistableData({ total: 1 })).toBe(true);
    expect(isPersistableData([1, 2])).toBe(true);
    expect(isPersistableData(null)).toBe(false);
    expect(isPersistableData(undefined)).toBe(false);
  });

  it('buster memuat versi cache agar cache lama di semua browser terbuang', () => {
    expect(persistBuster().startsWith(`${PERSIST_CACHE_VERSION}:`)).toBe(true);
  });
});
