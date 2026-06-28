'use client';

/** Query `tenantId` untuk API saat user MASTER memilih tenant aktif. */
export function withActingTenantQuery(
  path: string,
  tenantId: string | null | undefined,
  isMaster: boolean,
): string {
  if (!isMaster || !tenantId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}
