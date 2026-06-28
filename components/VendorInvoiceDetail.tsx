'use client';

import type { JsonObject } from '@/types/json';
import { str } from '@/types/json';
import { useState } from 'react';
import VendorInvoiceDocument from '@/components/VendorInvoiceDocument';
import VendorInvoiceThermal from '@/components/VendorInvoiceThermal';
import PrintPortal, { printReceipt } from '@/components/PrintPortal';
import { Button } from '@/components/ui/button';
import { printDocument } from '@/lib/doc-print';
import { Check, Loader2, Printer, Receipt, X } from 'lucide-react';

const PRINT_ID = 'vendor-invoice-a4-print';

export default function VendorInvoiceDetail({
  detail,
  acting = '',
  overrideMatch = false,
  onOverrideMatchChange,
  onApprove,
  onReject,
  onMarkPaid,
}: {
  detail: JsonObject | null;
  acting?: string;
  overrideMatch?: boolean;
  onOverrideMatchChange?: (v: boolean) => void;
  onApprove?: () => void;
  onReject?: () => void;
  onMarkPaid?: () => void;
}) {
  const [printing, setPrinting] = useState(false);
  const [thermalPrint, setThermalPrint] = useState(false);
  const [a4Print, setA4Print] = useState(false);

  if (!detail) return null;

  const approval = str(detail.approvalStatus || detail.status);
  const markingPaid = typeof acting === 'string' && acting.startsWith('paid');

  const handlePrintA4 = async () => {
    setPrinting(true);
    setA4Print(true);
    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250)));
      await printDocument(PRINT_ID);
    } finally {
      setA4Print(false);
      setPrinting(false);
    }
  };

  const handlePrintThermal = async () => {
    setPrinting(true);
    setThermalPrint(true);
    try {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 200)));
      await printReceipt(450);
    } finally {
      setThermalPrint(false);
      setPrinting(false);
    }
  };

  return (
    <div className="text-sm">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b bg-white/95 backdrop-blur px-4 py-3 no-print">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">Tagihan vendor</p>
          <p className="font-mono font-semibold text-orange-600 truncate">{str(detail.noInvoice)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={printing} onClick={handlePrintThermal}>
            {printing && thermalPrint ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Receipt className="w-4 h-4 mr-1" />}
            Thermal
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={printing} onClick={handlePrintA4}>
            {printing && !thermalPrint ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Printer className="w-4 h-4 mr-1" />}
            A4
          </Button>
        </div>
      </div>

      <div className="px-4 py-4 md:px-6">
        {detail.matchStatus === 'EXCEPTION' && (
          <div className="p-3 mb-4 bg-amber-50 border border-amber-200 rounded text-amber-900 text-xs no-print">
            {str(detail.matchError, '3-way match exception')}
            {approval === 'PENDING_REVIEW' && onOverrideMatchChange && (
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overrideMatch}
                  onChange={(e) => onOverrideMatchChange(e.target.checked)}
                />
                Setujui dengan override (sudah diverifikasi manual)
              </label>
            )}
          </div>
        )}

        <VendorInvoiceDocument detail={detail} className="mx-auto" />

        <div className="flex flex-wrap gap-2 pt-4 mt-4 border-t no-print justify-end">
          {approval === 'PENDING_REVIEW' && (
            <>
              <Button onClick={onApprove} disabled={acting === 'approve'} className="bg-green-600 hover:bg-green-700">
                <Check className="w-4 h-4 mr-1" />
                {acting === 'approve' ? '...' : 'Setujui'}
              </Button>
              <Button variant="outline" onClick={onReject} disabled={acting === 'reject'}>
                <X className="w-4 h-4 mr-1" /> Tolak
              </Button>
            </>
          )}
          {approval === 'APPROVED' && (
            <Button variant="outline" onClick={onMarkPaid} disabled={markingPaid}>
              {markingPaid ? '...' : 'Tandai lunas (bayar luar sistem)'}
            </Button>
          )}
        </div>
      </div>

      {thermalPrint && (
        <PrintPortal>
          <VendorInvoiceThermal detail={detail} />
        </PrintPortal>
      )}

      {a4Print && (
        <PrintPortal>
          <div className="doc-print-host">
            <VendorInvoiceDocument detail={detail} printId={PRINT_ID} />
          </div>
        </PrintPortal>
      )}
    </div>
  );
}
