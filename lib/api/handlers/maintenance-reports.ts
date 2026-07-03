import type { NextResponse } from 'next/server';
import { ok } from '@/lib/api/db';
import { resolveOperationalScope } from '@/lib/api/tenant-master';
import { requireRole } from '@/lib/api/require-auth';
import { fetchMaintenanceReport } from '@/lib/api/maintenance-reports';
import type { HandlerContext } from '@/types/api/handler';

export async function handleMaintenanceReports({
  db,
  route,
  method,
  url,
  auth,
  request,
}: HandlerContext): Promise<NextResponse | null> {
  if (route !== '/maintenance-reports' || method !== 'GET') return null;

  // Laporan maintenance selaras menu UI: SUPERVISOR/ADMIN/OWNER/MASTER (GUDANG ditolak).
  const roleDenied = requireRole(auth, ['SUPERVISOR', 'ADMIN']);
  if (roleDenied) return roleDenied;

  const { denied, scopeAuth } = resolveOperationalScope(auth, { url, request });
  if (denied) return denied;
  if (!scopeAuth) return null;

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const assetId = url.searchParams.get('assetId');

  const report = await fetchMaintenanceReport(db, scopeAuth, { from, to, assetId });
  return ok(report);
}
