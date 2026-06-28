export async function postBulkDelete(
  endpoint: string,
  ids: string[],
): Promise<{ deleted?: number; error?: string; [key: string]: unknown }> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json() as { deleted?: number; error?: string };
  if (!res.ok) throw new Error(data.error || 'Gagal hapus');
  return data;
}
