import { redirect } from 'next/navigation';

/** Halaman warisan sales.app (printer struk kasir) — tidak dipakai di inventory customer. */
export default function PrinterRedirectPage() {
  redirect('/dashboard');
}
