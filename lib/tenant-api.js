'use client';

/** Query `tenantId` untuk API saat user MASTER memilih tenant aktif. */
export function withActingTenantQuery(path, tenantId, isMaster) {
  if (!isMaster || !tenantId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}tenantId=${encodeURIComponent(tenantId)}`;
}
