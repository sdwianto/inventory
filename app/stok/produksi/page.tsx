import { redirect } from 'next/navigation';

/** Halaman warisan sales.app — tidak dipakai di inventory customer. */
export default function ProduksiRedirectPage() {
  redirect('/dashboard');
}
