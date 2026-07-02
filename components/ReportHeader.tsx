'use client';

import type { ReactNode } from 'react';
import { useTenantSettings } from '@/lib/tenant-client';
import { formatDate, formatDateTime } from '@/lib/format';

interface ReportHeaderProps {
  title: string;
  from?: string | Date | null;
  to?: string | Date | null;
  asOf?: string | Date | null;
  extraInfo?: ReactNode;
}

export default function ReportHeader({ title, from, to, asOf, extraInfo }: ReportHeaderProps) {
  const settings = useTenantSettings();
  const company = settings?.companyName || 'TOKO BAROKAH';
  const address = settings?.companyAddress || '';
  const phone = settings?.companyPhone || '';
  const npwp = settings?.companyNPWP || '';
  const logo = settings?.logoUrl || settings?.logoBase64 || '';

  return (
    <div className="report-header border-b pb-3 mb-4">
      <div className="flex items-center gap-4">
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="logo" className="h-14 w-14 object-contain flex-shrink-0" />
        )}
        <div className="flex-1">
          <div className="text-lg font-bold leading-tight">{company}</div>
          {address && <div className="text-xs text-slate-600">{address}</div>}
          {(phone || npwp) && (
            <div className="text-xs text-slate-600">
              {phone && <span>Telp: {phone}</span>}
              {phone && npwp && <span> • </span>}
              {npwp && <span>NPWP: {npwp}</span>}
            </div>
          )}
        </div>
        <div className="text-right text-xs text-slate-500">
          <div>Dicetak: {formatDateTime(new Date())}</div>
        </div>
      </div>
      <div className="mt-3 text-center">
        <div className="text-lg font-bold uppercase">{title}</div>
        {from && to && <div className="text-sm text-slate-600">Periode: {formatDate(from)} s/d {formatDate(to)}</div>}
        {asOf && <div className="text-sm text-slate-600">Per tanggal: {formatDate(asOf)}</div>}
        {extraInfo && <div className="text-xs text-slate-500">{extraInfo}</div>}
      </div>
    </div>
  );
}
