import { redirect } from 'next/navigation';

/** Digabung ke alur Rencana Produksi → Ambil Bahan / PO ke Vendor. */
export default function MrpRedirectPage() {
  redirect('/food-production/plan');
}
