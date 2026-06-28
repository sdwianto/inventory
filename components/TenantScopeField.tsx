'use client';

import { Label } from '@/components/ui/label';
import type { SessionUser } from '@/types/auth';

export interface TenantOption {
  tenantId: string;
  companyName?: string;
  tenantName?: string;
}

interface TenantScopeFieldProps {
  user: SessionUser | null;
  tenants?: TenantOption[];
  value: string;
  onChange: (tenantId: string) => void;
  required?: boolean;
  label?: string;
  className?: string;
}

/**
 * MASTER: dropdown tenant aktif.
 * Non-master: field disabled menampilkan nama tenant sendiri.
 */
export default function TenantScopeField({
  user,
  tenants = [],
  value,
  onChange,
  required = false,
  label = 'Tenant',
  className = '',
}: TenantScopeFieldProps) {
  const isMaster = user?.role === 'MASTER';
  const displayName =
    tenants.find((t) => t.tenantId === (user?.tenantId || 'default'))?.companyName
    || tenants.find((t) => t.tenantId === (user?.tenantId || 'default'))?.tenantName
    || user?.tenantName
    || user?.tenantId
    || 'default';

  if (!isMaster) {
    return (
      <div className={className}>
        <Label>{label}</Label>
        <input
          type="text"
          readOnly
          disabled
          value={displayName}
          className="mt-1 flex h-9 w-full rounded-md border border-input bg-slate-50 px-3 py-1 text-sm text-slate-700 cursor-not-allowed"
        />
      </div>
    );
  }

  const options = tenants.filter((t) => t.tenantId && t.tenantId !== 'master');

  return (
    <div className={className}>
      <Label>
        {label}
        {required ? ' *' : ''}
      </Label>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      >
        <option value="">— Pilih tenant —</option>
        {options.map((t) => (
          <option key={t.tenantId} value={t.tenantId}>
            {t.companyName || t.tenantName || t.tenantId}
            {' '}
            (
            {t.tenantId}
            )
          </option>
        ))}
      </select>
    </div>
  );
}

export function tenantLabel(tenants: TenantOption[], tenantId: string | null | undefined): string {
  const t = tenants.find((x) => x.tenantId === tenantId);
  return t?.companyName || t?.tenantName || tenantId || '-';
}
