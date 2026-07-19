import { redirect } from 'next/navigation';

/** Kalender digabung ke Rencana Produksi (pola PO ke Vendor). */
export default function ProductionCalendarRedirectPage() {
  redirect('/food-production/plan');
}
