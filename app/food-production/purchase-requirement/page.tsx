import { redirect } from 'next/navigation';

/** Digabung ke alur Rencana Produksi → PO ke Vendor. */
export default function PurchaseRequirementRedirectPage() {
  redirect('/pembelian-po');
}
