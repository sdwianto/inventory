import type { HandlerContext } from '@/types/api/handler';
// Laporan PPN Masukan per masa (GET /api/ppn-masukan?masa=YYYY-MM).

import { err, ok } from '@/lib/api/db';
import { requireRole } from '@/lib/api/require-auth';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { loadTenantTax } from '@/lib/api/tenant-tax';
import { loadPpnMasukan } from '@/lib/api/ppn-masukan';

const REPORT_ROLES = ['ADMIN', 'MASTER'];

export async function handlePpnMasukan({ db, route, method, url, auth, request }: HandlerContext) {
  if (route !== '/ppn-masukan' || method !== 'GET') return null;

  const deniedRole = requireRole(auth, REPORT_ROLES);
  if (deniedRole) return deniedRole;

  const { denied, tenantId } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;
  if (!tenantId) return err('Pilih tenant terlebih dahulu', 400);

  const masa = String(url.searchParams.get('masa') || '').trim();
  const [report, tax] = await Promise.all([
    loadPpnMasukan(db, tenantId, masa),
    loadTenantTax(db, tenantId),
  ]);
  if (!report) return err('Parameter masa wajib format YYYY-MM', 400);

  return ok({ masa, tax, ...report });
}
