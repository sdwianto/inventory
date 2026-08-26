'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Building2 } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { fetchTenantSettings } from '@/lib/tenant-client';

interface OperationalScopeBarProps {
  className?: string;
}

/** Banner tenant operasional (lokasi gudang tidak ditampilkan — dipilih per transaksi). */
export default function OperationalScopeBar({ className = '' }: OperationalScopeBarProps) {
  const [tenantLabel, setTenantLabel] = useState('');

  useEffect(() => {
    const refresh = async () => {
      const u = getUser();
      if (!u) return;
      const isMaster = u.role === 'MASTER';
      const scopeId = isMaster ? getActingTenantId() : (u.tenantId || 'default');
      if (isMaster && !scopeId) {
        setTenantLabel('');
        return;
      }
      const settings = await fetchTenantSettings(scopeId, { bustCache: false }).catch(() => null);
      setTenantLabel(settings?.companyName || settings?.tenantName || u.tenantName || scopeId);
    };
    refresh();
    window.addEventListener('erp-scope-change', refresh);
    return () => window.removeEventListener('erp-scope-change', refresh);
  }, []);

  if (!tenantLabel) return null;

  return (
    <Card className={`bg-orange-50 border-orange-200 min-w-0 max-w-full ${className}`}>
      <CardContent className="p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm min-w-0">
        <span className="flex items-center gap-1.5 min-w-0 max-w-full">
          <Building2 className="w-4 h-4 text-orange-600 shrink-0" />
          <span className="text-slate-500 shrink-0">Tenant:</span>
          <span className="font-semibold text-slate-800 truncate">{tenantLabel}</span>
        </span>
      </CardContent>
    </Card>
  );
}
