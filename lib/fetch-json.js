/** Fetch JSON dengan error message yang konsisten untuk UI. */
export async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Permintaan gagal (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data;
}
