'use client';

import type { JsonObject } from '@/types/json';
import { str, asArray } from '@/types/json';
import { useState } from 'react';
import VendorInvoiceDocument from '@/components/VendorInvoiceDocument';
import VendorInvoiceThermal from '@/components/VendorInvoiceThermal';
import PrintPortal, { printReceipt } from '@/components/PrintPortal';
import { Button } from '@/components/ui/button';
import { printDocument } from '@/lib/doc-print';
import { Check, Loader2, Printer, Receipt, Undo2, X } from 'lucide-react';
import Link from 'next/link';

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

        {asArray(detail.creditNotes).length > 0 && (
          <div className="mt-4 border rounded p-3 no-print">
            <p className="text-xs font-semibold uppercase text-slate-500 mb-2">Credit note / retur</p>
            <ul className="space-y-1 text-xs">
              {asArray(detail.creditNotes).map((raw, i) => {
                const cn = raw as JsonObject;
                return (
                <li key={str(cn.creditNoteId) || i} className="flex flex-wrap gap-x-3">
                  <span className="font-mono">{str(cn.noCN) || str(cn.creditNoteId)}</span>
                  {str(cn.noReturn) ? <span>RTV {str(cn.noReturn)}</span> : null}
                  {str(cn.source) === 'inventory_return'
                    ? <span className="text-orange-700">Retur Inventory</span>
                    : <span className="text-slate-500">Manual / webhook</span>}
                </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-4 mt-4 border-t no-print justify-end">
          {approval !== 'REJECTED' && str(detail.id) && (
            <Button asChild variant="outline">
              <Link href={`/retur-vendor?hutangId=${encodeURIComponent(str(detail.id))}`}>
                <Undo2 className="w-4 h-4 mr-1" /> Buat Retur
              </Link>
            </Button>
          )}
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
          {approval === 'APPROVED' && onMarkPaid && (
            <Button
              variant="outline"
              onClick={onMarkPaid}
              disabled={markingPaid}
              className="border-green-600 text-green-700 hover:bg-green-50"
            >
              <Check className="w-4 h-4 mr-1" />
              {markingPaid ? '...' : 'Tandai Lunas (bayar diluar sistem)'}
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
