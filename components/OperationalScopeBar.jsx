'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Building2, MapPin } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import { getActingTenantId } from '@/lib/acting-tenant-client';
import { fetchTenantSettings } from '@/lib/tenant-client';
import { getLokasiAktif, loadLokasiForTenant } from '@/lib/lokasi-client';

/** Banner tenant + lokasi gudang aktif — sinkron dengan header AppShell. */
export default function OperationalScopeBar({ className = '' }) {
  const [tenantLabel, setTenantLabel] = useState('');
  const [lokasiLabel, setLokasiLabel] = useState('');

  useEffect(() => {
    const refresh = async () => {
      const u = getUser();
      if (!u) return;
      const isMaster = u.role === 'MASTER';
      const scopeId = isMaster ? getActingTenantId() : (u.tenantId || 'default');
      if (isMaster && !scopeId) {
        setTenantLabel('');
        setLokasiLabel('');
        return;
      }
      const settings = await fetchTenantSettings(scopeId, { bustCache: false }).catch(() => null);
      setTenantLabel(settings?.companyName || settings?.tenantName || u.tenantName || scopeId);
      const lok = await loadLokasiForTenant(scopeId, {
        actingTenantId: isMaster ? scopeId : undefined,
        isMaster,
      });
      setLokasiLabel(lok.lokasiAktif || getLokasiAktif(scopeId) || '');
    };
    refresh();
    window.addEventListener('erp-scope-change', refresh);
    return () => window.removeEventListener('erp-scope-change', refresh);
  }, []);

  if (!tenantLabel && !lokasiLabel) return null;

  return (
    <Card className={`bg-orange-50 border-orange-200 ${className}`}>
      <CardContent className="p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        {tenantLabel ? (
          <span className="flex items-center gap-1.5">
            <Building2 className="w-4 h-4 text-orange-600 shrink-0" />
            <span className="text-slate-500">Tenant:</span>
            <span className="font-semibold text-slate-800">{tenantLabel}</span>
          </span>
        ) : null}
        {lokasiLabel ? (
          <span className="flex items-center gap-1.5">
            <MapPin className="w-4 h-4 text-orange-600 shrink-0" />
            <span className="text-slate-500">Lokasi:</span>
            <span className="font-semibold text-slate-800">{lokasiLabel}</span>
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}
