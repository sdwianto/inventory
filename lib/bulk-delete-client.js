/** @param {string} endpoint @param {string[]} ids */
export async function postBulkDelete(endpoint, ids) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Gagal hapus');
  return data;
}
