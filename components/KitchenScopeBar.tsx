'use client';

import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { actingTenantHeaders } from '@/lib/acting-tenant-client';
import {
  getActingKitchenId,
  setActingKitchenId,
} from '@/lib/acting-kitchen-client';

interface KitchenOpt {
  id: string;
  nama: string;
  kode?: string;
  kitchenType?: string;
}

/** Filter scope dapur untuk halaman Food Production (Multi-Kitchen). */
export default function KitchenScopeBar() {
  const [kitchens, setKitchens] = useState<KitchenOpt[]>([]);
  const [kitchenId, setKitchenId] = useState('');

  useEffect(() => {
    setKitchenId(getActingKitchenId());
    void (async () => {
      try {
        const res = await fetch('/api/kitchens?aktif=1', {
          headers: { ...actingTenantHeaders() },
        });
        const data = await res.json();
        if (res.ok && Array.isArray(data)) setKitchens(data);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <div className="space-y-1">
        <Label className="text-xs">Filter dapur</Label>
        <select
          className="h-9 border rounded-md px-2 text-sm bg-white min-w-[14rem]"
          value={kitchenId}
          onChange={(e) => {
            const v = e.target.value;
            setKitchenId(v);
            setActingKitchenId(v || null);
            window.dispatchEvent(new Event('fp-kitchen-changed'));
          }}
        >
          <option value="">Semua dapur</option>
          {kitchens.map((k) => (
            <option key={k.id} value={k.id}>
              {k.kode ? `${k.kode} · ` : ''}{k.nama}
              {k.kitchenType === 'CENTRAL' ? ' (Central)' : ''}
            </option>
          ))}
        </select>
      </div>
      <p className="text-[11px] text-muted-foreground pb-2">
        Berlaku untuk Plan / Issue / Result / Titik / Distribusi / Kalender / Batch / Rekomendasi
      </p>
    </div>
  );
}
