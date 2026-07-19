import { redirect } from 'next/navigation';

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Digabung ke Pengeluaran Stok — Mode Operasional. */
export default async function ReleaseInventoryRedirectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams> | SearchParams;
}) {
  const sp = await Promise.resolve(searchParams);
  const qs = new URLSearchParams();
  qs.set('mode', 'operasional');
  const wrId = first(sp.wrId);
  if (wrId) qs.set('wrId', wrId);
  redirect(`/stok/pengeluaran?${qs.toString()}`);
}
