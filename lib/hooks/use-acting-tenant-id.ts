'use client';

import { useEffect, useState } from 'react';
import { getActingTenantId } from '@/lib/acting-tenant-client';

/** Subscribe ke tenant operasional MASTER (localStorage + erp-scope-change). */
export function useActingTenantId(): string {
  const [tenantId, setTenantId] = useState(() => getActingTenantId());

  useEffect(() => {
    const refresh = () => setTenantId(getActingTenantId());
    refresh();
    window.addEventListener('erp-scope-change', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('erp-scope-change', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return tenantId;
}
