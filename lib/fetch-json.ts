/** Fetch JSON dengan error message yang konsisten untuk UI. Default 15s timeout (Fase C). */

const DEFAULT_TIMEOUT_MS = 15_000;

function withDefaultSignal(options: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): RequestInit {
  if (options.signal) return options;
  return { ...options, signal: AbortSignal.timeout(timeoutMs) };
}

export async function fetchJson<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, withDefaultSignal(options));
  let data: { error?: string } | null = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Permintaan gagal (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data as T;
}
