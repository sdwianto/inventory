import { redirect } from 'next/navigation';

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Digabung ke Pengeluaran Stok — Mode Produksi. */
export default async function FoodProductionIssueRedirectPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams> | SearchParams;
}) {
  const sp = await Promise.resolve(searchParams);
  const qs = new URLSearchParams();
  qs.set('mode', 'produksi');
  const planId = first(sp.productionPlanId);
  const mrpId = first(sp.materialRequirementId);
  if (planId) qs.set('productionPlanId', planId);
  if (mrpId) qs.set('materialRequirementId', mrpId);
  redirect(`/stok/pengeluaran?${qs.toString()}`);
}
