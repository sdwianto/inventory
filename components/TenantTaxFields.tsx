'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TenantTaxForm } from '@/lib/tenant-tax-form';

export function TenantTaxFields({ value, onChange }: { value: TenantTaxForm; onChange: (v: TenantTaxForm) => void }) {
  return (
    <div className="rounded border p-3 space-y-2">
      <Label>Status Pajak (Pembeli)</Label>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={value.pkp} onChange={(e) => onChange({ ...value, pkp: e.target.checked })} />
        Tenant PKP — PPN dari vendor dikreditkan sebagai PPN Masukan
      </label>
      {value.pkp && (
        <div className="max-w-xs">
          <Label>PKP sejak (opsional)</Label>
          <Input type="date" value={value.pkpSejak} onChange={(e) => onChange({ ...value, pkpSejak: e.target.value })} />
        </div>
      )}
      <p className="text-xs text-slate-500">
        Tarif PPN ditentukan vendor per invoice. Non-PKP: PPN ikut menjadi nilai barang (tidak dikreditkan).
        PKP wajib NPWP 15/16 digit. Perubahan hanya berlaku untuk tagihan vendor yang diterima sesudahnya.
      </p>
    </div>
  );
}
