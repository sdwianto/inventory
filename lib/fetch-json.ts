/** Fetch JSON dengan error message yang konsisten untuk UI. Default 15s timeout (Fase C). */

const DEFAULT_TIMEOUT_MS = 15_000;

function withDefaultSignal(options: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): RequestInit {
  if (options.signal) return options;
  return { ...options, signal: AbortSignal.timeout(timeoutMs) };
}

/**
 * Respons 2xx yang body-nya terputus/bukan JSON dilempar sebagai error — jangan pernah
 * dikembalikan sebagai `null` sukses (React Query akan meng-cache & mem-persist-nya).
 * Body kosong (mis. 204) tetap `null`.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, withDefaultSignal(options));
  if (!res.ok) {
    let data: { error?: string } | null = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    const msg = (data && data.error) || `Permintaan gagal (HTTP ${res.status})`;
    throw new Error(msg);
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new Error('Koneksi terputus saat memuat data — coba lagi');
  }
  if (!text.trim()) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Respons server tidak valid — coba lagi');
  }
}
