import { redirect } from 'next/navigation';

/** URL lama Sprint 1 — Personel adalah master bersama, bukan Food Production. */
export default function LegacyKitchenPeopleRedirect() {
  redirect('/people');
}
