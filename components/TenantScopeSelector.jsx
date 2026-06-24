'use client';

import { useEffect, useState } from 'react';
import { Building2, ChevronDown } from 'lucide-react';
import { getUser } from '@/lib/auth-client';
import {
  getActingTenantId,
  setActingTenantId,
  setActingTenantIdLocal,
  syncActingTenantToServer,
} from '@/lib/acting-tenant-client';

/** Pemilih tenant operasional untuk role MASTER. */
export default function TenantScopeSelector({ className = '' }) {
  const [user, setUser] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const u = getUser();
    setUser(u);
    if (u?.role !== 'MASTER') return undefined;

    const init = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/tenants', { credentials: 'include' });
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        setTenants(list);

        let acting = getActingTenantId() || u.actingTenantId || '';
        if (!acting && u.actingTenantId) {
          acting = u.actingTenantId;
          setActingTenantIdLocal(acting);
        }
        if (!acting && list.length > 0) {
          acting = list[0].tenantId;
          await setActingTenantId(acting);
        } else if (acting && !getActingTenantId()) {
          setActingTenantIdLocal(acting);
          await syncActingTenantToServer(acting);
        }
        setSelected(acting);
      } catch {
        setTenants([]);
      }
      setLoading(false);
    };

    init();
    const onScope = () => setSelected(getActingTenantId());
    window.addEventListener('erp-scope-change', onScope);
    return () => window.removeEventListener('erp-scope-change', onScope);
  }, []);

  if (!user || user.role !== 'MASTER') return null;

  const onChange = async (e) => {
    const tid = e.target.value;
    setSelected(tid);
    await setActingTenantId(tid);
  };

  const label = tenants.find((t) => t.tenantId === selected)?.companyName
    || tenants.find((t) => t.tenantId === selected)?.tenantName
    || selected
    || 'Pilih tenant…';

  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <Building2 className="w-4 h-4 text-bgn-gold shrink-0" />
      <span className="text-xs text-slate-400 hidden sm:inline shrink-0">Tenant aktif</span>
      <div className="relative min-w-0 flex-1 max-w-[220px]">
        <select
          value={selected}
          onChange={onChange}
          disabled={loading || tenants.length === 0}
          className="w-full appearance-none bg-bgn-navy-light border border-slate-600 text-slate-100 text-sm rounded-md pl-3 pr-8 py-1.5 truncate focus:outline-none focus:ring-1 focus:ring-bgn-gold"
          title={label}
        >
          {tenants.length === 0 ? (
            <option value="">Belum ada tenant</option>
          ) : (
            tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.companyName || t.tenantName || t.tenantId}
              </option>
            ))
          )}
        </select>
        <ChevronDown className="w-3.5 h-3.5 text-slate-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
      </div>
    </div>
  );
}
